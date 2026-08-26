package control

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"nex.rendezvous/internal/protocol"
)

// --- the §7 client-frame rule ---

// TestParseClientFrameAcceptsOnlyPing pins the one and only accepted client
// frame.
func TestParseClientFrameAcceptsOnlyPing(t *testing.T) {
	f, ok := parseClientFrame([]byte(`{"type":"ping","t":1756200000000}`))
	if !ok || f.Type != protocol.FramePing || f.T != 1756200000000 {
		t.Fatalf("canonical ping: (%+v, %v)", f, ok)
	}
	// t absent decodes as the zero int: harmless, carries no content either way.
	if f, ok := parseClientFrame([]byte(`{"type":"ping"}`)); !ok || f.Type != protocol.FramePing {
		t.Fatalf("ping without t rejected: (%+v, %v)", f, ok)
	}
}

// TestParseClientFrameRejectsEverythingElse is the security property of §7 /
// V3 §25: EVERY frame type the protocol defines except "ping" is refused, so
// there is no client frame that carries content. If someone adds a sixth frame
// constant tomorrow, this test forces them to decide whether clients may send
// it — silence would otherwise default to acceptance.
func TestParseClientFrameRejectsEverythingElse(t *testing.T) {
	types := []string{
		protocol.FrameIntroductionRequest,
		protocol.FrameIntroductionResponse,
		protocol.FrameLeaseExpiring,
		protocol.FramePong,
		"", "ping ", " ping", "PING", "Ping", "pong ",
		"message", "text", "data", "chat",
	}
	for _, ty := range types {
		payload := `{"type":` + mustJSON(t, ty) + `,"t":1}`
		if f, ok := parseClientFrame([]byte(payload)); ok {
			t.Errorf("frame type %q was ACCEPTED (%+v) — a non-ping client frame parsed", ty, f)
		}
	}
}

// TestParseClientFrameRejectsContentCarriers: unknown fields are the smuggling
// route; DisallowUnknownFields is what keeps the ping-only rule structural
// rather than conventional.
func TestParseClientFrameRejectsContentCarriers(t *testing.T) {
	cases := []string{
		`{"type":"ping","t":1,"payload":"hello"}`,
		`{"type":"ping","t":1,"body":{"to":"roshan"}}`,
		`{"type":"ping","t":1,"to":"roshan"}`,
		`{"type":"ping","t":1,"from":"zro","text":"hi"}`,
		`{"type":"introduction.request","requestId":"x"}`,
	}
	for _, payload := range cases {
		if _, ok := parseClientFrame([]byte(payload)); ok {
			t.Errorf("content-carrying frame accepted: %s", payload)
		}
	}
}

// TestParseClientFrameRejectsMalformed walks malformed encodings.
func TestParseClientFrameRejectsMalformed(t *testing.T) {
	cases := []string{
		``, // empty
		`not json`,
		`[1,2,3]`,
		`"ping"`,
		`null`,
		`{"type":"ping","t":1} trailing`,
		`{"type":"ping","t":1}{"type":"ping","t":2}`, // two frames in one message
		`{"type":"ping","t":"str"}`,                  // wrong JSON type for t
		`{,"type":"ping"}`,
	}
	for _, payload := range cases {
		if _, ok := parseClientFrame([]byte(payload)); ok {
			t.Errorf("malformed frame accepted: %q", payload)
		}
	}
}

// TestParseClientFrameCapIs8192 pins the §7 frame cap inside the parser,
// independently of the socket read limit. The probe is a VALID ping followed
// by whitespace out to the cap: below the limit it parses, past it the length
// check alone must refuse it.
func TestParseClientFrameCapIs8192(t *testing.T) {
	base := `{"type":"ping","t":1756200000000}`
	atCap := base + strings.Repeat(" ", protocol.MaxFrameBytes-len(base))
	if len(atCap) != protocol.MaxFrameBytes {
		t.Fatalf("boundary construction = %d bytes, want %d", len(atCap), protocol.MaxFrameBytes)
	}
	if f, ok := parseClientFrame([]byte(atCap)); !ok || f.T != 1756200000000 {
		t.Fatalf("exact-cap ping rejected: (%+v,%v)", f, ok)
	}
	over := atCap + " "
	if _, ok := parseClientFrame([]byte(over)); ok {
		t.Fatal("frame one byte over the cap accepted")
	}
}

// TestClientFrameStructurallyCarriesNoContent asserts the structural guarantee
// by reflection: the ONLY client-facing frame shape has exactly two scalar
// fields and nothing that could hold a message. This is how rendezvous stays
// unable to become a transport even after careless edits — tested as a
// property of the code's shape, not its current behaviour.
func TestClientFrameStructurallyCarriesNoContent(t *testing.T) {
	typ := reflect.TypeOf(protocol.ClientFrame{})
	if typ.NumField() != 2 {
		t.Fatalf("protocol.ClientFrame has %d fields; the client surface must stay exactly {type,t}", typ.NumField())
	}
	names := map[string]bool{}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		names[f.Name] = true
		switch f.Type.Kind() {
		case reflect.String, reflect.Int, reflect.Int64:
		default:
			t.Errorf("field %s has composite kind %v — only scalars belong on the client surface", f.Name, f.Type.Kind())
		}
	}
	if !names["Type"] || !names["T"] {
		t.Fatalf("client frame fields = %v, want exactly Type and T", names)
	}
	for _, forbidden := range []string{"Payload", "Body", "Data", "Content", "Text", "Msg", "Message", "To", "From"} {
		if names[forbidden] {
			t.Errorf("client frame grew a %s field — the control channel is becoming a transport", forbidden)
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %v: %v", v, err)
	}
	return string(b)
}

// --- hub mechanics ---

func newTestConn(leaseID string) *Conn {
	return &Conn{
		leaseID:     leaseID,
		nodeID:      "node-" + leaseID,
		send:        make(chan []byte, sendQueue),
		closed:      make(chan struct{}),
		idleTimeout: IdleTimeout,
	}
}

func drain(c *Conn) []map[string]any {
	var out []map[string]any
	for {
		select {
		case p := <-c.send:
			var m map[string]any
			if json.Unmarshal(p, &m) == nil {
				out = append(out, m)
			}
		default:
			return out
		}
	}
}

// TestHubRegistryHoldsOneChannelPerLease covers §8's "1 live channel per
// lease": the registry never holds two channels for one lease ID, and each
// lease's channel is reachable by that ID alone. (Displacement of a live
// channel by a second upgrade is covered end-to-end in internal/server.)
func TestHubRegistryHoldsOneChannelPerLease(t *testing.T) {
	h := NewHub()
	first := newTestConn("lease-a")
	h.add(first)
	if h.Count() != 1 || h.LeaseIDs()[0] != "lease-a" {
		t.Fatalf("after attach: count=%d ids=%v", h.Count(), h.LeaseIDs())
	}

	// Simulate the replacement the displacement path performs: the new conn
	// takes the slot, the old one is closed and removes itself.
	second := newTestConn("lease-a")
	h.mu.Lock()
	h.byLease["lease-a"] = second
	h.mu.Unlock()
	close(first.closed)
	h.remove(first)

	if h.Count() != 1 {
		t.Fatalf("Count = %d with a replaced channel still removing itself", h.Count())
	}
	if !h.SendToLease("lease-a", map[string]string{"k": "v"}) {
		t.Fatal("current channel did not receive")
	}
	if got := drain(second); len(got) != 1 {
		t.Fatalf("routing went to the displaced channel: %v", got)
	}

	third := newTestConn("lease-b")
	h.add(third)
	if h.Count() != 2 {
		t.Fatalf("Count = %d across two leases", h.Count())
	}
	h.remove(third)
	h.remove(third) // idempotent
	if h.Count() != 1 {
		t.Fatalf("Count = %d after detach", h.Count())
	}
}

// TestRemoveDoesNotEvictReplacement pins remove()'s identity check: a stale
// channel removing itself must not evict the channel that replaced it.
func TestRemoveDoesNotEvictReplacement(t *testing.T) {
	h := NewHub()
	stale := newTestConn("l")
	h.add(stale)
	replacement := newTestConn("l")
	h.mu.Lock()
	h.byLease["l"] = replacement
	h.mu.Unlock()

	h.remove(stale) // stale notices its closure late
	if h.Count() != 1 || !h.SendToLease("l", map[string]string{}) {
		t.Fatal("stale remove evicted its replacement")
	}
	h.remove(replacement)
	if h.Count() != 0 {
		t.Fatalf("Count = %d after current channel removed", h.Count())
	}
	h.remove(replacement) // idempotent
}

// TestNotifyExpiringAtExactLeadTime drives lease.expiring from explicit times:
// nothing before expiresAt-30000, exactly one notice at the lead line, never a
// duplicate, and a moved deadline re-arms the notice (§7).
func TestNotifyExpiringAtExactLeadTime(t *testing.T) {
	h := NewHub()
	c := newTestConn("lease-x")
	h.add(c)

	const expiresAt = int64(1756200090000)
	before := expiresAt - ExpiringLeadMs - 1
	atLead := expiresAt - ExpiringLeadMs

	h.NotifyExpiring("lease-x", expiresAt, before)
	if got := drain(c); len(got) != 0 {
		t.Fatalf("notice fired before the lead window: %v", got)
	}

	h.NotifyExpiring("lease-x", expiresAt, atLead)
	got := drain(c)
	if len(got) != 1 {
		t.Fatalf("want exactly one lease.expiring at the lead boundary, got %v", got)
	}
	if got[0]["type"] != protocol.FrameLeaseExpiring || got[0]["expiresAt"] != float64(expiresAt) {
		t.Fatalf("frame = %v", got[0])
	}

	// Same deadline again: once per deadline.
	h.NotifyExpiring("lease-x", expiresAt, atLead)
	h.NotifyExpiring("lease-x", expiresAt, atLead+1000)
	if got := drain(c); len(got) != 0 {
		t.Fatalf("duplicate lease.expiring: %v", got)
	}

	// A refresh moves the deadline; the new deadline is announced once.
	nextDeadline := expiresAt + 60000
	h.NotifyExpiring("lease-x", nextDeadline, nextDeadline-ExpiringLeadMs)
	got = drain(c)
	if len(got) != 1 || got[0]["expiresAt"] != float64(nextDeadline) {
		t.Fatalf("refreshed deadline notice = %v, want one for %d", got, nextDeadline)
	}

	// Unattached lease: silent no-op.
	h.NotifyExpiring("nobody", expiresAt, atLead)
}

// TestSendToLeaseBestEffort covers delivery semantics: nobody attached → false;
// attached → delivered; oversized frame → refused rather than truncated;
// full queue → dropped without blocking (§5.5 best-effort rule).
func TestSendToLeaseBestEffort(t *testing.T) {
	h := NewHub()

	if h.SendToLease("ghost", map[string]string{"a": "b"}) {
		t.Fatal("delivery to an unattached lease reported success")
	}

	c := newTestConn("l1")
	h.add(c)
	if !h.SendToLease("l1", protocol.PongFrame{Type: protocol.FramePong, T: 7}) {
		t.Fatal("delivery to an attached lease failed")
	}
	if got := drain(c); len(got) != 1 || got[0]["type"] != "pong" {
		t.Fatalf("delivered = %v", got)
	}

	// A frame larger than MaxFrameBytes is a bug upstream; refuse, don't ship.
	huge := map[string]any{"type": protocol.FrameIntroductionRequest, "pad": strings.Repeat("x", protocol.MaxFrameBytes)}
	if h.SendToLease("l1", huge) {
		t.Fatal("oversized frame sent")
	}
	if got := drain(c); len(got) != 0 {
		t.Fatalf("oversized frame leaked into the queue: %v", got)
	}

	// Fill the queue; the next frame is dropped, never blocking the caller.
	for i := 0; i < sendQueue; i++ {
		if !c.trySend([]byte("{}")) {
			t.Fatalf("queue filled early at %d/%d", i+1, sendQueue)
		}
	}
	done := make(chan bool, 1)
	go func() { done <- c.trySend([]byte("{}")) }()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("frame queued beyond capacity")
		}
	case <-time.After(time.Second):
		t.Fatal("trySend blocked on a full queue")
	}

	// A closed channel refuses everything.
	close(c.closed)
	if c.trySend([]byte("{}")) {
		t.Fatal("closed channel accepted a frame")
	}
	if h.SendToLease("l1", map[string]string{}) {
		t.Fatal("delivery through a closed channel reported success")
	}
}

// TestAccessorsAndRegistryCounts: NodeID/LeaseID report ownership and the
// registry counts stay consistent through attach/detach. The close paths
// (CloseLease, CloseAll, displacement) touch the live socket and are covered
// end-to-end in internal/server.
func TestAccessorsAndRegistryCounts(t *testing.T) {
	h := NewHub()
	a, b := newTestConn("la"), newTestConn("lb")
	if a.LeaseID() != "la" || a.NodeID() != "node-la" {
		t.Fatalf("accessors = %q/%q", a.LeaseID(), a.NodeID())
	}

	h.add(a)
	h.add(b)
	if h.Count() != 2 {
		t.Fatalf("Count = %d after two attaches", h.Count())
	}
	ids := h.LeaseIDs()
	if len(ids) != 2 {
		t.Fatalf("LeaseIDs = %v", ids)
	}

	h.remove(a)
	if h.Count() != 1 || !h.SendToLease("lb", map[string]string{}) {
		t.Fatal("registry inconsistent after detach")
	}
	h.remove(b)
	h.remove(b) // idempotent
	if h.Count() != 0 || len(h.LeaseIDs()) != 0 {
		t.Fatal("registry not empty after all detached")
	}
}

// TestConstantsAreSection7Values: nobody tuned the contract quietly.
func TestConstantsAreSection7Values(t *testing.T) {
	if IdleTimeout != 90*time.Second {
		t.Fatalf("IdleTimeout = %v, §7 says 90 s", IdleTimeout)
	}
	if ExpiringLeadMs != 30000 {
		t.Fatalf("ExpiringLeadMs = %d, §7 says 30000", ExpiringLeadMs)
	}
}
