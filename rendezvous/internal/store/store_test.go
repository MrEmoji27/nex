package store

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/descriptor"
)

func newStore(t *testing.T, opts Options) (*Store, *clock.Fake) {
	t.Helper()
	clk := clock.NewFake()
	return New(clk, opts), clk
}

func testLease(handle, nodeID string, expiresAt int64) *Lease {
	return &Lease{
		Handle:    handle,
		NodeID:    nodeID,
		SignPub:   strings.Repeat("aa", 32),
		Public:    &descriptor.Public{Handle: handle},
		Contact:   &descriptor.Contact{Handle: handle},
		ExpiresAt: expiresAt,
	}
}

func TestRegisterCreatesLeaseWithOpaqueID(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	l, res := s.RegisterLease(testLease("zro", "NODE1", now+90000))
	if res != RegisterOK {
		t.Fatalf("result = %v", res)
	}
	if len(l.ID) != 32 {
		t.Fatalf("lease ID %q is not 32 chars of opaque hex", l.ID)
	}
	if l.CreatedAt != now {
		t.Fatalf("CreatedAt = %d, want %d", l.CreatedAt, now)
	}
	if got := s.LeaseByID(l.ID); got == nil || got.Handle != "zro" {
		t.Fatal("lease not retrievable by ID")
	}
	if got := s.LeaseByHandle("zro"); got == nil || got.NodeID != "NODE1" {
		t.Fatal("lease not retrievable by handle")
	}
	if got := s.LeaseByNode("NODE1"); got == nil {
		t.Fatal("lease not retrievable by nodeId")
	}
}

func TestLeaseIDsAreUnique(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	a, _ := s.RegisterLease(testLease("a", "N1", now+1000))
	b, _ := s.RegisterLease(testLease("b", "N2", now+1000))
	if a.ID == b.ID {
		t.Fatal("two leases shared an ID")
	}
}

func TestExpiryIsDecidedOnEveryRead(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	l, _ := s.RegisterLease(testLease("zro", "NODE1", now+50000))

	clk.Advance(49999 * time.Millisecond)
	if s.LeaseByID(l.ID) == nil {
		t.Fatal("live lease reported expired early")
	}
	// One millisecond later it is gone — and no sweeper has run.
	clk.Advance(1 * time.Millisecond)
	if s.LeaseByID(l.ID) != nil {
		t.Fatal("lapsed lease still served by ID")
	}
	if s.LeaseByHandle("zro") != nil {
		t.Fatal("lapsed lease still served by handle")
	}
	if s.LeaseByNode("NODE1") != nil {
		t.Fatal("lapsed lease still served by nodeId")
	}
}

func TestHandleTakenWhileLive(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	if _, res := s.RegisterLease(testLease("roshan", "HOLDER", now+60000)); res != RegisterOK {
		t.Fatal("setup failed")
	}
	_, res := s.RegisterLease(testLease("roshan", "OTHER", now+60000))
	if res != RegisterHandleTaken {
		t.Fatalf("result = %v, want RegisterHandleTaken", res)
	}
	// Once the holder's lease lapses, the handle is free again.
	clk.Advance(61 * time.Second)
	later := clk.NowMs()
	if _, res := s.RegisterLease(testLease("roshan", "OTHER", later+60000)); res != RegisterOK {
		t.Fatalf("handle still taken after lapse: %v", res)
	}
}

func TestSameNodeCanReRegisterUnderNewHandle(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	first, _ := s.RegisterLease(testLease("old-handle", "NODE1", now+60000))
	second, res := s.RegisterLease(testLease("new-handle", "NODE1", now+60000))
	if res != RegisterOK {
		t.Fatalf("re-register rejected: %v", res)
	}
	if s.LeaseByID(first.ID) != nil {
		t.Fatal("previous lease survived re-registration")
	}
	if s.LeaseByNode("NODE1").ID != second.ID {
		t.Fatal("node index points at the stale lease")
	}
	if s.LeaseByHandle("old-handle") != nil && s.LeaseByHandle("old-handle").ID == first.ID {
		t.Fatal("old handle still bound to the replaced lease")
	}
}

func TestRegisterAtCapacityRefusesNotEvicts(t *testing.T) {
	s, clk := newStore(t, Options{MaxLeases: 2})
	now := clk.NowMs()
	s.RegisterLease(testLease("a", "NA", now+60000))
	s.RegisterLease(testLease("b", "NB", now+60000))
	_, res := s.RegisterLease(testLease("c", "NC", now+60000))
	if res != RegisterAtCapacity {
		t.Fatalf("result = %v, want RegisterAtCapacity (§8: refuse, never evict)", res)
	}
	// Re-registration by an existing node is allowed at capacity: it replaces,
	// it does not add.
	if _, res := s.RegisterLease(testLease("b2", "NB", now+60000)); res != RegisterOK {
		t.Fatalf("existing node could not re-register at capacity: %v", res)
	}
}

func TestRefreshLeaseRules(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	l, _ := s.RegisterLease(testLease("zro", "NODE1", now+30000))

	newExp := now + 120000
	got := s.RefreshLease(l.ID, "NODE1", newExp, nil, nil)
	if got == nil || got.ExpiresAt != newExp {
		t.Fatalf("refresh by owner failed: %+v", got)
	}
	// Wrong nodeId cannot refresh someone else's lease.
	if got := s.RefreshLease(l.ID, "IMPOSTOR", newExp+1, nil, nil); got != nil {
		t.Fatal("foreign nodeId refreshed a lease")
	}
	// Unknown lease.
	if got := s.RefreshLease("nonexistent0000000000000000000000", "NODE1", newExp, nil, nil); got != nil {
		t.Fatal("unknown lease refreshed")
	}
	// Lapsed lease.
	clk.Advance(121 * time.Second)
	if got := s.RefreshLease(l.ID, "NODE1", newExp+2, nil, nil); got != nil {
		t.Fatal("lapsed lease refreshed")
	}
}

func TestRefreshSwapsDescriptors(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	l, _ := s.RegisterLease(testLease("zro", "NODE1", now+30000))

	pub := &descriptor.Public{Handle: "zro", ExpiresAt: now + 80000}
	contact := &descriptor.Contact{Handle: "zro", ExpiresAt: now + 80000}
	got := s.RefreshLease(l.ID, "NODE1", now+80000, pub, contact)
	if got.Public != pub || got.Contact != contact {
		t.Fatal("replacement descriptors were not stored")
	}
}

func TestDeleteLeaseIdempotentAndOwnerChecked(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	l, _ := s.RegisterLease(testLease("zro", "NODE1", now+60000))

	s.DeleteLease(l.ID, "WRONGNODE") // must be a no-op
	if s.LeaseByID(l.ID) == nil {
		t.Fatal("wrong-node delete removed the lease")
	}
	s.DeleteLease(l.ID, "NODE1")
	if s.LeaseByID(l.ID) != nil {
		t.Fatal("owner delete did not remove the lease")
	}
	s.DeleteLease(l.ID, "NODE1") // second delete: success, not an error
}

func TestIntroductionLifecycle(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()

	i := &Introduction{
		RequestID:    "11111111-2222-4333-8444-555555555555",
		TargetHandle: "roshan",
		TargetNodeID: "TARGET",
		FromHandle:   "zro",
		FromNodeID:   "REQUESTER",
		FromContact:  &descriptor.Contact{Handle: "zro"},
		ExpiresAt:    now + 60000,
	}
	if res := s.PutIntroduction(i); res != IntroOK {
		t.Fatalf("put = %v", res)
	}
	if res := s.PutIntroduction(i); res != IntroDuplicate {
		t.Fatalf("duplicate put = %v, want IntroDuplicate", res)
	}
	if s.PeekIntroduction(i.RequestID) == nil {
		t.Fatal("peek lost the introduction")
	}

	// Take consumes it.
	got := s.TakeIntroduction(i.RequestID)
	if got == nil || got.FromNodeID != "REQUESTER" {
		t.Fatal("take returned the wrong introduction")
	}
	if s.TakeIntroduction(i.RequestID) != nil {
		t.Fatal("introduction survived being consumed — accept and reject could both fire")
	}

	// Expired introductions read as absent.
	expired := &Introduction{RequestID: "99999999-8888-4777-8666-555555555555", ExpiresAt: now + 1000, FromContact: &descriptor.Contact{}}
	s.PutIntroduction(expired)
	clk.Advance(1001 * time.Millisecond)
	if s.PeekIntroduction(expired.RequestID) != nil {
		t.Fatal("expired introduction peeked as live")
	}
	if s.TakeIntroduction(expired.RequestID) != nil {
		t.Fatal("expired introduction taken as live")
	}
}

func TestIntroductionAtCapacity(t *testing.T) {
	s, clk := newStore(t, Options{MaxPendingIntroductions: 1})
	now := clk.NowMs()
	if res := s.PutIntroduction(&Introduction{RequestID: "r1", ExpiresAt: now + 60000}); res != IntroOK {
		t.Fatal("first put failed")
	}
	if res := s.PutIntroduction(&Introduction{RequestID: "r2", ExpiresAt: now + 60000}); res != IntroAtCapacity {
		t.Fatalf("second put = %v, want IntroAtCapacity", res)
	}
}

func TestNonceSingleUse(t *testing.T) {
	s, _ := newStore(t, Options{})
	if !s.CheckAndUseNonce("NODE1", "abcd") {
		t.Fatal("fresh nonce refused")
	}
	if s.CheckAndUseNonce("NODE1", "abcd") {
		t.Fatal("nonce reused inside the replay window")
	}
	// Same nonce under a different nodeId is a different key.
	if !s.CheckAndUseNonce("NODE2", "abcd") {
		t.Fatal("one node's claim burned another node's nonce space")
	}
}

func TestNonceWindowExpires(t *testing.T) {
	s, clk := newStore(t, Options{NonceTTLMs: 5000})
	s.CheckAndUseNonce("NODE1", "abcd")
	clk.Advance(5001 * time.Millisecond)
	if !s.CheckAndUseNonce("NODE1", "abcd") {
		t.Fatal("nonce never left the replay window")
	}
}

// TestNonceStructureBounded pins §4's bounded structure: past MaxNonces the
// oldest entry is dropped. A dropped nonce degrades to the clock window — that
// is the accepted, documented bound.
func TestNonceStructureBounded(t *testing.T) {
	const maxN = 50
	s, _ := newStore(t, Options{MaxNonces: maxN})
	for i := 0; i < maxN; i++ {
		s.CheckAndUseNonce("NODE1", fmt.Sprintf("%032x", i))
	}
	// The very first nonce should have been evicted by insertion #maxN+1.
	s.CheckAndUseNonce("OTHER", "zzzz")
	if !s.CheckAndUseNonce("NODE1", fmt.Sprintf("%032x", 0)) {
		t.Fatal("oldest nonce was not evicted; the structure grew unbounded instead")
	}
}

func TestSweepDropsLapsedStateAndReportsLeaseIDs(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	shortLived, _ := s.RegisterLease(testLease("gone-soon", "N1", now+1000))
	longLived, _ := s.RegisterLease(testLease("stays", "N2", now+3600000))
	s.PutIntroduction(&Introduction{RequestID: "dead-intro", ExpiresAt: now + 1000})

	clk.Advance(2 * time.Second)
	dropped := s.Sweep()
	found := false
	for _, id := range dropped {
		if id == shortLived.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("sweep did not report the lapsed lease: %v", dropped)
	}
	if s.LeaseByID(longLived.ID) == nil {
		t.Fatal("sweep removed a live lease")
	}
	if leases, intros := s.Counts(); leases != 1 || intros != 0 {
		t.Fatalf("counts after sweep = (%d,%d), want (1,0)", leases, intros)
	}
}

func TestCountsIgnoresExpiredWithoutSweeping(t *testing.T) {
	s, clk := newStore(t, Options{})
	now := clk.NowMs()
	s.RegisterLease(testLease("a", "NA", now+1000))
	clk.Advance(1001 * time.Millisecond)
	if leases, _ := s.Counts(); leases != 0 {
		t.Fatalf("expired lease counted as live: %d", leases)
	}
}

func TestBucketTable(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 0}, {1, 0}, {19, 0},
		{20, 20}, {21, 20}, {24, 24 / 5 * 5},
		{25, 25}, {27, 25}, {1284, 1280},
	}
	for _, tc := range cases {
		if got := Bucket(tc.in); got != tc.want {
			t.Errorf("Bucket(%d) = %d, want %d (§5.8)", tc.in, got, tc.want)
		}
	}
}

func TestDefaultOptionsApplyContractValues(t *testing.T) {
	s, _ := newStore(t, Options{})
	if s.nonceTTLMs != 300000 {
		t.Fatalf("nonce TTL default = %d, want 300000 (§4)", s.nonceTTLMs)
	}
	if s.maxLeases != MaxLeases || s.maxPendIntr != MaxPendingIntroductions {
		t.Fatal("global caps do not match §8 defaults")
	}
}
