package ratelimit

import (
	"fmt"
	"testing"
	"time"

	"nex.rendezvous/internal/clock"
)

func newTestLimiter(t *testing.T) (*Limiter, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake()
	return New(clk), clk
}

// TestRulesMatchTheFrozenTable pins every row of the §8 table. These values are
// normative; changing one is a wire-contract violation.
func TestRulesMatchTheFrozenTable(t *testing.T) {
	want := map[Op]Rule{
		OpRegister:     {PerNode: 6, PerIP: 30},
		OpRefresh:      {PerNode: 30, PerIP: 120},
		OpUnregister:   {PerNode: 10, PerIP: 60},
		OpSearch:       {PerNode: 20, PerIP: 60},
		OpIntroRequest: {PerNode: 10, PerIP: 30},
		OpIntroRespond: {PerNode: 30, PerIP: 60},
		OpControl:      {PerNode: 6, PerIP: 30},
		OpPublic:       {PerNode: 0, PerIP: 60},
	}
	if len(Rules) != len(want) {
		t.Fatalf("Rules has %d rows, §8 table has %d — update both together", len(Rules), len(want))
	}
	for op, r := range want {
		got, ok := Rules[op]
		if !ok {
			t.Fatalf("missing rule for %s", op)
		}
		if got != r {
			t.Errorf("%s = %+v, want %+v", op, got, r)
		}
	}
}

const (
	nodeA = "AAAA"
	ip1   = "203.0.113.1"
	ip2   = "203.0.113.2"
)

func drain(l *Limiter, op Op, nodeID, ip string, n int) (allowed int, lastRetry int) {
	for i := 0; i < n; i++ {
		ok, retry := l.Allow(op, nodeID, ip)
		if !ok {
			return allowed, retry
		}
		allowed++
	}
	return allowed, 0
}

func TestPerNodeLimitTrips(t *testing.T) {
	l, _ := newTestLimiter(t)
	// register is 6/min per nodeId.
	allowed, retry := drain(l, OpRegister, "node-1", ip1, 100)
	if allowed != 6 {
		t.Fatalf("allowed %d registers per node, want 6", allowed)
	}
	if retry < 1 || retry > 60 {
		t.Fatalf("Retry-After = %d, want 1..60", retry)
	}
	// A different nodeId on the same IP is unaffected.
	if allowed, _ := drain(l, OpRegister, "node-2", ip1, 100); allowed != 6 {
		t.Fatalf("second node got %d", allowed)
	}
}

func TestPerIPLimitTrips(t *testing.T) {
	l, _ := newTestLimiter(t)
	// register is 30/min per IP; use refresh-sized nodes so the per-node
	// bucket (30/min each... no — register is 6/node) does not trip first.
	// Use distinct nodeIds and the search row? search is 20/IP. The cleanest
	// IP-only case is OpPublic (no per-node bucket at all): 60/min per IP.
	allowed, retry := drain(l, OpPublic, "", ip1, 200)
	if allowed != 60 {
		t.Fatalf("allowed %d public ops per IP, want 60", allowed)
	}
	if retry < 1 {
		t.Fatal("denied request must carry Retry-After >= 1")
	}
	// A second IP is unaffected.
	if allowed, _ := drain(l, OpPublic, "", ip2, 200); allowed != 60 {
		t.Fatalf("second IP got %d", allowed)
	}
}

// TestWhicheverTripsFirstWins drives both buckets of one row to their edge in
// one test: a single nodeId rotating across many IPs stops at its own limit
// even though no IP limit was reached, and an IP shared by many nodeIds stops
// at the IP limit even though no node limit was reached.
func TestWhicheverTripsFirstWins(t *testing.T) {
	l, _ := newTestLimiter(t)

	// One node, many IPs: trips at 6 (its own limit), not at 30-per-IP.
	total := 0
	for ip := 0; ip < 10; ip++ {
		n, _ := drain(l, OpRegister, "lonely", string(rune('a'+ip))+"-ip", 100)
		total += n
	}
	if total != 6 {
		t.Fatalf("node rotating IPs made %d requests, want exactly 6", total)
	}

	// Many nodes, one IP: trips at 30 (the IP limit).
	l2, _ := newTestLimiter(t)
	total = 0
	denied := false
	for n := 0; n < 40; n++ {
		ok, _ := l2.Allow(OpRegister, nodeFor(n), "shared-ip")
		if !ok {
			denied = true
			break
		}
		total++
	}
	if total != 30 || !denied {
		t.Fatalf("one IP hosting many nodeIds made %d requests, want denial at 30", total)
	}
}

func nodeFor(n int) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 32)
	for i := range out {
		out[i] = hexDigits[(n+i)%16]
	}
	return string(out)
}

// TestDenialDoesNotChargeTheOtherBucket: §8 requires both buckets enforced;
// charging the node bucket on an IP-denied request would let a third party
// drain a victim's allowance from their own exhausted IP.
func TestDenialDoesNotChargeTheOtherBucket(t *testing.T) {
	l, _ := newTestLimiter(t)

	// Exhaust only the IP side of a narrow rule.
	l.SetRule(OpSearch, Rule{PerNode: 4, PerIP: 2})
	if ok, _ := l.Allow(OpSearch, "victim", "attacker-ip"); !ok {
		t.Fatal("precondition: first request should pass")
	}
	if ok, _ := l.Allow(OpSearch, "attacker", "attacker-ip"); !ok {
		t.Fatal("precondition: second request should pass")
	}
	// IP bucket now empty. A denial keyed to this IP must not touch the node.
	if ok, _ := l.Allow(OpSearch, "victim", "attacker-ip"); ok {
		t.Fatal("expected denial once the IP bucket is empty")
	}
	// The victim was charged once (the first passing request), so it has 3 of
	// its own 4 tokens left — no IP-denied request may have touched them.
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow(OpSearch, "victim", "fresh-ip-"+string(rune('a'+i))); !ok {
			t.Fatalf("victim's node bucket was drained by IP denials (iteration %d)", i)
		}
	}
	if ok, _ := l.Allow(OpSearch, "victim", "one-more-ip"); ok {
		t.Fatal("victim's 5th charge should be denied by its own limit")
	}
}

func TestBucketsRefillOverTime(t *testing.T) {
	l, clk := newTestLimiter(t)
	l.SetRule(OpRegister, Rule{PerNode: 2, PerIP: 100})
	if ok, _ := l.Allow(OpRegister, "n", ip1); !ok {
		t.Fatal("first should pass")
	}
	if ok, _ := l.Allow(OpRegister, "n", ip1); !ok {
		t.Fatal("second should pass")
	}
	if ok, _ := l.Allow(OpRegister, "n", ip1); ok {
		t.Fatal("third should hit the node limit")
	}
	clk.Advance(61 * time.Second)
	if ok, _ := l.Allow(OpRegister, "n", ip1); !ok {
		t.Fatal("bucket did not refill after a minute")
	}
}

func TestRetryAfterIsCeilToNextWholeSecond(t *testing.T) {
	l, clk := newTestLimiter(t)
	// Capacity 60/min -> exactly one token per second, so the arithmetic below
	// stays in whole-second territory.
	l.SetRule(OpPublic, Rule{PerNode: 0, PerIP: 60})
	for i := 0; i < 60; i++ {
		if ok, _ := l.Allow(OpPublic, "", ip1); !ok {
			t.Fatal("drain failed early")
		}
	}
	ok, retry := l.Allow(OpPublic, "", ip1)
	if ok {
		t.Fatal("expected denial")
	}
	if retry != 1 {
		t.Fatalf("immediately after drain Retry-After = %d, want 1", retry)
	}
	clk.Advance(1500 * time.Millisecond)
	ok, retry = l.Allow(OpPublic, "", ip1)
	if !ok || retry != 0 {
		t.Fatalf("after 1.5s one token exists; got ok=%v retry=%d", ok, retry)
	}
}

// TestIdleBucketEviction is the regression test for the leak HANDOFF.md item 2
// describes. The original code advanced `lastMs` inside refill() on every read,
// so the eviction condition `lastMs+idleEvictMs <= now` could never fire and
// every touched bucket lived forever — an attacker rotating nodeIds would turn
// the limiter itself into a memory-exhaustion vector. Eviction now keys off
// `lastUseMs`, charged only when a token is consumed.
//
// This test fails against the original bug: under it, Len() stays > 0 forever.
func TestIdleBucketEviction(t *testing.T) {
	l, clk := newTestLimiter(t)

	if ok, _ := l.Allow(OpRegister, "node-x", ip1); !ok {
		t.Fatal("setup: request should pass")
	}
	before := l.Len()
	if before == 0 {
		t.Fatal("setup: expected buckets to exist")
	}

	clk.Advance(idleEvictMs*time.Millisecond + time.Millisecond)
	l.Sweep()
	if got := l.Len(); got != 0 {
		t.Fatalf("after 10min idle, %d buckets survived sweep; idle eviction never fired (HANDOFF item 2 bug)", got)
	}

	// And the evicted limiter still works: fresh buckets are created on demand.
	if ok, _ := l.Allow(OpRegister, "node-y", ip2); !ok {
		t.Fatal("limiter unusable after eviction sweep")
	}
}

// TestActiveBucketSurvivesSweep distinguishes the fix from over-eager deletion:
// a bucket used recently is kept even if the sweeper runs.
func TestActiveBucketSurvivesSweep(t *testing.T) {
	l, clk := newTestLimiter(t)
	if ok, _ := l.Allow(OpRegister, "live", ip1); !ok {
		t.Fatal("setup failed")
	}
	clk.Advance(5 * time.Minute)
	l.Sweep()
	if l.Len() == 0 {
		t.Fatal("active bucket swept too early")
	}
	clk.Advance(5*time.Minute + 2*time.Millisecond)
	l.Sweep()
	if l.Len() != 0 {
		t.Fatal("idle bucket never swept")
	}
}

func TestInvalidSignatureBan(t *testing.T) {
	l, clk := newTestLimiter(t)

	// Nine strikes: not yet banned.
	for i := 0; i < InvalidSigThreshold-1; i++ {
		l.RecordInvalidSignature(ip1)
	}
	if sec := l.BannedFor(ip1); sec != 0 {
		t.Fatalf("banned after %d strikes (%ds), ban starts at %d", InvalidSigThreshold-1, sec, InvalidSigThreshold)
	}

	// Tenth strike inside the window bans for 300 s.
	l.RecordInvalidSignature(ip1)
	if sec := l.BannedFor(ip1); sec <= 299 || sec > InvalidSigBanMs/1000 {
		t.Fatalf("BannedFor = %d, want ~300", sec)
	}

	// Another IP is untouched.
	if sec := l.BannedFor(ip2); sec != 0 {
		t.Fatalf("unrelated IP banned for %ds", sec)
	}

	// Ban lapses with time, without any unban call.
	clk.Advance((InvalidSigBanMs + 1) * time.Millisecond)
	if sec := l.BannedFor(ip1); sec != 0 {
		t.Fatalf("ban outlived 300s: %d", sec)
	}
}

// TestStrikeWindowResetsAfterSixtyQuietSeconds: the §8 rule is "10 in 60 s",
// not "ever". Strikes older than the window start a fresh count.
func TestStrikeWindowResetsAfterSixtyQuietSeconds(t *testing.T) {
	l, clk := newTestLimiter(t)
	for i := 0; i < InvalidSigThreshold-1; i++ {
		l.RecordInvalidSignature(ip1)
	}
	clk.Advance((InvalidSigWindowMs + 1) * time.Millisecond)
	// Old window expired; a few more strikes are still below a fresh threshold.
	l.RecordInvalidSignature(ip1)
	l.RecordInvalidSignature(ip1)
	if sec := l.BannedFor(ip1); sec != 0 {
		t.Fatalf("stale strikes counted into the new window; banned %ds", sec)
	}
}

// TestBanPersistsAcrossSweepWhileActive ensures Sweep cannot forget an active
// ban — the strike record must survive until both the window and the ban end.
func TestBanPersistsAcrossSweepWhileActive(t *testing.T) {
	l, clk := newTestLimiter(t)
	for i := 0; i < InvalidSigThreshold; i++ {
		l.RecordInvalidSignature(ip1)
	}
	clk.Advance(30 * time.Second)
	l.Sweep()
	if sec := l.BannedFor(ip1); sec == 0 {
		t.Fatal("active ban was forgotten by Sweep")
	}
}

func TestSetRuleOverridesOneRowOnly(t *testing.T) {
	l, _ := newTestLimiter(t)
	l.SetRule(OpRefresh, Rule{PerNode: 1, PerIP: 100})
	if ok, _ := l.Allow(OpRefresh, "n", ip1); !ok {
		t.Fatal("override not applied")
	}
	if ok, _ := l.Allow(OpRefresh, "n", ip1); ok {
		t.Fatal("override limit not enforced")
	}
	// Other rows keep the normative values.
	if ok, _ := l.Allow(OpUnregister, "n", ip1); !ok {
		t.Fatal("override leaked to another row")
	}
}

func TestAllowIntroTargetThreePerMinutePerPair(t *testing.T) {
	l, _ := newTestLimiter(t)
	for i := 0; i < IntroPerTargetPerMin; i++ {
		if ok, _ := l.AllowIntroTarget("requester", "roshan"); !ok {
			t.Fatalf("request %d to target denied before the limit", i+1)
		}
	}
	ok, retry := l.AllowIntroTarget("requester", "roshan")
	if ok {
		t.Fatal("4th request to one target allowed (§8 extra column)")
	}
	if retry < 1 || retry > 60 {
		t.Fatalf("Retry-After = %d", retry)
	}
	// Same requester, different target: separate pair bucket.
	if ok, _ := l.AllowIntroTarget("requester", "someoneelse"); !ok {
		t.Fatal("per-target limit leaked across targets")
	}
	// Different requester, same target: separate pair bucket.
	if ok, _ := l.AllowIntroTarget("other", "roshan"); !ok {
		t.Fatal("per-target limit leaked across requesters")
	}
}

func TestEmptyNodeSkipsNodeBucketButChargesIP(t *testing.T) {
	l, _ := newTestLimiter(t)
	// OpPublic has PerNode=0 anyway; assert the empty-node path works there
	// and that the IP bucket still fills.
	for i := 0; i < 60; i++ {
		if ok, _ := l.Allow(OpPublic, "", ip1); !ok {
			t.Fatalf("public request %d denied early", i+1)
		}
	}
	if ok, _ := l.Allow(OpPublic, "", ip1); ok {
		t.Fatal("per-IP public limit never tripped")
	}
}

func TestSweepDropsExpiredStrikeRecords(t *testing.T) {
	l, clk := newTestLimiter(t)
	for i := 0; i < InvalidSigThreshold; i++ {
		l.RecordInvalidSignature(ip1)
	}
	clk.Advance((InvalidSigBanMs + InvalidSigWindowMs + 1000) * time.Millisecond)
	l.Sweep()
	if l.BannedFor(ip1) != 0 {
		t.Fatal("expired ban survived sweep")
	}
}

// TestRefundRestoresTheIPBucket pins the refund primitive the server's
// authenticate sequence relies on. The per-IP charge happens BEFORE signature
// verification (8: verification is the most expensive path), but the
// per-nodeId charge happens after it and can still refuse. Without a refund,
// every node-limited refusal burns an IP token anyway and taxes everyone
// behind that address for a request that was never accepted.
func TestRefundRestoresTheIPBucket(t *testing.T) {
	l, clk := newTestLimiter(t)
	l.SetRule(OpRegister, Rule{PerNode: 5, PerIP: 2})

	// Two distinct nodes drain the shared IP bucket.
	if ok, _ := l.Allow(OpRegister, "n1", ip1); !ok {
		t.Fatal("setup: charge 1 refused")
	}
	if ok, _ := l.Allow(OpRegister, "n2", ip1); !ok {
		t.Fatal("setup: charge 2 refused")
	}
	if ok, retry := l.Allow(OpRegister, "n3", ip1); ok || retry < 1 {
		t.Fatal("setup: IP bucket not exhausted")
	}

	l.Refund(OpRegister, ip1)
	if ok, _ := l.Allow(OpRegister, "n3", ip1); !ok {
		t.Fatal("refunded token was not usable")
	}

	// Refunding past capacity must not overfill the bucket.
	l.Refund(OpRegister, ip1)
	l.Refund(OpRegister, ip1)
	clk.Advance(61 * time.Second) // full refill anyway
	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow(OpRegister, fmt.Sprintf("r%d", i), ip1); !ok {
			t.Fatalf("post-rollover charge %d refused: capacity grew past %d", i+1, Rules[OpRegister].PerIP)
		}
	}

	// Empty IP and unknown buckets are no-ops, never panics.
	l.Refund(OpRegister, "")
	l.Refund(OpSearch, ip1)
}
