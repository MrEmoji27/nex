package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/descriptor"
	"nex.rendezvous/internal/protocol"
)

// TestEndToEndIntroduction is the defining flow: two nodes register, one finds
// the other by exact handle, asks for an introduction, and the target accepts.
func TestEndToEndIntroduction(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")

	zroLease := h.mustRegister(zro, "zro")
	h.mustRegister(roshan, "roshan")

	if zroLease.Handle != "zro" {
		t.Fatalf("register echoed handle %q", zroLease.Handle)
	}
	if want := h.now() + 90000; zroLease.ExpiresAt != want {
		t.Fatalf("lease expiresAt = %d, want %d (§5.2.1)", zroLease.ExpiresAt, want)
	}

	w := h.search(zro, "roshan")
	if w.Code != http.StatusOK {
		t.Fatalf("search hit = %d %s", w.Code, w.Body.String())
	}
	var found protocol.SearchResponse
	if err := json.Unmarshal(w.Body.Bytes(), &found); err != nil {
		t.Fatalf("search response: %v", err)
	}
	if found.Result == nil {
		t.Fatal("search returned null for a live handle")
	}
	if found.Result.NodeID != roshan.nodeID {
		t.Fatalf("search returned nodeId %s, want %s", found.Result.NodeID, roshan.nodeID)
	}
	// §3.1: the public view carries no transport candidates, no IP, no port.
	// Assert on the serialized form, because that is what leaves the process.
	raw := w.Body.String()
	for _, forbidden := range []string{"candidates", "noisePub", "203.0.113.9", "42001"} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("search response leaked %q: %s", forbidden, raw)
		}
	}

	reqID := "11111111-2222-4333-8444-555555555555"
	now := h.now()
	ir := protocol.IntroductionRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: reqID, TargetHandle: "roshan", FromHandle: "zro",
		FromContactDescriptor: zro.contactDesc("zro", now),
		ExpiresAt:             now + 60000,
	}
	ir.Sig = zro.sign(ir.SigningInput())
	if w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil); w.Code != http.StatusAccepted {
		t.Fatalf("introduction/request = %d %s", w.Code, w.Body.String())
	}

	now = h.now()
	resp := protocol.IntroductionRespond{
		NodeID: roshan.nodeID, SignPub: roshan.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: reqID, Accept: true,
		ContactDescriptor: roshan.contactDesc("roshan", now),
	}
	resp.Sig = roshan.sign(resp.SigningInput())
	if w := h.do(http.MethodPost, "/v1/introduction/respond", resp, nil); w.Code != http.StatusOK {
		t.Fatalf("introduction/respond = %d %s", w.Code, w.Body.String())
	}

	// Responding consumes the introduction: it cannot be answered twice.
	now = h.now()
	resp2 := protocol.IntroductionRespond{
		NodeID: roshan.nodeID, SignPub: roshan.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: reqID, Accept: false,
	}
	resp2.Sig = roshan.sign(resp2.SigningInput())
	w = h.do(http.MethodPost, "/v1/introduction/respond", resp2, nil)
	if w.Code != http.StatusNotFound || errCode(t, w) != apierr.IntroductionExpired {
		t.Fatalf("second respond = %d %s, want 404 introduction_expired", w.Code, w.Body.String())
	}
}

// TestSearchMissIsTwoHundredWithNullResult pins the §5.4 anti-enumeration rule.
func TestSearchMissIsTwoHundredWithNullResult(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.mustRegister(zro, "zro")

	w := h.search(zro, "nobodyhere")
	if w.Code != http.StatusOK {
		t.Fatalf("search miss = %d, want 200 (never 404)", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"result":null`) {
		t.Fatalf("miss body = %s, want {\"result\":null}", w.Body.String())
	}
}

// TestExpiryAloneMakesANodeUndiscoverable is V3 §6. No unregister is sent and
// the sweeper is never run — expiry alone has to be sufficient.
func TestExpiryAloneMakesANodeUndiscoverable(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")
	h.mustRegister(zro, "zro")
	h.mustRegister(roshan, "roshan")

	if w := h.search(zro, "roshan"); strings.Contains(w.Body.String(), `"result":null`) {
		t.Fatalf("precondition: roshan should be discoverable, got %s", w.Body.String())
	}

	h.clk.Advance(91 * time.Second)

	w := h.search(zro, "roshan")
	if w.Code != http.StatusOK {
		t.Fatalf("search after expiry = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"result":null`) {
		t.Fatalf("lapsed lease still discoverable: %s", w.Body.String())
	}
	if h.srv.Store().LeaseByHandle("roshan") != nil {
		t.Fatal("store still reports a live lease for a lapsed node")
	}
}

// TestHandleTaken covers §2: first-come, held for the lease.
func TestHandleTaken(t *testing.T) {
	h := newHarness(t)
	first := newIdentity("first")
	second := newIdentity("second")
	h.mustRegister(first, "roshan")

	w := h.register(second, "roshan")
	if w.Code != http.StatusConflict || errCode(t, w) != apierr.HandleTaken {
		t.Fatalf("second nodeId got %d %s, want 409 handle_taken", w.Code, w.Body.String())
	}
	if w := h.register(first, "roshan"); w.Code != http.StatusOK {
		t.Fatalf("re-register by holder = %d %s", w.Code, w.Body.String())
	}

	// Once the lease lapses the handle is free again.
	h.clk.Advance(91 * time.Second)
	if w := h.register(second, "roshan"); w.Code != http.StatusOK {
		t.Fatalf("register after lapse = %d %s", w.Code, w.Body.String())
	}
}

// TestInvalidSignatureIsRejected is the §4 rejection path.
func TestInvalidSignatureIsRejected(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	now := h.now()

	req := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle:            "zro",
		PublicDescriptor:  zro.publicDesc("zro", now),
		ContactDescriptor: zro.contactDesc("zro", now),
	}
	req.Sig = zro.sign(req.SigningInput())
	req.Handle = "zro2" // move one signed byte after signing

	w := h.do(http.MethodPost, "/v1/presence/register", req, nil)
	if w.Code != http.StatusUnauthorized || errCode(t, w) != apierr.InvalidSignature {
		t.Fatalf("tampered request = %d %s, want 401 invalid_signature", w.Code, w.Body.String())
	}
}

// TestReplayedNonceIsRejected covers the §4 replay window.
func TestReplayedNonceIsRejected(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	now := h.now()

	build := func(nonce string) protocol.RegisterRequest {
		r := protocol.RegisterRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nonce,
			Handle:            "zro",
			PublicDescriptor:  zro.publicDesc("zro", now),
			ContactDescriptor: zro.contactDesc("zro", now),
		}
		r.Sig = zro.sign(r.SigningInput())
		return r
	}

	nonce := nextNonce()
	if w := h.do(http.MethodPost, "/v1/presence/register", build(nonce), nil); w.Code != http.StatusOK {
		t.Fatalf("first send = %d %s", w.Code, w.Body.String())
	}
	w := h.do(http.MethodPost, "/v1/presence/register", build(nonce), nil)
	if w.Code != http.StatusUnauthorized || errCode(t, w) != apierr.ReplayedNonce {
		t.Fatalf("replay = %d %s, want 401 replayed_nonce", w.Code, w.Body.String())
	}
}

// TestStaleRequestIsRejected covers the §4 ±120 s clock window.
func TestStaleRequestIsRejected(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	stale := h.now() - protocol.ClockSkewMs - 1

	req := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: stale, Nonce: nextNonce(),
		Handle:            "zro",
		PublicDescriptor:  zro.publicDesc("zro", h.now()),
		ContactDescriptor: zro.contactDesc("zro", h.now()),
	}
	req.Sig = zro.sign(req.SigningInput())

	w := h.do(http.MethodPost, "/v1/presence/register", req, nil)
	if w.Code != http.StatusBadRequest || errCode(t, w) != apierr.StaleRequest {
		t.Fatalf("stale request = %d %s, want 400 stale_request", w.Code, w.Body.String())
	}
}

// TestOversizedPayloadRejected covers the §5 8192-byte cap.
func TestOversizedPayloadRejected(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	now := h.now()

	req := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle:            "zro",
		PublicDescriptor:  zro.publicDesc("zro", now),
		ContactDescriptor: zro.contactDesc("zro", now),
	}
	// The body is refused before parsing, so this never reaches a validator.
	req.PublicDescriptor.Capabilities = []string{strings.Repeat("a", 9000)}
	req.Sig = zro.sign(req.SigningInput())

	w := h.do(http.MethodPost, "/v1/presence/register", req, nil)
	if w.Code != http.StatusRequestEntityTooLarge || errCode(t, w) != apierr.PayloadTooLarge {
		t.Fatalf("oversized body = %d %s, want 413 payload_too_large", w.Code, w.Body.String())
	}
}

// TestRefreshRequiresBothDescriptors covers §5.2 as amended.
func TestRefreshRequiresBothDescriptors(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")

	now := h.now()
	bare := protocol.RefreshRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		LeaseID: lease.LeaseID,
	}
	bare.Sig = zro.sign(bare.SigningInput())
	w := h.do(http.MethodPost, "/v1/presence/refresh", bare, nil)
	if w.Code != http.StatusBadRequest || errCode(t, w) != apierr.InvalidRequest {
		t.Fatalf("descriptor-less refresh = %d %s, want 400 invalid_request", w.Code, w.Body.String())
	}

	h.clk.Advance(30 * time.Second)
	now = h.now()
	full := protocol.RefreshRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		LeaseID:           lease.LeaseID,
		PublicDescriptor:  zro.publicDesc("zro", now),
		ContactDescriptor: zro.contactDesc("zro", now),
	}
	full.Sig = zro.sign(full.SigningInput())
	w = h.do(http.MethodPost, "/v1/presence/refresh", full, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("refresh = %d %s", w.Code, w.Body.String())
	}
	var got protocol.RefreshResponse
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("refresh body: %v", err)
	}
	if want := now + 90000; got.ExpiresAt != want {
		t.Fatalf("refreshed expiresAt = %d, want %d (§5.2.1)", got.ExpiresAt, want)
	}
}

// TestLeaseNeverOutlivesItsDescriptors is the §5.2.1 invariant.
func TestLeaseNeverOutlivesItsDescriptors(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	now := h.now()

	// A public descriptor that expires in 10 s, well inside the 90 s window.
	pub := &descriptor.Public{
		V: descriptor.Version, Handle: "zro", NodeID: zro.nodeID, SignPub: zro.signPub,
		Capabilities: []string{"chat"}, Connectable: true,
		IssuedAt: now, ExpiresAt: now + 10000,
	}
	pub.Sig = zro.sign(pub.SigningInput())

	req := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle: "zro", PublicDescriptor: pub, ContactDescriptor: zro.contactDesc("zro", now),
	}
	req.Sig = zro.sign(req.SigningInput())

	w := h.do(http.MethodPost, "/v1/presence/register", req, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("register = %d %s", w.Code, w.Body.String())
	}
	var resp protocol.RegisterResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("register body: %v", err)
	}
	if resp.ExpiresAt != now+10000 {
		t.Fatalf("lease expiresAt = %d, want %d (clamped to the shortest descriptor)", resp.ExpiresAt, now+10000)
	}
}

// TestUnregisterIsIdempotent covers §5.3.
func TestUnregisterIsIdempotent(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")

	del := func() int {
		now := h.now()
		req := protocol.UnregisterRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
			LeaseID: lease.LeaseID,
		}
		req.Sig = zro.sign(req.SigningInput())
		return h.do(http.MethodDelete, "/v1/presence", req, nil).Code
	}

	if code := del(); code != http.StatusNoContent {
		t.Fatalf("first unregister = %d, want 204", code)
	}
	if code := del(); code != http.StatusNoContent {
		t.Fatalf("second unregister = %d, want 204 (idempotent)", code)
	}
}

// TestPublicMetricsAreBucketed covers §5.8.
func TestPublicMetricsAreBucketed(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.mustRegister(zro, "zro")

	w := h.do(http.MethodGet, "/v1/metrics/public", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("metrics = %d %s", w.Code, w.Body.String())
	}
	var m protocol.MetricsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("metrics body: %v", err)
	}
	if m.NodesConnectable != 0 {
		t.Fatalf("one live lease reported as %d, want 0 (bucketed)", m.NodesConnectable)
	}
	for _, forbidden := range []string{"zro", zro.nodeID, "handle", "nodeId"} {
		if strings.Contains(w.Body.String(), forbidden) {
			t.Fatalf("metrics leaked %q: %s", forbidden, w.Body.String())
		}
	}
}

// TestStatusIsUnauthenticated covers §5.7.
func TestStatusIsUnauthenticated(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodGet, "/v1/status", nil, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	var s protocol.StatusResponse
	if err := json.Unmarshal(w.Body.Bytes(), &s); err != nil {
		t.Fatalf("status body: %v", err)
	}
	for _, k := range []string{"api", "presence", "discovery", "introduction"} {
		if s.Components[k] != protocol.Operational {
			t.Errorf("component %s = %q, want operational", k, s.Components[k])
		}
	}
}

// TestWrongResponderMatchesUnknownRequest covers §5.6 as amended: unknown,
// expired, and not-your-request all collapse to one code, so respond is not an
// oracle for request existence.
func TestWrongResponderMatchesUnknownRequest(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")
	mallory := newIdentity("mallory")
	h.mustRegister(zro, "zro")
	h.mustRegister(roshan, "roshan")
	h.mustRegister(mallory, "mallory")

	reqID := "11111111-2222-4333-8444-555555555555"
	now := h.now()
	ir := protocol.IntroductionRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: reqID, TargetHandle: "roshan", FromHandle: "zro",
		FromContactDescriptor: zro.contactDesc("zro", now),
		ExpiresAt:             now + 60000,
	}
	ir.Sig = zro.sign(ir.SigningInput())
	if w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil); w.Code != http.StatusAccepted {
		t.Fatalf("introduction/request = %d %s", w.Code, w.Body.String())
	}

	respondAs := func(id *identity, requestID string) (int, apierr.Code) {
		now := h.now()
		r := protocol.IntroductionRespond{
			NodeID: id.nodeID, SignPub: id.signPub, IssuedAt: now, Nonce: nextNonce(),
			RequestID: requestID, Accept: false,
		}
		r.Sig = id.sign(r.SigningInput())
		w := h.do(http.MethodPost, "/v1/introduction/respond", r, nil)
		return w.Code, errCode(t, w)
	}

	wrongCode, wrongErr := respondAs(mallory, reqID)
	unknownCode, unknownErr := respondAs(mallory, "99999999-8888-4777-8666-555555555555")

	if wrongCode != http.StatusNotFound || wrongErr != apierr.IntroductionExpired {
		t.Fatalf("wrong responder = %d %s, want 404 introduction_expired", wrongCode, wrongErr)
	}
	if wrongCode != unknownCode || wrongErr != unknownErr {
		t.Fatalf("respond is an existence oracle: wrong-responder %d/%s vs unknown %d/%s",
			wrongCode, wrongErr, unknownCode, unknownErr)
	}
}

// TestIntroductionToOfflineTargetIsNotFound covers §5.5.
func TestIntroductionToOfflineTargetIsNotFound(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.mustRegister(zro, "zro")

	now := h.now()
	ir := protocol.IntroductionRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: "11111111-2222-4333-8444-555555555555", TargetHandle: "ghost", FromHandle: "zro",
		FromContactDescriptor: zro.contactDesc("zro", now),
		ExpiresAt:             now + 60000,
	}
	ir.Sig = zro.sign(ir.SigningInput())
	w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil)
	if w.Code != http.StatusNotFound || errCode(t, w) != apierr.NotFound {
		t.Fatalf("introduction to offline target = %d %s, want 404 not_found", w.Code, w.Body.String())
	}
}

// TestMaliciousDescriptorIsRejected: a descriptor whose nodeId disagrees with
// the envelope must not be stored, even though its own signature is valid.
func TestMaliciousDescriptorIsRejected(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	victim := newIdentity("victim")
	now := h.now()

	pub := &descriptor.Public{
		V: descriptor.Version, Handle: "zro", NodeID: victim.nodeID, SignPub: zro.signPub,
		Capabilities: []string{"chat"}, Connectable: true,
		IssuedAt: now, ExpiresAt: now + 90000,
	}
	pub.Sig = zro.sign(pub.SigningInput())

	req := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle: "zro", PublicDescriptor: pub, ContactDescriptor: zro.contactDesc("zro", now),
	}
	req.Sig = zro.sign(req.SigningInput())

	w := h.do(http.MethodPost, "/v1/presence/register", req, nil)
	if w.Code != http.StatusBadRequest || errCode(t, w) != apierr.InvalidRequest {
		t.Fatalf("mismatched descriptor nodeId = %d %s, want 400 invalid_request", w.Code, w.Body.String())
	}
}

// TestUnknownRouteIsJSON keeps one error format on the wire (§5.9).
func TestUnknownRouteIsJSON(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodGet, "/v1/nope", nil, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown route = %d, want 404", w.Code)
	}
	if errCode(t, w) != apierr.NotFound {
		t.Fatalf("unknown route body = %s", w.Body.String())
	}
}
