// Package ratelimit implements the normative rate-limit table of
// RENDEZVOUS_WIRE_V1 §8.
//
// Discovery creates an enumeration surface (V3 §26). Every limit below is
// enforced twice — once per nodeId and once per source IP — because either one
// alone is trivially sidestepped: a single node can rotate IPs, and a single IP
// can rotate nodeIds. Whichever bucket trips first wins.
package ratelimit

import (
	"math"
	"sync"

	"nex.rendezvous/internal/clock"
)

// Op names the rate-limited operations of §8.
type Op string

const (
	OpRegister     Op = "register"
	OpRefresh      Op = "refresh"
	OpUnregister   Op = "unregister"
	OpSearch       Op = "search"
	OpIntroRequest Op = "introduction/request"
	OpIntroRespond Op = "introduction/respond"
	OpControl      Op = "control"
	OpPublic       Op = "public" // status, metrics
)

// Rule is one row of the §8 table. A zero PerNode means the row has no
// per-nodeId limit (status and metrics are unauthenticated).
type Rule struct {
	PerNode int
	PerIP   int
}

// Rules is the §8 table, verbatim. Values are per minute.
var Rules = map[Op]Rule{
	OpRegister:     {PerNode: 6, PerIP: 30},
	OpRefresh:      {PerNode: 30, PerIP: 120},
	OpUnregister:   {PerNode: 10, PerIP: 60},
	OpSearch:       {PerNode: 20, PerIP: 60},
	OpIntroRequest: {PerNode: 10, PerIP: 30},
	OpIntroRespond: {PerNode: 30, PerIP: 60},
	OpControl:      {PerNode: 6, PerIP: 30},
	OpPublic:       {PerNode: 0, PerIP: 60},
}

// IntroPerTargetPerMin is the §8 "extra" column for introduction/request:
// 3 per minute per (nodeId -> targetHandle) pair. It is what stops one node
// from hammering one person while staying inside its overall 10/min.
const IntroPerTargetPerMin = 3

// Invalid-signature ban parameters (§8). Signature verification is the most
// expensive path in the service and is therefore the cheapest thing to attack.
const (
	InvalidSigThreshold = 10
	InvalidSigWindowMs  = 60000
	InvalidSigBanMs     = 300000
)

// windowMs is the refill period every §8 limit is expressed over.
const windowMs = 60000

// idleEvictMs is how long a full, untouched bucket is kept before the sweeper
// reclaims it. Buckets must be bounded: an attacker rotating nodeIds would
// otherwise turn the limiter itself into the memory-exhaustion vector.
const idleEvictMs = 10 * 60000

type bucket struct {
	tokens   float64
	capacity float64
	// ratePerMs is capacity / windowMs.
	ratePerMs float64
	// lastMs is the refill watermark; it advances on every read.
	lastMs int64
	// lastUseMs is when a token was last actually charged. Eviction keys off
	// this, not off lastMs: refill moves lastMs forward on every touch, so a
	// bucket would otherwise never look idle.
	lastUseMs int64
}

func newBucket(perMinute int, nowMs int64) *bucket {
	c := float64(perMinute)
	return &bucket{tokens: c, capacity: c, ratePerMs: c / float64(windowMs), lastMs: nowMs, lastUseMs: nowMs}
}

func (b *bucket) refill(nowMs int64) {
	if nowMs <= b.lastMs {
		return
	}
	b.tokens = math.Min(b.capacity, b.tokens+float64(nowMs-b.lastMs)*b.ratePerMs)
	b.lastMs = nowMs
}

// retryAfterSec is the whole number of seconds until one token is available.
func (b *bucket) retryAfterSec() int {
	if b.tokens >= 1 {
		return 0
	}
	need := (1 - b.tokens) / b.ratePerMs // milliseconds
	return int(math.Ceil(need / 1000))
}

type ipStrikes struct {
	count       int
	windowEndMs int64
	bannedUntil int64
}

// Limiter holds every token bucket and the invalid-signature ban list.
type Limiter struct {
	clk clock.Clock

	mu      sync.Mutex
	buckets map[string]*bucket
	strikes map[string]*ipStrikes

	// overrides lets tests and config replace the §8 table wholesale. Nil means
	// the normative table.
	overrides map[Op]Rule
}

// New builds a limiter over the given clock.
func New(clk clock.Clock) *Limiter {
	return &Limiter{
		clk:     clk,
		buckets: make(map[string]*bucket),
		strikes: make(map[string]*ipStrikes),
	}
}

// SetRule overrides one row. Used by tests to drive a limit to its edge without
// issuing dozens of real requests, and by operators who need a tighter cap.
func (l *Limiter) SetRule(op Op, r Rule) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.overrides == nil {
		l.overrides = make(map[Op]Rule)
	}
	l.overrides[op] = r
}

func (l *Limiter) ruleLocked(op Op) Rule {
	if l.overrides != nil {
		if r, ok := l.overrides[op]; ok {
			return r
		}
	}
	return Rules[op]
}

// Allow charges one token to the per-nodeId and per-IP buckets for op.
//
// Both are checked before either is charged, so a request denied by the IP
// bucket does not silently burn the node's allowance (and vice versa). An empty
// nodeID skips the per-node bucket, which is how the unauthenticated public
// endpoints are handled.
func (l *Limiter) Allow(op Op, nodeID, ip string) (bool, int) {
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()

	r := l.ruleLocked(op)
	var nodeB, ipB *bucket
	if r.PerNode > 0 && nodeID != "" {
		nodeB = l.bucketLocked("n|"+string(op)+"|"+nodeID, r.PerNode, now)
	}
	if r.PerIP > 0 && ip != "" {
		ipB = l.bucketLocked("i|"+string(op)+"|"+ip, r.PerIP, now)
	}

	retry := 0
	denied := false
	for _, b := range []*bucket{nodeB, ipB} {
		if b == nil {
			continue
		}
		if b.tokens < 1 {
			denied = true
			if s := b.retryAfterSec(); s > retry {
				retry = s
			}
		}
	}
	if denied {
		if retry < 1 {
			retry = 1
		}
		return false, retry
	}
	for _, b := range []*bucket{nodeB, ipB} {
		if b != nil {
			b.tokens--
			b.lastUseMs = now
		}
	}
	return true, 0
}

// AllowIntroTarget charges the §8 extra bucket: 3 per minute per
// (nodeId -> targetHandle).
func (l *Limiter) AllowIntroTarget(nodeID, targetHandle string) (bool, int) {
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()

	limit := IntroPerTargetPerMin
	if l.overrides != nil {
		if r, ok := l.overrides[OpIntroRequest]; ok && r.PerNode > 0 && r.PerNode < limit {
			limit = r.PerNode
		}
	}
	b := l.bucketLocked("t|"+nodeID+"|"+targetHandle, limit, now)
	if b.tokens < 1 {
		s := b.retryAfterSec()
		if s < 1 {
			s = 1
		}
		return false, s
	}
	b.tokens--
	b.lastUseMs = now
	return true, 0
}

// Refund returns one token to the per-IP bucket for op, clamped to capacity.
//
// It exists for the server's authenticate sequence: the per-IP charge must
// happen before signature verification (§8 — verification is the most
// expensive path), but the per-nodeId charge happens after it and can still
// refuse. Without the refund, every node-limited refusal would silently tax
// the shared IP budget — collateral denial for everyone behind that address.
// A missing bucket was never charged; do nothing.
func (l *Limiter) Refund(op Op, ip string) {
	if ip == "" {
		return
	}
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()
	r := l.ruleLocked(op)
	if r.PerIP <= 0 {
		return
	}
	b, ok := l.buckets["i|"+string(op)+"|"+ip]
	if !ok {
		return
	}
	b.refill(now)
	if b.tokens < b.capacity {
		b.tokens++
	}
}

func (l *Limiter) bucketLocked(key string, perMinute int, now int64) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		b = newBucket(perMinute, now)
		l.buckets[key] = b
		return b
	}
	// A changed limit (test override, config reload) resizes in place.
	if b.capacity != float64(perMinute) {
		b.capacity = float64(perMinute)
		b.ratePerMs = b.capacity / float64(windowMs)
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
	}
	b.refill(now)
	return b
}

// RecordInvalidSignature counts one invalid signature against an IP and bans it
// once §8's threshold is crossed.
func (l *Limiter) RecordInvalidSignature(ip string) {
	if ip == "" {
		return
	}
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()

	s, ok := l.strikes[ip]
	if !ok || now >= s.windowEndMs {
		s = &ipStrikes{windowEndMs: now + InvalidSigWindowMs}
		l.strikes[ip] = s
	}
	s.count++
	if s.count >= InvalidSigThreshold {
		s.bannedUntil = now + InvalidSigBanMs
	}
}

// BannedFor reports how many seconds an IP remains refused, or 0 if it is not
// banned.
func (l *Limiter) BannedFor(ip string) int {
	if ip == "" {
		return 0
	}
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.strikes[ip]
	if !ok || s.bannedUntil <= now {
		return 0
	}
	return int(math.Ceil(float64(s.bannedUntil-now) / 1000))
}

// Sweep discards buckets that are full and untouched, and expired strike
// records. Called from the same background tick as the presence sweeper.
func (l *Limiter) Sweep() {
	now := l.clk.NowMs()
	l.mu.Lock()
	defer l.mu.Unlock()
	for k, b := range l.buckets {
		b.refill(now)
		if b.tokens >= b.capacity && b.lastUseMs+idleEvictMs <= now {
			delete(l.buckets, k)
		}
	}
	for ip, s := range l.strikes {
		if s.bannedUntil <= now && now >= s.windowEndMs {
			delete(l.strikes, ip)
		}
	}
}

// Len reports how many buckets are live. Test-facing, for bounding assertions.
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
