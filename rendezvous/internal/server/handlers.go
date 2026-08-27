package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/coder/websocket"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/descriptor"
	"nex.rendezvous/internal/handle"
	"nex.rendezvous/internal/protocol"
	"nex.rendezvous/internal/ratelimit"
	"nex.rendezvous/internal/store"
)

// leaseExpiry implements §5.2.1:
//
//	leaseExpiresAt = min(now + 90000, publicDescriptor.expiresAt, contactDescriptor.expiresAt)
//
// The invariant it protects: everything search returns is signed, unexpired
// data. A lease may never outlive the descriptors it hands out, because a
// "discoverable" node whose descriptor a correct client must reject is not
// discoverable — it is a lie the service tells about itself.
func (s *Server) leaseExpiry(now int64, pub *descriptor.Public, contact *descriptor.Contact) int64 {
	exp := now + s.cfg.LeaseTTLMs
	if pub.ExpiresAt < exp {
		exp = pub.ExpiresAt
	}
	if contact.ExpiresAt < exp {
		exp = contact.ExpiresAt
	}
	return exp
}

// checkDescriptors runs the §5.1 validation that register and refresh share:
// both descriptors verify against signPub, both agree with the envelope on
// handle/nodeId/signPub, and both are unexpired with a lifetime inside 300 s.
//
// The handle is passed in rather than read from the envelope because refresh
// has no handle field — there it is the lease's handle, so a refresh cannot
// silently rename a node.
func checkDescriptors(pub *descriptor.Public, contact *descriptor.Contact, wantHandle, nodeID, signPub string, now int64) *apierr.E {
	if pub == nil || contact == nil {
		return apierr.New(apierr.InvalidRequest)
	}
	if err := pub.Validate(); err != nil {
		return apierr.New(apierr.InvalidRequest)
	}
	// Keep the §5.4 padding budget satisfiable. The §3 field limits already hold
	// a conforming public descriptor to 859 bytes, so this rejects nothing a
	// correct node can produce — it exists so a descriptor can never outgrow the
	// fixed-size search envelope and silently reopen the length oracle.
	if encoded, err := json.Marshal(pub); err != nil || len(encoded) > protocol.MaxPublicDescriptorBytes {
		return apierr.New(apierr.InvalidRequest)
	}
	if err := contact.Validate(); err != nil {
		return apierr.New(apierr.InvalidRequest)
	}
	if pub.Handle != wantHandle || contact.Handle != wantHandle {
		return apierr.New(apierr.InvalidRequest)
	}
	if pub.NodeID != nodeID || contact.NodeID != nodeID {
		return apierr.New(apierr.InvalidRequest)
	}
	if pub.SignPub != signPub || contact.SignPub != signPub {
		return apierr.New(apierr.InvalidRequest)
	}
	if err := descriptor.CheckLifetime(pub.IssuedAt, pub.ExpiresAt, now); err != nil {
		return apierr.New(apierr.InvalidRequest)
	}
	if err := descriptor.CheckLifetime(contact.IssuedAt, contact.ExpiresAt, now); err != nil {
		return apierr.New(apierr.InvalidRequest)
	}
	return nil
}

// handleRegister implements §5.1.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) *apierr.E {
	body, e := readBody(w, r)
	if e != nil {
		return e
	}
	var req protocol.RegisterRequest
	if e := decodeJSON(body, &req); e != nil {
		return e
	}
	if req.PublicDescriptor == nil || req.ContactDescriptor == nil {
		return apierr.New(apierr.InvalidRequest)
	}
	if e := s.authenticate(ratelimit.OpRegister, req.Envelope(), req.SigningInput(), s.clientIP(r)); e != nil {
		return e
	}

	// Re-normalize and compare rather than repair. A handle the service quietly
	// rewrote is a handle the user did not choose (§2).
	norm, err := handle.Normalize(req.Handle)
	if err != nil || norm != req.Handle {
		return apierr.New(apierr.HandleInvalid)
	}

	now := s.clk.NowMs()
	if e := checkDescriptors(req.PublicDescriptor, req.ContactDescriptor, norm, req.NodeID, req.SignPub, now); e != nil {
		return e
	}

	expiresAt := s.leaseExpiry(now, req.PublicDescriptor, req.ContactDescriptor)
	lease, result := s.store.RegisterLease(&store.Lease{
		Handle:    norm,
		NodeID:    req.NodeID,
		SignPub:   req.SignPub,
		Public:    req.PublicDescriptor,
		Contact:   req.ContactDescriptor,
		ExpiresAt: expiresAt,
	})
	switch result {
	case store.RegisterHandleTaken:
		return apierr.New(apierr.HandleTaken)
	case store.RegisterAtCapacity:
		// §8: at capacity, refuse rather than evict a live user.
		return apierr.WithStatus(apierr.Internal, http.StatusServiceUnavailable)
	}

	return writeJSON(w, http.StatusOK, protocol.RegisterResponse{
		LeaseID:        lease.ID,
		Handle:         lease.Handle,
		ExpiresAt:      lease.ExpiresAt,
		RefreshAfterMs: s.cfg.RefreshAfterMs,
	})
}

// handleRefresh implements §5.2. Both descriptors are mandatory (Amendment 3).
func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) *apierr.E {
	body, e := readBody(w, r)
	if e != nil {
		return e
	}
	var req protocol.RefreshRequest
	if e := decodeJSON(body, &req); e != nil {
		return e
	}
	if req.PublicDescriptor == nil || req.ContactDescriptor == nil || !leaseIDLooksValid(req.LeaseID) {
		return apierr.New(apierr.InvalidRequest)
	}
	if e := s.authenticate(ratelimit.OpRefresh, req.Envelope(), req.SigningInput(), s.clientIP(r)); e != nil {
		return e
	}

	lease := s.store.LeaseByID(req.LeaseID)
	// A lease held by a different node is reported exactly like a lapsed one:
	// the caller learns nothing about whether that leaseId exists.
	if lease == nil || lease.NodeID != req.NodeID {
		return apierr.New(apierr.LeaseExpired)
	}

	now := s.clk.NowMs()
	if e := checkDescriptors(req.PublicDescriptor, req.ContactDescriptor, lease.Handle, req.NodeID, req.SignPub, now); e != nil {
		return e
	}

	expiresAt := s.leaseExpiry(now, req.PublicDescriptor, req.ContactDescriptor)
	updated := s.store.RefreshLease(req.LeaseID, req.NodeID, expiresAt, req.PublicDescriptor, req.ContactDescriptor)
	if updated == nil {
		return apierr.New(apierr.LeaseExpired)
	}

	return writeJSON(w, http.StatusOK, protocol.RefreshResponse{
		ExpiresAt:      updated.ExpiresAt,
		RefreshAfterMs: s.cfg.RefreshAfterMs,
	})
}

// handleUnregister implements §5.3.
//
// Idempotent by contract: deleting an already-lapsed lease is success. This is a
// courtesy, never a correctness requirement — expiry alone must be sufficient
// (V3 §6), so nothing downstream may assume this call ever happened.
func (s *Server) handleUnregister(w http.ResponseWriter, r *http.Request) *apierr.E {
	body, e := readBody(w, r)
	if e != nil {
		return e
	}
	var req protocol.UnregisterRequest
	if e := decodeJSON(body, &req); e != nil {
		return e
	}
	if !leaseIDLooksValid(req.LeaseID) {
		return apierr.New(apierr.InvalidRequest)
	}
	if e := s.authenticate(ratelimit.OpUnregister, req.Envelope(), req.SigningInput(), s.clientIP(r)); e != nil {
		return e
	}

	s.store.DeleteLease(req.LeaseID, req.NodeID)
	s.hub.CloseLease(req.LeaseID)

	w.WriteHeader(http.StatusNoContent)
	return nil
}

// decoyPublic is marshalled and discarded on a search miss so the miss path does
// the same work as the hit path (§5.4).
var decoyPublic = &descriptor.Public{
	V:            descriptor.Version,
	Handle:       "aaaaaaaaaaaaaaaa",
	NodeID:       "0000000000000000000000000000000000000000000000000000000000000000",
	SignPub:      "0000000000000000000000000000000000000000000000000000000000000000",
	Capabilities: []string{"chat", "rooms", "voice"},
	Connectable:  true,
	IssuedAt:     1756200000000,
	ExpiresAt:    1756200090000,
	Sig:          "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
}

// handleSearch implements §5.4.
//
// Exact-handle lookup only: no prefix search, no fuzzy match, no listing, no
// wildcard. This is the primary anti-enumeration control (V3 §26).
//
// A miss returns {"result": null} with 200, never a 404. Identical status for
// hit and miss, and the miss path marshals a decoy descriptor so that the two
// paths do comparable work — the service must not leak handle existence through
// status codes or latency.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) *apierr.E {
	q := r.URL.Query().Get("handle")
	nodeID := r.Header.Get(protocol.HeaderNode)
	signPub := r.Header.Get(protocol.HeaderKey)
	nonce := r.Header.Get(protocol.HeaderNonce)
	sig := r.Header.Get(protocol.HeaderSig)
	issuedAt, ok := parseInt64(r.Header.Get(protocol.HeaderIssued))
	if !ok {
		return apierr.New(apierr.InvalidRequest)
	}
	if len(q) > 512 {
		// Bound the signed input before any work is done on it.
		return apierr.New(apierr.InvalidRequest)
	}

	env := protocol.Envelope{NodeID: nodeID, SignPub: signPub, IssuedAt: issuedAt, Nonce: nonce, Sig: sig}
	if e := s.authenticate(ratelimit.OpSearch, env, protocol.SearchSigningInput(nodeID, signPub, issuedAt, nonce, q), s.clientIP(r)); e != nil {
		return e
	}

	norm, err := handle.Normalize(q)
	if err != nil || norm != q {
		return apierr.New(apierr.HandleInvalid)
	}

	lease := s.store.LeaseByHandle(norm)
	var result *descriptor.Public
	if lease != nil {
		result = lease.Public
	} else {
		// Same work on the miss path: build and discard an equivalent value so
		// the two branches are not separated by an obvious timing gap.
		_ = decoyPublic.SigningInput()
	}
	if result != nil {
		_ = result.SigningInput()
	}

	return writeSearchPadded(w, result)
}

// writeSearchPadded emits a §5.4 search response padded to exactly
// protocol.SearchResponseBytes.
//
// Status code and timing were already equalised between hit and miss; response
// LENGTH was not, and a 15-byte {"result":null} against a ~600-byte hit
// fingerprints handle existence perfectly — defeating the enumeration control
// §26 depends on. Padding every response to one constant makes length carry no
// information at all, which is also the only version of the property a test can
// actually assert.
func writeSearchPadded(w http.ResponseWriter, result *descriptor.Public) *apierr.E {
	body := protocol.SearchResponse{Result: result}
	encoded, err := json.Marshal(body)
	if err != nil {
		return apierr.New(apierr.Internal)
	}
	// Re-marshal with filler sized so the whole document lands on the constant.
	// The empty Pad member is already present in `encoded`, so the shortfall is
	// exactly the filler length.
	shortfall := protocol.SearchResponseBytes - len(encoded)
	if shortfall < 0 {
		// Register rejects oversized descriptors, so this is unreachable for a
		// stored record. Fail closed rather than emit a short, distinguishable
		// body that silently reopens the oracle.
		return apierr.New(apierr.Internal)
	}
	body.Pad = strings.Repeat("A", shortfall)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	out, err := json.Marshal(body)
	if err != nil {
		return apierr.New(apierr.Internal)
	}
	_, _ = w.Write(out)
	return nil
}

// handleIntroductionRequest implements §5.5.
func (s *Server) handleIntroductionRequest(w http.ResponseWriter, r *http.Request) *apierr.E {
	body, e := readBody(w, r)
	if e != nil {
		return e
	}
	var req protocol.IntroductionRequest
	if e := decodeJSON(body, &req); e != nil {
		return e
	}
	if req.SealedContact == "" || req.FromSignPub == "" || !requestIDLooksValid(req.RequestID) {
		return apierr.New(apierr.InvalidRequest)
	}
	if e := s.authenticate(ratelimit.OpIntroRequest, req.Envelope(), req.SigningInput(), s.clientIP(r)); e != nil {
		return e
	}

	target, err := handle.Normalize(req.TargetHandle)
	if err != nil || target != req.TargetHandle {
		return apierr.New(apierr.HandleInvalid)
	}
	from, err := handle.Normalize(req.FromHandle)
	if err != nil || from != req.FromHandle {
		return apierr.New(apierr.HandleInvalid)
	}

	now := s.clk.NowMs()
	if req.ExpiresAt <= now || req.ExpiresAt-req.IssuedAt > protocol.MaxIntroductionLifetimeMs {
		return apierr.New(apierr.InvalidRequest)
	}

	// The requester ships their own address, sealed to the target: to ask for an
	// introduction is to offer your own address first.
	//
	// This service used to validate that descriptor — handle, node id and
	// lifetime. It cannot any more, because it can no longer read it, and that
	// is the trade being made deliberately. Those checks were defence in depth,
	// never load-bearing: §6 already says this service is untrusted and the
	// receiving client re-verifies everything after opening the seal. What is
	// still enforced here is that the sealed blob is signed by the sender, so a
	// relayed address cannot be attributed to somebody else.
	if req.FromSignPub != req.SignPub {
		return apierr.New(apierr.InvalidRequest)
	}

	// §8 extra: 3/min per (nodeId -> targetHandle). Charged before the target
	// lookup so it also bounds probing for which handles are live.
	if ok, retry := s.limiter.AllowIntroTarget(req.NodeID, target); !ok {
		return apierr.RateLimit(retry)
	}

	lease := s.store.LeaseByHandle(target)
	if lease == nil {
		return apierr.New(apierr.NotFound)
	}

	switch s.store.PutIntroduction(&store.Introduction{
		RequestID:    req.RequestID,
		TargetHandle: target,
		TargetNodeID: lease.NodeID,
		FromHandle:   from,
		FromNodeID:   req.NodeID,
		FromContact:  req.SealedContact,
		ExpiresAt:    req.ExpiresAt,
	}) {
	case store.IntroDuplicate:
		return apierr.New(apierr.InvalidRequest)
	case store.IntroAtCapacity:
		return apierr.WithStatus(apierr.Internal, http.StatusServiceUnavailable)
	}

	// Best-effort delivery. The response is 202 whether or not the target's
	// control channel is currently attached; the requester learns the outcome
	// only through §5.6's response, or not at all.
	s.hub.SendToLease(lease.ID, protocol.IntroductionRequestFrame{
		Type:          protocol.FrameIntroductionRequest,
		RequestID:     req.RequestID,
		FromHandle:    from,
		FromSignPub:   req.FromSignPub,
		SealedContact: req.SealedContact,
		ExpiresAt:     req.ExpiresAt,
	})

	return writeJSON(w, http.StatusAccepted, protocol.IntroductionRequestResponse{
		RequestID: req.RequestID,
		ExpiresAt: req.ExpiresAt,
	})
}

// handleIntroductionRespond implements §5.6.
//
// Every rejection on this endpoint — unknown requestId, expired requestId, or a
// responder that is not the request's target — returns the same 404
// introduction_expired (Amendment 2). The branches are deliberately not
// distinguished: a 403/404 split let anyone probe for live introductions by
// guessing request IDs.
func (s *Server) handleIntroductionRespond(w http.ResponseWriter, r *http.Request) *apierr.E {
	body, e := readBody(w, r)
	if e != nil {
		return e
	}
	var req protocol.IntroductionRespond
	if e := decodeJSON(body, &req); e != nil {
		return e
	}
	if !requestIDLooksValid(req.RequestID) {
		return apierr.New(apierr.InvalidRequest)
	}
	// accept:true must carry a sealed contact; accept:false must not.
	if req.Accept == (req.SealedContact == "") {
		return apierr.New(apierr.InvalidRequest)
	}
	if e := s.authenticate(ratelimit.OpIntroRespond, req.Envelope(), req.SigningInput(), s.clientIP(r)); e != nil {
		return e
	}

	// Both lookups run regardless of which one fails, so the rejected paths do
	// the same work and the timing does not separate them either.
	intro := s.store.PeekIntroduction(req.RequestID)
	lease := s.store.LeaseByNode(req.NodeID)
	authorized := intro != nil && lease != nil &&
		lease.Handle == intro.TargetHandle && lease.NodeID == intro.TargetNodeID
	if !authorized {
		return apierr.New(apierr.IntroductionExpired)
	}

	// Consume it: an accept and a reject cannot both be delivered for one request.
	intro = s.store.TakeIntroduction(req.RequestID)
	if intro == nil {
		return apierr.New(apierr.IntroductionExpired)
	}

	now := s.clk.NowMs()
	// The responder's address is sealed to the requester, so the checks that
	// used to happen here — handle, node id, lifetime — are no longer possible.
	// They were defence in depth rather than load-bearing: the requesting client
	// re-verifies the descriptor after opening it, and §6 already treats this
	// service as untrusted. What remains enforced is the signature over the
	// sealed blob, which still binds the address to the responder.
	_ = now

	// Deliver to the requester if they are attached. On reject, no contact
	// descriptor is carried: a refusal must not hand out an address.
	if requester := s.store.LeaseByNode(intro.FromNodeID); requester != nil {
		s.hub.SendToLease(requester.ID, protocol.IntroductionResponseFrame{
			Type:          protocol.FrameIntroductionResponse,
			RequestID:     req.RequestID,
			Accept:        req.Accept,
			SealedContact: req.SealedContact,
		})
	}

	return writeJSON(w, http.StatusOK, protocol.IntroductionRespondResponse{OK: true})
}

// handleStatus implements §5.7. Unauthenticated.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) *apierr.E {
	if ok, retry := s.limiter.Allow(ratelimit.OpPublic, "", s.clientIP(r)); !ok {
		return apierr.RateLimit(retry)
	}
	leases, intros := s.store.Counts()

	presence := protocol.Operational
	if s.cfg.MaxLeases > 0 && leases >= s.cfg.MaxLeases {
		presence = protocol.Degraded
	}
	introduction := protocol.Operational
	if s.cfg.MaxPendingIntroductions > 0 && intros >= s.cfg.MaxPendingIntroductions {
		introduction = protocol.Degraded
	}

	return writeJSON(w, http.StatusOK, protocol.StatusResponse{
		Version:   Version,
		UptimeSec: int64(s.clk.Now().Sub(s.startedAt).Seconds()),
		Components: map[string]string{
			"api":          protocol.Operational,
			"presence":     presence,
			"discovery":    protocol.Operational,
			"introduction": introduction,
		},
	})
}

// handleMetrics implements §5.8. Unauthenticated.
//
// Nothing else is exposed. Never a handle, nodeId, IP, region, or the timestamp
// of an individual event — only two bucketed counts and the sample time.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) *apierr.E {
	if ok, retry := s.limiter.Allow(ratelimit.OpPublic, "", s.clientIP(r)); !ok {
		return apierr.RateLimit(retry)
	}
	connectable, _ := s.store.Counts()
	return writeJSON(w, http.StatusOK, protocol.MetricsResponse{
		NodesConnected:   store.Bucket(s.hub.Count()),
		NodesConnectable: store.Bucket(connectable),
		SampledAt:        s.clk.NowMs(),
	})
}

// handleControl implements §7: upgrade to the WebSocket control channel.
func (s *Server) handleControl(w http.ResponseWriter, r *http.Request) *apierr.E {
	nodeID := r.Header.Get(protocol.HeaderNode)
	signPub := r.Header.Get(protocol.HeaderKey)
	nonce := r.Header.Get(protocol.HeaderNonce)
	sig := r.Header.Get(protocol.HeaderSig)
	leaseID := r.Header.Get(protocol.HeaderLease)
	issuedAt, ok := parseInt64(r.Header.Get(protocol.HeaderIssued))
	if !ok || !leaseIDLooksValid(leaseID) {
		return apierr.New(apierr.InvalidRequest)
	}

	env := protocol.Envelope{NodeID: nodeID, SignPub: signPub, IssuedAt: issuedAt, Nonce: nonce, Sig: sig}
	if e := s.authenticate(ratelimit.OpControl, env, protocol.ControlSigningInput(nodeID, signPub, issuedAt, nonce, leaseID), s.clientIP(r)); e != nil {
		return e
	}

	lease := s.store.LeaseByID(leaseID)
	if lease == nil || lease.NodeID != nodeID {
		return apierr.New(apierr.LeaseExpired)
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{})
	if err != nil {
		// Accept has already written its own HTTP response on failure.
		return nil
	}
	s.hub.Serve(r.Context(), ws, lease.ID, lease.NodeID)
	return nil
}
