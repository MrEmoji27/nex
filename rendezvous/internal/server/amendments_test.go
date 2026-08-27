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

// Regression tests for the frozen-contract amendments at the HTTP surface.
// Amendment 1's framing tests live in internal/wire and internal/descriptor;
// this file pins the server-side behaviour of Amendments 2 and 3.

// --- Amendment 2 (§5.6) ---

// TestAmendment2RespondRejectionsAreIndistinguishable: unknown requestId,
// expired requestId, and wrong responder must return the SAME status and
// BYTE-IDENTICAL bodies — no branch may be distinguishable by anything on the
// wire, or respond becomes an oracle for live introductions.
func TestAmendment2RespondRejectionsAreIndistinguishable(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")
	mallory := newIdentity("mallory")
	h.mustRegister(zro, "zro")
	h.mustRegister(roshan, "roshan")
	h.mustRegister(mallory, "mallory")

	requestIntro := func(requestID string) {
		t.Helper()
		now := h.now()
		ir := protocol.IntroductionRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
			RequestID: requestID, TargetHandle: "roshan", FromHandle: "zro",
			FromSignPub:   zro.signPub,
			SealedContact: "5ea1ed" + strings.Repeat("00", 60),
			ExpiresAt:     now + 30000, // short: lets us expire one quickly
		}
		ir.Sig = zro.sign(ir.SigningInput())
		if w := h.do(http.MethodPost, "/v1/introduction/request", ir, nil); w.Code != http.StatusAccepted {
			t.Fatalf("introduction/request %s = %d %s", requestID, w.Code, w.Body.String())
		}
	}

	const (
		liveID    = "11111111-2222-4333-8444-555555555555"
		expiryID  = "22222222-2222-4333-8444-555555555555"
		unknownID = "99999999-8888-4777-8666-555555555555"
	)
	requestIntro(liveID)   // will be answered by the WRONG node
	requestIntro(expiryID) // will be left to expire

	// Expire exactly that introduction (leases live 90 s, so everything else
	// stays valid).
	h.clk.Advance(31 * time.Second)

	respondAs := func(id *identity, requestID string) (int, string) {
		now := h.now()
		r := protocol.IntroductionRespond{
			NodeID: id.nodeID, SignPub: id.signPub, IssuedAt: now, Nonce: nextNonce(),
			RequestID: requestID, Accept: false,
		}
		r.Sig = id.sign(r.SigningInput())
		w := h.do(http.MethodPost, "/v1/introduction/respond", r, nil)
		return w.Code, w.Body.String()
	}

	wrongCode, wrongBody := respondAs(mallory, liveID)
	expiredCode, expiredBody := respondAs(roshan, expiryID)
	unknownCode, unknownBody := respondAs(roshan, unknownID)

	if wrongCode != http.StatusNotFound || expiredCode != http.StatusNotFound || unknownCode != http.StatusNotFound {
		t.Fatalf("status codes: wrong=%d expired=%d unknown=%d, want 404 across the board",
			wrongCode, expiredCode, unknownCode)
	}
	for name, body := range map[string]string{
		"wrong-responder": wrongBody,
		"expired":         expiredBody,
		"unknown":         unknownBody,
	} {
		var e apierr.Error
		if err := json.Unmarshal([]byte(body), &e); err != nil || e.Error.Code != apierr.IntroductionExpired {
			t.Fatalf("%s body %q is not 404 introduction_expired (%v)", name, body, err)
		}
	}
	if wrongBody != expiredBody || wrongBody != unknownBody || expiredBody != unknownBody {
		t.Fatalf("bodies differ:\nwrong:   %s\nexpired: %s\nunknown: %s", wrongBody, expiredBody, unknownBody)
	}

	// A legitimate accept still works after all that probing, and consumes.
	const okID = "33333333-2222-4333-8444-555555555555"
	requestIntro(okID)
	now := h.now()
	accept := protocol.IntroductionRespond{
		NodeID: roshan.nodeID, SignPub: roshan.signPub, IssuedAt: now, Nonce: nextNonce(),
		RequestID: okID, Accept: true,
		SealedContact: "5ea1ed" + strings.Repeat("00", 60),
	}
	accept.Sig = roshan.sign(accept.SigningInput())
	if w := h.do(http.MethodPost, "/v1/introduction/respond", accept, nil); w.Code != http.StatusOK {
		t.Fatalf("legitimate accept after probes = %d %s", w.Code, w.Body.String())
	}
	repeat := protocol.IntroductionRespond{
		NodeID: roshan.nodeID, SignPub: roshan.signPub, IssuedAt: h.now(), Nonce: nextNonce(),
		RequestID: okID, Accept: false,
	}
	repeat.Sig = roshan.sign(repeat.SigningInput())
	w := h.do(http.MethodPost, "/v1/introduction/respond", repeat, nil)
	if w.Code != http.StatusNotFound || errCode(t, w) != apierr.IntroductionExpired {
		t.Fatalf("double respond = %d %s, want consumed", w.Code, w.Body.String())
	}
}

// --- Amendment 3 (§5.2/§5.2.1) ---

// TestAmendment3RefreshExpiryIsMinOfDescriptors: the refreshed lease deadline
// is min(now+90000, public.expiresAt, contact.expiresAt), exercised on the
// REFRESH path specifically with each term as the minimum in turn.
func TestAmendment3RefreshExpiryIsMinOfDescriptors(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")

	refreshTo := func(pubIn, contactIn int64) protocol.RefreshResponse {
		t.Helper()
		h.clk.Advance(5 * time.Second)
		now := h.now()
		pub := &descriptor.Public{
			V: descriptor.Version, Handle: "zro", NodeID: zro.nodeID, SignPub: zro.signPub,
			Capabilities: []string{"chat"}, Connectable: true,
			IssuedAt: now, ExpiresAt: now + pubIn,
		}
		pub.Sig = zro.sign(pub.SigningInput())
		contact := &descriptor.Contact{
			V: descriptor.Version, Handle: "zro", NodeID: zro.nodeID, SignPub: zro.signPub,
			NoisePub:     zro.noisePub(),
			Capabilities: []string{"chat"},
			Candidates:   []descriptor.Candidate{{Kind: "direct-tcp", Host: "203.0.113.9", Port: 42001}},
			IssuedAt:     now, ExpiresAt: now + contactIn,
		}
		contact.Sig = zro.sign(contact.SigningInput())

		req := protocol.RefreshRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
			LeaseID: lease.LeaseID, PublicDescriptor: pub, ContactDescriptor: contact,
		}
		req.Sig = zro.sign(req.SigningInput())
		w := h.do(http.MethodPost, "/v1/presence/refresh", req, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("refresh(%d,%d) = %d %s", pubIn, contactIn, w.Code, w.Body.String())
		}
		var resp protocol.RefreshResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("refresh body: %v", err)
		}
		return resp
	}

	type step struct {
		name       string
		pubIn      int64
		contactIn  int64
		wantOffset int64 // relative to the refresh instant
	}
	for _, s := range []step{
		{"contact descriptor shortest", 90000, 40000, 40000},
		{"public descriptor shortest", 30000, 90000, 30000},
		{"lease TTL shortest", 250000, 250000, 90000},
	} {
		resp := refreshTo(s.pubIn, s.contactIn)
		instant := h.now() // refreshTo advanced exactly 5 s per call
		if resp.ExpiresAt != instant+s.wantOffset {
			t.Fatalf("%s: expiresAt = %d, want %d (+%d ms after refresh instant)",
				s.name, resp.ExpiresAt, instant+s.wantOffset, s.wantOffset)
		}
	}
}

// TestAmendment3RefreshWithoutDescriptorsIsNotAShape: both descriptors are
// mandatory; each missing alone is refused too, and the lease survives every
// attempt (a partial refresh must not lapse or destroy anything).
func TestAmendment3RefreshWithoutDescriptorsIsNotAShape(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")

	build := func(withPub, withContact bool) protocol.RefreshRequest {
		now := h.now()
		req := protocol.RefreshRequest{
			NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
			LeaseID: lease.LeaseID,
		}
		if withPub {
			req.PublicDescriptor = zro.publicDesc("zro", now)
		}
		if withContact {
			req.ContactDescriptor = zro.contactDesc("zro", now)
		}
		req.Sig = zro.sign(req.SigningInput())
		return req
	}

	for _, tc := range []struct {
		name              string
		withPub, withCont bool
	}{
		{"neither", false, false},
		{"only public", true, false},
		{"only contact", false, true},
	} {
		req := build(tc.withPub, tc.withCont)
		w := h.do(http.MethodPost, "/v1/presence/refresh", req, nil)
		if w.Code != http.StatusBadRequest || errCode(t, w) != apierr.InvalidRequest {
			t.Fatalf("refresh %s = %d %s, want 400 invalid_request", tc.name, w.Code, w.Body.String())
		}
		l := h.srv.Store().LeaseByID(lease.LeaseID)
		if l == nil {
			t.Fatalf("refresh %s destroyed the lease", tc.name)
		}
		if l.ExpiresAt != lease.ExpiresAt {
			t.Fatalf("refresh %s moved the deadline to %d", tc.name, l.ExpiresAt)
		}
	}
}
