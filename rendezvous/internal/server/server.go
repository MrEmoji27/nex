// Package server wires the rendezvous HTTP and WebSocket surface described in
// RENDEZVOUS_WIRE_V1 §5 and §7.
//
// The service is an untrusted introducer. Checking a signature does not make it
// an identity authority: the real proof happens later, in the Noise handshake,
// when the dialing peer pins nodeId (§6). Nothing here should ever be read as
// establishing that a signPub belongs to a nodeId.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/control"
	"nex.rendezvous/internal/protocol"
	"nex.rendezvous/internal/ratelimit"
	"nex.rendezvous/internal/store"
	"nex.rendezvous/internal/wire"
)

// Server is the whole service.
type Server struct {
	cfg     Config
	clk     clock.Clock
	store   *store.Store
	limiter *ratelimit.Limiter
	hub     *control.Hub
	log     Logger

	startedAt time.Time

	stopSweeper chan struct{}
}

// New builds a server. The clock is injected so every expiry rule in the
// contract can be tested without sleeping.
func New(cfg Config, clk clock.Clock, log Logger) *Server {
	cfg = cfg.normalized()
	if clk == nil {
		clk = clock.Real{}
	}
	if log == nil {
		log = NewDiscardLogger()
	}
	return &Server{
		cfg: cfg,
		clk: clk,
		store: store.New(clk, store.Options{
			NonceTTLMs:              protocol.NonceTTLMs,
			MaxLeases:               cfg.MaxLeases,
			MaxPendingIntroductions: cfg.MaxPendingIntroductions,
		}),
		limiter:     ratelimit.New(clk),
		hub:         control.NewHub(),
		log:         log,
		startedAt:   clk.Now(),
		stopSweeper: make(chan struct{}),
	}
}

// Store exposes the in-memory state. Test-facing.
func (s *Server) Store() *store.Store { return s.store }

// Limiter exposes the rate limiter. Test-facing, so a test can tighten one row
// instead of issuing dozens of real requests.
func (s *Server) Limiter() *ratelimit.Limiter { return s.limiter }

// Hub exposes the control-channel registry. Test-facing.
func (s *Server) Hub() *control.Hub { return s.hub }

// StartSweeper runs the background reclaim loop.
//
// It reclaims memory; it does not implement expiry. Every read path already
// decides expiry for itself, so a service whose sweeper never ran would still
// stop serving a lapsed node. That is what makes "expiry alone is sufficient"
// (V3 §6) true rather than aspirational.
func (s *Server) StartSweeper() {
	go func() {
		t := time.NewTicker(s.cfg.SweepInterval)
		defer t.Stop()
		for {
			select {
			case <-s.stopSweeper:
				return
			case <-t.C:
				s.Sweep()
			}
		}
	}()
}

// Sweep runs one reclaim pass. Tests call it directly after advancing the clock.
func (s *Server) Sweep() {
	now := s.clk.NowMs()

	// Warn attached channels whose lease is about to lapse, before reclaiming.
	for _, leaseID := range s.hub.LeaseIDs() {
		l := s.store.LeaseByID(leaseID)
		if l == nil {
			s.hub.CloseLease(leaseID)
			continue
		}
		s.hub.NotifyExpiring(leaseID, l.ExpiresAt, now)
	}

	for _, leaseID := range s.store.Sweep() {
		s.hub.CloseLease(leaseID)
	}
	s.limiter.Sweep()
}

// Shutdown stops the sweeper and closes every control channel.
func (s *Server) Shutdown() {
	select {
	case <-s.stopSweeper:
	default:
		close(s.stopSweeper)
	}
	s.hub.CloseAll()
}

// Handler returns the http.Handler for the service.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(s.route)
}

// route dispatches by path and method by hand rather than through ServeMux.
//
// The reason is uniformity of the error surface: every failure the client can
// provoke — wrong path, wrong method, oversized body, bad signature — must come
// back as the §5.9 JSON shape. A mux that emits its own plain-text 404 and 405
// would put two error formats on the wire.
func (s *Server) route(w http.ResponseWriter, r *http.Request) {
	started := s.clk.Now()
	rec := &recorder{ResponseWriter: w, status: http.StatusOK}
	path := SanitizePath(r.URL.Path)

	defer func() {
		s.log.Access(r.Method, path, rec.status, DurationBucket(s.clk.Now().Sub(started)), rec.errCode)
	}()

	// The two unauthenticated public endpoints are read by the website from a
	// different origin, so they need CORS. Nothing else does: every other
	// endpoint is called by a Nex node, not a browser, and handing them a
	// permissive origin would let any page a user visits drive their presence.
	//
	// This is read-only and carries no credentials, so a wildcard origin is the
	// honest setting — the data is already public and already bucketed.
	if path == "/v1/status" || path == "/v1/metrics/public" {
		rec.Header().Set("Access-Control-Allow-Origin", "*")
		rec.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			rec.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			rec.Header().Set("Access-Control-Max-Age", "86400")
			rec.WriteHeader(http.StatusNoContent)
			return
		}
	}

	var e *apierr.E
	switch path {
	case "/v1/presence/register":
		e = s.methodGate(rec, r, http.MethodPost, s.handleRegister)
	case "/v1/presence/refresh":
		e = s.methodGate(rec, r, http.MethodPost, s.handleRefresh)
	case "/v1/presence":
		e = s.methodGate(rec, r, http.MethodDelete, s.handleUnregister)
	case "/v1/discovery/search":
		e = s.methodGate(rec, r, http.MethodGet, s.handleSearch)
	case "/v1/introduction/request":
		e = s.methodGate(rec, r, http.MethodPost, s.handleIntroductionRequest)
	case "/v1/introduction/respond":
		e = s.methodGate(rec, r, http.MethodPost, s.handleIntroductionRespond)
	case "/v1/status":
		e = s.methodGate(rec, r, http.MethodGet, s.handleStatus)
	case "/v1/metrics/public":
		e = s.methodGate(rec, r, http.MethodGet, s.handleMetrics)
	case "/v1/control":
		e = s.methodGate(rec, r, http.MethodGet, s.handleControl)
	default:
		e = apierr.New(apierr.NotFound)
	}

	if e != nil {
		rec.errCode = e.Code
		apierr.Write(rec, e)
	}
}

type handlerFunc func(http.ResponseWriter, *http.Request) *apierr.E

func (s *Server) methodGate(w http.ResponseWriter, r *http.Request, method string, h handlerFunc) *apierr.E {
	if r.Method != method {
		// A known path reached with the wrong verb is a malformed request, not
		// a different resource. It must not distinguish itself from a 404 in a
		// way that helps map the surface.
		return apierr.New(apierr.NotFound)
	}
	return h(w, r)
}

// clientIP resolves the source address used by every per-IP limit in §8.
//
// The IP is used and never stored: it keys a token bucket in memory and never
// reaches a log line, a metric, or a record paired with a handle (§9).
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxyHeaders {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if i := strings.IndexByte(xff, ','); i >= 0 {
				xff = xff[:i]
			}
			if ip := strings.TrimSpace(xff); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// readBody enforces the §5 body cap before parsing.
//
// The cap is applied twice on purpose: Content-Length is checked so an
// announced-oversize body is refused without reading a byte, and MaxBytesReader
// bounds the actual read so a chunked body that lies about its length cannot
// get past it. "Do not buffer unbounded input" is the requirement.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, *apierr.E) {
	if r.ContentLength > protocol.MaxBodyBytes {
		return nil, apierr.New(apierr.PayloadTooLarge)
	}
	limited := http.MaxBytesReader(w, r.Body, protocol.MaxBodyBytes)
	body, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, apierr.New(apierr.PayloadTooLarge)
		}
		return nil, apierr.New(apierr.InvalidRequest)
	}
	return body, nil
}

// decodeJSON parses a request body.
//
// Unknown fields are tolerated here, unlike on the control channel: an HTTP
// field the service does not know is not covered by the signature and cannot
// influence anything, whereas rejecting it would break a client that adds a
// forward-compatible field. The control channel is strict precisely because
// there the unknown field is the attack (§7).
func decodeJSON(body []byte, v any) *apierr.E {
	if len(body) == 0 {
		return apierr.New(apierr.InvalidRequest)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return apierr.New(apierr.InvalidRequest)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) *apierr.E {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
	return nil
}

// authenticate applies the §4 envelope rules to a request.
//
// Order is deliberate, and it is a security property rather than a style choice:
//
//  1. IP ban first — a banned source must not reach the verifier at all.
//  2. Envelope shape — reject malformed hex before doing arithmetic on it.
//  3. Per-IP rate limit — charged BEFORE signature verification, because
//     verification is the most expensive path in the service and therefore the
//     cheapest thing to attack (§8).
//  4. Clock skew — cheap, and a stale request is not worth verifying.
//  5. Signature — a failure here is counted toward the IP's invalid-signature
//     ban.
//  6. Per-nodeId rate limit — charged only AFTER the signature verifies. A
//     nodeId is an unauthenticated claim until then, so charging it earlier
//     would let anyone exhaust a chosen victim's allowance by sending garbage
//     in their name. Both buckets are still enforced, as §8 requires; only the
//     order differs. If the node bucket refuses, the IP token taken in step 3
//     is refunded: the refusal must not tax the shared per-IP budget on behalf
//     of a request that was never accepted.
//  7. Nonce — consumed last, so a request rejected for any earlier reason does
//     not burn a nonce the caller may legitimately retry with.
func (s *Server) authenticate(op ratelimit.Op, env protocol.Envelope, signingInput []byte, ip string) *apierr.E {
	if sec := s.limiter.BannedFor(ip); sec > 0 {
		return apierr.RateLimit(sec)
	}
	if !wire.IsNodeID(env.NodeID) || len(env.SignPub) != 64 || !wire.IsLowerHex(env.SignPub) ||
		!wire.IsNonce(env.Nonce) || !wire.IsSig(env.Sig) {
		return apierr.New(apierr.InvalidRequest)
	}
	if ok, retry := s.limiter.Allow(op, "", ip); !ok {
		return apierr.RateLimit(retry)
	}
	now := s.clk.NowMs()
	if env.IssuedAt > now+protocol.ClockSkewMs || env.IssuedAt < now-protocol.ClockSkewMs {
		return apierr.New(apierr.StaleRequest)
	}
	if !wire.Verify(env.SignPub, signingInput, env.Sig) {
		s.limiter.RecordInvalidSignature(ip)
		return apierr.New(apierr.InvalidSignature)
	}
	if ok, retry := s.limiter.Allow(op, env.NodeID, ""); !ok {
		s.limiter.Refund(op, ip)
		return apierr.RateLimit(retry)
	}
	if !s.store.CheckAndUseNonce(env.NodeID, env.Nonce) {
		return apierr.New(apierr.ReplayedNonce)
	}
	return nil
}

// leaseIDLooksValid bounds an opaque leaseId before it is used as a map key.
func leaseIDLooksValid(id string) bool {
	return len(id) == 32 && wire.IsLowerHex(id)
}

// requestIDLooksValid bounds a requestId. §5.5 specifies UUID v4; the shape is
// checked but the version nibble is not, so a client that later moves to
// another UUID version does not need a service change to be accepted.
func requestIDLooksValid(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		isHex := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}

// ListenAndServe runs the service until the context is cancelled.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:              s.cfg.Addr,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the control channel is a long-lived upgrade and a
		// write deadline would sever it. Per-write deadlines are applied inside
		// the control package instead.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 16 << 10,
	}
	s.StartSweeper()
	defer s.Shutdown()

	errCh := make(chan error, 1)
	go func() {
		if s.cfg.TLSCertFile != "" && s.cfg.TLSKeyFile != "" {
			errCh <- srv.ListenAndServeTLS(s.cfg.TLSCertFile, s.cfg.TLSKeyFile)
			return
		}
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// parseInt64 is used for the X-Nex-Issued header.
func parseInt64(s string) (int64, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}
