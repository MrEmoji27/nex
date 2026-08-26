package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/protocol"
	"nex.rendezvous/internal/ratelimit"
)

// V3 §38 abuse coverage: enumeration attempts, registration floods, request
// floods, oversized payloads, repeated invalid signatures driving the IP ban,
// replayed nonces at scale. Everything runs on the injected clock; limits are
// tightened with Limiter.SetRule where the normative numbers would take
// minutes to reach honestly.

// doRaw issues a request with an exact raw body, bypassing JSON marshalling,
// so size boundaries can be tested precisely.
func (h *harness) doRaw(method, target, body string) *httptest.ResponseRecorder {
	h.t.Helper()
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	r.RemoteAddr = "198.51.100.7:5555"
	w := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(w, r)
	return w
}

func retryAfterOf(t *testing.T, w *httptest.ResponseRecorder) int {
	t.Helper()
	n := 0
	for _, c := range w.Header().Get("Retry-After") {
		if c < '0' || c > '9' {
			t.Fatalf("Retry-After %q is not numeric", w.Header().Get("Retry-After"))
		}
		n = n*10 + int(c-'0')
	}
	if n == 0 {
		t.Fatal("429 without a positive Retry-After")
	}
	return n
}

// --- enumeration ---

// TestEnumerationAttemptsAreBlind: exact-handle lookup only. Misses are 200
// null regardless of how many are tried; prefix/wildcard/fuzzy shapes fail
// normalization instead of matching anything; no listing surface exists.
func TestEnumerationAttemptsAreBlind(t *testing.T) {
	h := newHarness(t)
	h.srv.Limiter().SetRule(ratelimit.OpSearch, ratelimit.Rule{PerNode: 1000, PerIP: 1000})
	zro := newIdentity("zro")
	h.mustRegister(zro, "zro")

	for _, probe := range []string{"ros", "roshan1", "rosh", "nobody", "zzzzzz"} {
		w := h.search(zro, probe)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"result":null`) {
			t.Fatalf("probe %q = %d %s, want indistinguishable 200/null", probe, w.Code, w.Body.String())
		}
	}

	// Wildcards and fuzzing shapes never become queries. Where the bytes
	// survive URL parsing they fail handle normalization (400); where the URL
	// layer mangles them the signature no longer matches (401). Either way:
	// never a result, never a 5xx.
	for _, probe := range []string{"ros*", "roshan%", "roshan_", "*", "%"} {
		w := h.search(zro, probe)
		if w.Code >= 500 {
			t.Fatalf("wildcard probe %q = %d", probe, w.Code)
		}
		if w.Code == http.StatusOK && !strings.Contains(w.Body.String(), `"result":null`) {
			t.Fatalf("wildcard probe %q MATCHED something: %s", probe, w.Body.String())
		}
	}

	// No listing endpoint under any spelling.
	for _, path := range []string{
		"/v1/discovery/list", "/v1/discovery/all", "/v1/discovery",
		"/v1/discovery/search/", "/v1/presence/list",
	} {
		w := h.do(http.MethodGet, path, nil, nil)
		if w.Code != http.StatusNotFound || errCode(t, w) != apierr.NotFound {
			t.Fatalf("listing probe %s = %d %s", path, w.Code, w.Body.String())
		}
	}
}

// TestHandleProbingIsRateLimitedPerTarget: hammering introductions at one
// (nonexistent) handle to learn when it appears is capped at 3/min per
// nodeId->target pair even though every lookup misses (§8 extra column
// charged before the target lookup, deliberately).
func TestHandleProbingIsRateLimitedPerTarget(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.mustRegister(zro, "zro")

	reqID := func(i int) string {
		return "aaaaaaaa-0000-4000-8000-" + pad12(i)
	}
	for i := 0; i < 3; i++ {
		ir := protocol.IntroductionRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: h.now(), Nonce: nextNonce(),
			RequestID: reqID(i), TargetHandle: "ghost-target", FromHandle: "zro",
			FromContactDescriptor: zro.contactDesc("zro", h.now()),
			ExpiresAt:             h.now() + 60000,
		}
		ir.Sig = zro.sign(ir.SigningInput())
		w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil)
		if w.Code != http.StatusNotFound { // miss, but counted
			t.Fatalf("probe %d = %d %s, want 404", i, w.Code, w.Body.String())
		}
	}
	ir := protocol.IntroductionRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: h.now(), Nonce: nextNonce(),
		RequestID: reqID(99), TargetHandle: "ghost-target", FromHandle: "zro",
		FromContactDescriptor: zro.contactDesc("zro", h.now()),
		ExpiresAt:             h.now() + 60000,
	}
	ir.Sig = zro.sign(ir.SigningInput())
	w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil)
	if w.Code != http.StatusTooManyRequests || errCode(t, w) != apierr.RateLimited {
		t.Fatalf("4th probe of one target = %d %s, want 429 rate_limited", w.Code, w.Body.String())
	}
	retryAfterOf(t, w)
}

func pad12(i int) string {
	s := "000000000000"
	d := []byte{}
	if i == 0 {
		d = append(d, '0')
	}
	for i > 0 {
		d = append([]byte{byte('0' + i%10)}, d...)
		i /= 10
	}
	return s[:12-len(d)] + string(d)
}

// --- registration floods ---

// TestRegistrationFloodPerNodeThenPerIP: one node is cut off at its own limit;
// rotating identities through one IP then hits the IP limit; whichever trips
// first wins.
func TestRegistrationFloodPerNodeThenPerIP(t *testing.T) {
	h := newHarness(t)
	h.srv.Limiter().SetRule(ratelimit.OpRegister, ratelimit.Rule{PerNode: 3, PerIP: 5})

	a := newIdentity("flooder-a")
	for i := 0; i < 3; i++ {
		if w := h.register(a, "aflood"+pad12(i)+"x"); w.Code != http.StatusOK {
			t.Fatalf("a register %d = %d %s", i, w.Code, w.Body.String())
		}
	}
	w := h.register(a, "aflood99x")
	if w.Code != http.StatusTooManyRequests || errCode(t, w) != apierr.RateLimited {
		t.Fatalf("a 4th register = %d %s, want 429", w.Code, w.Body.String())
	}
	retryAfterOf(t, w)

	// Rotation: two more distinct identities fit inside the IP allowance...
	b, c := newIdentity("flood-b"), newIdentity("flood-c")
	for _, id := range []*identity{b, c} {
		handle := "f" + strings.ToLower(id.nodeID[len(id.nodeID)-6:])
		if w := h.register(id, handle); w.Code != http.StatusOK {
			t.Fatalf("rotation register %s/%s = %d %s", id.nodeID[:8], handle, w.Code, w.Body.String())
		}
	}
	// ...and the next one is refused on sight.
	d := newIdentity("flood-d")
	w = h.register(d, "fdxxx")
	if w.Code != http.StatusTooManyRequests || errCode(t, w) != apierr.RateLimited {
		t.Fatalf("post-exhaustion register = %d %s, want 429", w.Code, w.Body.String())
	}
}

// TestRegistrationGlobalCapRefusesWith503: at MaxLeases the service refuses
// new work rather than evicting live users (§8).
func TestRegistrationGlobalCapRefusesWith503(t *testing.T) {
	clk := clock.NewFake()
	cfg := DefaultConfig()
	cfg.MaxLeases = 2
	srv := New(cfg, clk, NewDiscardLogger())
	defer srv.Shutdown()

	reg := func(name string) *httptest.ResponseRecorder {
		id := newIdentity(name)
		now := clk.NowMs()
		req := protocol.RegisterRequest{
			NodeID: id.nodeID, SignPub: id.signPub, IssuedAt: now, Nonce: nextNonce(),
			Handle:            strings.ToLower(name),
			PublicDescriptor:  id.publicDesc(strings.ToLower(name), now),
			ContactDescriptor: id.contactDesc(strings.ToLower(name), now),
		}
		req.Sig = id.sign(req.SigningInput())
		raw, _ := json.Marshal(req)
		r := httptest.NewRequest(http.MethodPost, "/v1/presence/register", bytes.NewReader(raw))
		r.RemoteAddr = "198.51.100.7:5555"
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		return w
	}

	for _, name := range []string{"capone", "captwo"} {
		if w := reg(name); w.Code != http.StatusOK {
			t.Fatalf("%s register = %d %s", name, w.Code, w.Body.String())
		}
	}
	w := reg("capthree")
	if w.Code != http.StatusServiceUnavailable || errCode(t, w) != apierr.Internal {
		t.Fatalf("over-cap register = %d %s, want 503 internal", w.Code, w.Body.String())
	}
	// Live users are untouched by the refusal.
	if w := reg("captwo"); w.Code != http.StatusOK {
		t.Fatalf("existing node re-register at capacity = %d %s, want replacement OK", w.Code, w.Body.String())
	}
}

// --- request floods ---

// TestIntroductionFloodIsBounded: beyond the per-target extra column (already
// covered), the overall intro/request budget is enforced per node and per IP.
func TestIntroductionFloodIsBounded(t *testing.T) {
	h := newHarness(t)
	h.srv.Limiter().SetRule(ratelimit.OpIntroRequest, ratelimit.Rule{PerNode: 4, PerIP: 4})
	h.srv.Limiter().SetRule(ratelimit.OpRegister, ratelimit.Rule{PerNode: 1000, PerIP: 1000})
	h.mustRegister(newIdentity("roshan"), "roshan")
	h.mustRegister(newIdentity("roshantwo"), "roshan-two")

	targets := []string{"roshan", "roshan-two"} // interleaved so the §8
	// per-target extra column (3/min per pair) never fires before the main
	// per-node row under test here.

	send := func(from *identity, i int, target string) *httptest.ResponseRecorder {
		ir := protocol.IntroductionRequest{
			NodeID: from.nodeID, SignPub: from.signPub, IssuedAt: h.now(), Nonce: nextNonce(),
			RequestID:             "bbbbbbbb-0000-4000-8000-" + pad12(i),
			TargetHandle:          target,
			FromHandle:            "from0000xx",
			FromContactDescriptor: from.contactDesc("from0000xx", h.now()),
			ExpiresAt:             h.now() + 60000,
		}
		ir.Sig = from.sign(ir.SigningInput())
		return h.do(http.MethodPost, "/v1/introduction/request", ir, nil)
	}

	from := newIdentity("intro-flooder")
	h.mustRegister(from, "from0000xx")
	for i := 0; i < 4; i++ {
		w := send(from, i, targets[i%2])
		if w.Code != http.StatusAccepted {
			t.Fatalf("intro %d = %d %s, want 202", i, w.Code, w.Body.String())
		}
	}
	w := send(from, 42, targets[0])
	if w.Code != http.StatusTooManyRequests || errCode(t, w) != apierr.RateLimited {
		t.Fatalf("5th intro = %d %s, want 429", w.Code, w.Body.String())
	}
	retryAfterOf(t, w)
}

// --- oversized payloads ---

// TestOversizedPayloadBoundaries pins the 8192 cap from both sides: announced
// oversize is refused unread; exactly-at-cap is parsed (and fails as malformed
// JSON, NOT as 413); a lying chunked body cannot slip past the read bound.
func TestOversizedPayloadBoundaries(t *testing.T) {
	h := newHarness(t)

	if w := h.doRaw(http.MethodPost, "/v1/presence/register", strings.Repeat("x", protocol.MaxBodyBytes+1)); w.Code != http.StatusRequestEntityTooLarge || errCode(t, w) != apierr.PayloadTooLarge {
		t.Fatalf("8193-byte body = %d %s, want 413 payload_too_large", w.Code, w.Body.String())
	}
	if w := h.doRaw(http.MethodPost, "/v1/presence/register", "{"+strings.Repeat(" ", protocol.MaxBodyBytes-2)+"}"); w.Code != http.StatusBadRequest {
		t.Fatalf("exactly-8192-byte body = %d %s, want 400 (parsed, then rejected as malformed)", w.Code, w.Body.String())
	}
	// Lying length: ContentLength says small, body delivers big.
	r := httptest.NewRequest(http.MethodPost, "/v1/presence/register",
		strings.NewReader(`{"junk":"`+strings.Repeat("x", protocol.MaxBodyBytes+64)+`"}`))
	r.ContentLength = 16 // lie
	r.RemoteAddr = "198.51.100.7:5555"
	w := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("lying chunked-style body = %d, want 413 from the read bound", w.Code)
	}
}

// --- repeated invalid signatures drive the IP ban ---

// TestInvalidSignatureFloodBansTheIP is §8's ban end to end over HTTP: ten
// bad signatures inside a minute refuse the SOURCE for five minutes — even
// for perfectly signed traffic — while other IPs sail through; the ban lifts
// when the injected clock says so.
func TestInvalidSignatureFloodBansTheIP(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")

	badRegister := func() *httptest.ResponseRecorder {
		now := h.now()
		req := protocol.RegisterRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
			Handle:            "zro",
			PublicDescriptor:  zro.publicDesc("zro", now),
			ContactDescriptor: zro.contactDesc("zro", now),
		}
		req.Sig = zro.sign(req.SigningInput())
		req.Handle = "tampered" // invalidate without breaking the JSON shape
		return h.do(http.MethodPost, "/v1/presence/register", req, nil)
	}

	for i := 0; i < 9; i++ {
		w := badRegister()
		if w.Code != http.StatusUnauthorized || errCode(t, w) != apierr.InvalidSignature {
			t.Fatalf("bad-sig %d = %d %s, want 401 invalid_signature", i+1, w.Code, w.Body.String())
		}
	}
	// Strike ten crosses the threshold; THIS request still sees 401 because
	// the ban takes effect on the NEXT entry.
	if w := badRegister(); w.Code != http.StatusUnauthorized {
		t.Fatalf("10th bad sig = %d, want 401 (ban starts now)", w.Code)
	}

	// A perfectly signed request from the banned source is refused with 429
	// and a Retry-After close to 300 s.
	now := h.now()
	good := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle:            "zro2",
		PublicDescriptor:  zro.publicDesc("zro2", now),
		ContactDescriptor: zro.contactDesc("zro2", now),
	}
	good.Sig = zro.sign(good.SigningInput())
	w := h.do(http.MethodPost, "/v1/presence/register", good, nil)
	if w.Code != http.StatusTooManyRequests || errCode(t, w) != apierr.RateLimited {
		t.Fatalf("valid request from banned IP = %d %s, want 429", w.Code, w.Body.String())
	}
	if ra := retryAfterOf(t, w); ra < 290 || ra > 300 {
		t.Fatalf("Retry-After = %d, want ≈300 (the §8 ban length)", ra)
	}

	// A different source address is unaffected.
	r := httptest.NewRequest(http.MethodGet, "/v1/status", nil)
	r.RemoteAddr = "203.0.113.200:1234"
	w2 := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(w2, r)
	if w2.Code != http.StatusOK {
		t.Fatalf("unrelated IP caught in the ban: %d", w2.Code)
	}

	// The ban expires on the injected clock, and the node can proceed.
	h.clk.Advance(301 * time.Second)
	now = h.now()
	good.IssuedAt = now
	good.Nonce = nextNonce()
	good.PublicDescriptor = zro.publicDesc("zro2", now)
	good.ContactDescriptor = zro.contactDesc("zro2", now)
	good.Sig = zro.sign(good.SigningInput())
	if w := h.do(http.MethodPost, "/v1/presence/register", good, nil); w.Code != http.StatusOK {
		t.Fatalf("post-ban register = %d %s, want 200", w.Code, w.Body.String())
	}
}

// --- replayed nonces at scale ---

// TestReplayedNoncesAtScale: one captured register request replayed many
// times yields exactly one acceptance; every replay is rejected with
// replayed_nonce, including when replayed against a DIFFERENT endpoint.
func TestReplayedNoncesAtScale(t *testing.T) {
	h := newHarness(t)
	// Lift the rate rows so the test isolates REPLAY semantics, not buckets.
	h.srv.Limiter().SetRule(ratelimit.OpRegister, ratelimit.Rule{PerNode: 1000, PerIP: 1000})
	h.srv.Limiter().SetRule(ratelimit.OpUnregister, ratelimit.Rule{PerNode: 1000, PerIP: 1000})

	zro := newIdentity("zro")
	now := h.now()
	captured := protocol.RegisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle:            "zro",
		PublicDescriptor:  zro.publicDesc("zro", now),
		ContactDescriptor: zro.contactDesc("zro", now),
	}
	captured.Sig = zro.sign(captured.SigningInput())

	if w := h.do(http.MethodPost, "/v1/presence/register", captured, nil); w.Code != http.StatusOK {
		t.Fatalf("original = %d %s", w.Code, w.Body.String())
	}
	for i := 0; i < 60; i++ {
		w := h.do(http.MethodPost, "/v1/presence/register", captured, nil)
		if w.Code != http.StatusUnauthorized || errCode(t, w) != apierr.ReplayedNonce {
			t.Fatalf("replay %d = %d %s, want 401 replayed_nonce", i+1, w.Code, w.Body.String())
		}
	}

	// Same nonce against another operation: still a replay. The nonce space
	// is per node, not per endpoint.
	del := protocol.UnregisterRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: h.now(), Nonce: captured.Nonce,
		LeaseID: "ffffffffffffffffffffffffffffffff",
	}
	del.Sig = zro.sign(del.SigningInput())
	w := h.do(http.MethodDelete, "/v1/presence", del, nil)
	if w.Code != http.StatusUnauthorized || errCode(t, w) != apierr.ReplayedNonce {
		t.Fatalf("cross-endpoint nonce reuse = %d %s, want 401 replayed_nonce", w.Code, w.Body.String())
	}
}

// --- malformed traffic keeps the single error surface ---

// TestMalformedTrafficGetsSection59Shape.
func TestMalformedTrafficGetsSection59Shape(t *testing.T) {
	h := newHarness(t)

	cases := []struct {
		name string
		do   func() *httptest.ResponseRecorder
	}{
		{"broken JSON", func() *httptest.ResponseRecorder {
			return h.doRaw(http.MethodPost, "/v1/presence/register", `{"nodeId": `)
		}},
		{"empty body", func() *httptest.ResponseRecorder {
			return h.doRaw(http.MethodPost, "/v1/presence/register", "")
		}},
		{"wrong verb on known path", func() *httptest.ResponseRecorder {
			return h.do(http.MethodPost, "/v1/status", nil, nil)
		}},
		{"query injection into delete", func() *httptest.ResponseRecorder {
			return h.doRaw(http.MethodDelete, "/v1/presence?handle=x", "{}")
		}},
	}
	for _, tc := range cases {
		w := tc.do()
		if w.Code == 0 || w.Code >= 500 {
			t.Errorf("%s: status %d", tc.name, w.Code)
		}
		var e apierr.Error
		if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
			t.Errorf("%s: body %q is not a §5.9 envelope", tc.name, w.Body.String())
		}
	}
}
