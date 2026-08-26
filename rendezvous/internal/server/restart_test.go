package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"nex.rendezvous/internal/protocol"
)

// V3 §38 "service restart": every lease lapses. State is process memory only
// (§9), so a fresh Server over a fresh Store knows nothing — this test proves
// it rather than assuming it, and proves the OLD instance's state was its own
// (nothing global, nothing shared).

func TestServiceRestartLapsesEveryLease(t *testing.T) {
	old := newHarness(t)
	alpha := newIdentity("alpha")
	bravo := newIdentity("bravo")
	charlie := newIdentity("charlie")
	a := old.mustRegister(alpha, "alpha")
	b := old.mustRegister(bravo, "bravo")
	c := old.mustRegister(charlie, "charlie")

	leases, _ := old.srv.Store().Counts()
	if leases != 3 {
		t.Fatalf("precondition: %d leases before restart", leases)
	}

	// A brand-new service: fresh store, limiter, hub. Nothing is carried over.
	restarted := newHarness(t)

	for _, tc := range []struct {
		id     string
		handle string
		nodeID string
	}{
		{a.LeaseID, "alpha", alpha.nodeID},
		{b.LeaseID, "bravo", bravo.nodeID},
		{c.LeaseID, "charlie", charlie.nodeID},
	} {
		if l := restarted.srv.Store().LeaseByID(tc.id); l != nil {
			t.Fatalf("lease %s survived a service restart", tc.id)
		}
		if l := restarted.srv.Store().LeaseByHandle(tc.handle); l != nil {
			t.Fatalf("handle %s still registered after restart", tc.handle)
		}
		if l := restarted.srv.Store().LeaseByNode(tc.nodeID); l != nil {
			t.Fatalf("node %s still registered after restart", tc.nodeID)
		}
	}

	if leases, intros := restarted.srv.Store().Counts(); leases != 0 || intros != 0 {
		t.Fatalf("restarted service holds %d leases / %d introductions", leases, intros)
	}
	if n := restarted.srv.Hub().Count(); n != 0 {
		t.Fatalf("restarted service has %d attached channels", n)
	}

	// Search on the new service finds nobody...
	watcher := newIdentity("watcher")
	restarted.mustRegister(watcher, "watcher")
	for _, handle := range []string{"alpha", "bravo", "charlie"} {
		w := restarted.search(watcher, handle)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"result":null`) {
			t.Fatalf("post-restart search for %s = %d %s", handle, w.Code, w.Body.String())
		}
	}

	// ...and the public metrics say exactly that.
	w := restarted.do(http.MethodGet, "/v1/metrics/public", nil, nil)
	var m protocol.MetricsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("metrics body: %v", err)
	}
	if m.NodesConnectable != 0 || m.NodesConnected != 0 {
		t.Fatalf("post-restart metrics = %+v, want zeroes", m)
	}

	// The old instance is untouched: its state was process memory, not
	// something shared with the new process.
	if leases, _ := old.srv.Store().Counts(); leases != 3 {
		t.Fatalf("old instance lost state it should still have (%d)", leases)
	}

	// Recovery path from §9: every node simply re-registers.
	for _, tc := range []struct {
		id     *identity
		handle string
	}{{alpha, "alpha"}, {bravo, "bravo"}, {charlie, "charlie"}} {
		if w := restarted.register(tc.id, tc.handle); w.Code != http.StatusOK {
			t.Fatalf("re-register after restart failed: %d %s", w.Code, w.Body.String())
		}
	}
	leases, _ = restarted.srv.Store().Counts()
	if leases != 4 { // three re-registrations plus the watcher
		t.Fatalf("restarted service holds %d leases after recovery, want 4", leases)
	}
}
