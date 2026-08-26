// Package store is the entire persistence layer of the rendezvous service:
// process memory, and nothing else.
//
// Contract §9 is not a performance note, it is the design. No database in v1.
// No disk persistence of presence, introductions, searches or IPs. Service
// restart is a supported, routine event — every lease lapses and every node
// re-registers on its next refresh tick, which is what proves the system
// genuinely depends on leases rather than on the service's memory (V3 §6).
package store

import (
	"crypto/rand"
	"encoding/hex"
	"sync"

	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/descriptor"
)

// Global caps from contract §8. At capacity the service refuses new work rather
// than evicting live users.
const (
	MaxLeases               = 100000
	MaxPendingIntroductions = 10000
	MaxNonces               = 200000
)

// Lease is one node's ephemeral presence record (V3 §23).
//
// It is a short lease, not a session. Crash, sleep and power loss must all lead
// to the same outcome: the lease lapses and the node stops being discoverable.
type Lease struct {
	ID        string
	Handle    string
	NodeID    string
	SignPub   string
	Public    *descriptor.Public
	Contact   *descriptor.Contact
	CreatedAt int64
	ExpiresAt int64
}

// Expired reports whether the lease has lapsed at nowMs.
func (l *Lease) Expired(nowMs int64) bool { return nowMs >= l.ExpiresAt }

// Introduction is one pending introduction (§5.5). It holds the requester's own
// contact descriptor — offered as deliberate consent — and never the target's.
type Introduction struct {
	RequestID    string
	TargetHandle string
	TargetNodeID string
	FromHandle   string
	FromNodeID   string
	FromContact  *descriptor.Contact
	ExpiresAt    int64
}

// Expired reports whether the introduction has lapsed at nowMs.
func (i *Introduction) Expired(nowMs int64) bool { return nowMs >= i.ExpiresAt }

// Store holds every piece of live state. Everything in it is bounded and
// everything in it expires.
type Store struct {
	clk clock.Clock

	mu sync.Mutex

	leasesByID     map[string]*Lease
	leasesByHandle map[string]*Lease
	leasesByNode   map[string]*Lease

	introductions map[string]*Introduction

	// nonces is the §4 replay window. Entries all share one TTL, so insertion
	// order is expiry order and a FIFO is enough to drop the oldest under
	// pressure. A dropped nonce degrades replay protection to the ±120 s clock
	// window: an accepted, documented bound, not a silent failure.
	nonces      map[string]int64
	nonceFIFO   []string
	nonceTTLMs  int64
	maxNonces   int
	maxLeases   int
	maxPendIntr int
}

// Options configures the caps. Zero values fall back to the contract defaults.
type Options struct {
	NonceTTLMs              int64
	MaxNonces               int
	MaxLeases               int
	MaxPendingIntroductions int
}

// New builds an empty store.
func New(clk clock.Clock, opts Options) *Store {
	if opts.NonceTTLMs <= 0 {
		opts.NonceTTLMs = 300000
	}
	if opts.MaxNonces <= 0 {
		opts.MaxNonces = MaxNonces
	}
	if opts.MaxLeases <= 0 {
		opts.MaxLeases = MaxLeases
	}
	if opts.MaxPendingIntroductions <= 0 {
		opts.MaxPendingIntroductions = MaxPendingIntroductions
	}
	return &Store{
		clk:            clk,
		leasesByID:     make(map[string]*Lease),
		leasesByHandle: make(map[string]*Lease),
		leasesByNode:   make(map[string]*Lease),
		introductions:  make(map[string]*Introduction),
		nonces:         make(map[string]int64),
		nonceTTLMs:     opts.NonceTTLMs,
		maxNonces:      opts.MaxNonces,
		maxLeases:      opts.MaxLeases,
		maxPendIntr:    opts.MaxPendingIntroductions,
	}
}

// Sentinel results from RegisterLease.
type RegisterResult int

const (
	// RegisterOK means the lease was created or replaced.
	RegisterOK RegisterResult = iota
	// RegisterHandleTaken means a different, still-live nodeId holds the handle.
	RegisterHandleTaken
	// RegisterAtCapacity means the global lease cap is reached (§8).
	RegisterAtCapacity
)

// RegisterLease creates or replaces the caller's lease.
//
// Handles are first-come and held for the lease: a different nodeId registering
// a live handle is rejected. When the lease lapses the handle is free again.
// Rendezvous does not own a permanent namespace and does not arbitrate
// ownership disputes (§2).
//
// A nodeId holds at most one lease. Registering again replaces it and releases
// the handle the node held before, which is what makes a client restart under a
// new handle work without waiting out the old lease.
func (s *Store) RegisterLease(l *Lease) (*Lease, RegisterResult) {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)

	if held, ok := s.leasesByHandle[l.Handle]; ok && !held.Expired(now) && held.NodeID != l.NodeID {
		return nil, RegisterHandleTaken
	}

	prev, hadPrev := s.leasesByNode[l.NodeID]
	if !hadPrev && len(s.leasesByID) >= s.maxLeases {
		return nil, RegisterAtCapacity
	}
	if hadPrev {
		s.removeLeaseLocked(prev)
	}

	l.ID = newOpaqueID()
	l.CreatedAt = now
	s.leasesByID[l.ID] = l
	s.leasesByHandle[l.Handle] = l
	s.leasesByNode[l.NodeID] = l
	return l, RegisterOK
}

// LeaseByID returns a live lease, or nil if it is unknown or lapsed.
//
// Expiry is decided here on every read, not by the sweeper. The sweeper only
// reclaims memory; correctness must not depend on it having run (V3 §6).
func (s *Store) LeaseByID(id string) *Lease {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leasesByID[id]
	if !ok || l.Expired(now) {
		return nil
	}
	return l
}

// LeaseByHandle returns the live lease holding a handle, or nil.
func (s *Store) LeaseByHandle(h string) *Lease {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leasesByHandle[h]
	if !ok || l.Expired(now) {
		return nil
	}
	return l
}

// LeaseByNode returns the live lease held by a nodeId, or nil.
func (s *Store) LeaseByNode(nodeID string) *Lease {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leasesByNode[nodeID]
	if !ok || l.Expired(now) {
		return nil
	}
	return l
}

// RefreshLease extends a live lease, optionally swapping in replacement
// descriptors for a node whose address changed (§5.2). It returns nil if the
// lease is unknown, lapsed, or not held by this nodeId.
func (s *Store) RefreshLease(id, nodeID string, expiresAt int64, pub *descriptor.Public, contact *descriptor.Contact) *Lease {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leasesByID[id]
	if !ok || l.Expired(now) || l.NodeID != nodeID {
		return nil
	}
	if pub != nil {
		l.Public = pub
	}
	if contact != nil {
		l.Contact = contact
	}
	l.ExpiresAt = expiresAt
	return l
}

// DeleteLease removes a lease held by nodeID. It is idempotent: deleting an
// already-lapsed lease is success, not an error (§5.3). Unregister is a
// courtesy, never a correctness requirement.
func (s *Store) DeleteLease(id, nodeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leasesByID[id]
	if !ok || l.NodeID != nodeID {
		return
	}
	s.removeLeaseLocked(l)
}

// removeLeaseLocked unlinks a lease from all three indexes.
func (s *Store) removeLeaseLocked(l *Lease) {
	delete(s.leasesByID, l.ID)
	if cur, ok := s.leasesByHandle[l.Handle]; ok && cur == l {
		delete(s.leasesByHandle, l.Handle)
	}
	if cur, ok := s.leasesByNode[l.NodeID]; ok && cur == l {
		delete(s.leasesByNode, l.NodeID)
	}
}

// Sentinel results from PutIntroduction.
type IntroResult int

const (
	// IntroOK means the introduction was stored.
	IntroOK IntroResult = iota
	// IntroDuplicate means that requestId is already pending.
	IntroDuplicate
	// IntroAtCapacity means the global pending-introduction cap is reached (§8).
	IntroAtCapacity
)

// PutIntroduction stores a pending introduction.
func (s *Store) PutIntroduction(i *Introduction) IntroResult {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepLocked(now)

	if existing, ok := s.introductions[i.RequestID]; ok && !existing.Expired(now) {
		return IntroDuplicate
	}
	if len(s.introductions) >= s.maxPendIntr {
		return IntroAtCapacity
	}
	s.introductions[i.RequestID] = i
	return IntroOK
}

// TakeIntroduction removes and returns a pending introduction, or nil if it is
// unknown or lapsed.
//
// Responding consumes the introduction, so an accept and a reject cannot both
// be delivered for one request.
func (s *Store) TakeIntroduction(requestID string) *Introduction {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.introductions[requestID]
	if !ok {
		return nil
	}
	delete(s.introductions, requestID)
	if i.Expired(now) {
		return nil
	}
	return i
}

// PeekIntroduction returns a pending introduction without consuming it. Used by
// tests and by expiry accounting only.
func (s *Store) PeekIntroduction(requestID string) *Introduction {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	i, ok := s.introductions[requestID]
	if !ok || i.Expired(now) {
		return nil
	}
	return i
}

// CheckAndUseNonce records a nonce and reports whether it was fresh.
//
// The key includes the nodeId so one node cannot burn another node's nonce
// space by pre-claiming values it guessed.
func (s *Store) CheckAndUseNonce(nodeID, nonce string) bool {
	now := s.clk.NowMs()
	key := nodeID + ":" + nonce
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweepNoncesLocked(now)

	if exp, ok := s.nonces[key]; ok && exp > now {
		return false
	}
	s.nonces[key] = now + s.nonceTTLMs
	s.nonceFIFO = append(s.nonceFIFO, key)

	// Bounded structure: drop the oldest under pressure (§4).
	for len(s.nonceFIFO) > s.maxNonces {
		oldest := s.nonceFIFO[0]
		s.nonceFIFO = s.nonceFIFO[1:]
		delete(s.nonces, oldest)
	}
	return true
}

// Counts reports the live lease count and the pending introduction count.
func (s *Store) Counts() (leases, introductions int) {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.leasesByID {
		if !l.Expired(now) {
			leases++
		}
	}
	for _, i := range s.introductions {
		if !i.Expired(now) {
			introductions++
		}
	}
	return leases, introductions
}

// Sweep drops everything that has lapsed and returns the IDs of leases that
// were removed, so the caller can close their control channels.
//
// The sweeper exists to reclaim memory. Expiry alone is already sufficient for
// correctness: every read path checks expiry itself, so a service whose sweeper
// never ran would still stop serving a lapsed node.
func (s *Store) Sweep() []string {
	now := s.clk.NowMs()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sweepLocked(now)
}

func (s *Store) sweepLocked(now int64) []string {
	var dropped []string
	for id, l := range s.leasesByID {
		if l.Expired(now) {
			dropped = append(dropped, id)
			s.removeLeaseLocked(l)
		}
	}
	for id, i := range s.introductions {
		if i.Expired(now) {
			delete(s.introductions, id)
		}
	}
	s.sweepNoncesLocked(now)
	return dropped
}

func (s *Store) sweepNoncesLocked(now int64) {
	// The FIFO is in expiry order, so stop at the first live entry.
	cut := 0
	for cut < len(s.nonceFIFO) {
		key := s.nonceFIFO[cut]
		exp, ok := s.nonces[key]
		if ok && exp > now {
			break
		}
		delete(s.nonces, key)
		cut++
	}
	if cut > 0 {
		s.nonceFIFO = append(s.nonceFIFO[:0], s.nonceFIFO[cut:]...)
	}
}

// newOpaqueID returns the leaseId: 16 random bytes as lowercase hex. It is
// opaque, unguessable, and the only server-issued secret in the protocol (§4).
func newOpaqueID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is not something to paper over with a weaker
		// source; the process cannot safely issue lease IDs any more.
		panic("rendezvous: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(b[:])
}

// Bucket applies the §5.8 rule for public metrics: a raw count below 20 is
// reported as 0; at or above 20 it is reported rounded down to the nearest
// multiple of 5.
//
// On a small network an exact count is a deanonymization aid ("it says 2, and I
// am one of them"), so the small-network case reports nothing rather than
// something precise.
func Bucket(n int) int {
	if n < 20 {
		return 0
	}
	return (n / 5) * 5
}
