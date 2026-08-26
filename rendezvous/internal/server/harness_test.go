package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/clock"
	"nex.rendezvous/internal/descriptor"
	"nex.rendezvous/internal/protocol"
	"nex.rendezvous/internal/wire"
)

// identity is a test node. It derives its rendezvous signing key exactly the
// way the client does (contract §1.3), so the tests exercise the real
// derivation rather than a convenient shortcut.
type identity struct {
	seed    []byte
	nodeID  string
	signPub string
	priv    ed25519.PrivateKey
}

func newIdentity(name string) *identity {
	seed := sha256.Sum256([]byte("nex-rendezvous-test-identity:" + name))
	nodeID := sha256.Sum256(seed[:])
	priv := deriveForTest(seed[:])
	return &identity{
		seed:    seed[:],
		nodeID:  strings.ToUpper(hex.EncodeToString(nodeID[:])),
		signPub: hex.EncodeToString(priv.Public().(ed25519.PublicKey)),
		priv:    priv,
	}
}

func (i *identity) sign(msg []byte) string {
	return hex.EncodeToString(ed25519.Sign(i.priv, msg))
}

// noisePub is a stand-in X25519 static key. The service only ever checks its
// shape: it is carried for future pre-pinning, and v1 clients pin on nodeId.
func (i *identity) noisePub() string {
	h := sha256.Sum256(append([]byte("noise:"), i.seed...))
	return hex.EncodeToString(h[:])
}

var nonceCounter int

func nextNonce() string {
	nonceCounter++
	return fmt.Sprintf("%032x", nonceCounter)
}

func (i *identity) publicDesc(h string, now int64) *descriptor.Public {
	d := &descriptor.Public{
		V: descriptor.Version, Handle: h, NodeID: i.nodeID, SignPub: i.signPub,
		Capabilities: []string{"chat", "rooms"}, Connectable: true,
		IssuedAt: now, ExpiresAt: now + 90000,
	}
	d.Sig = i.sign(d.SigningInput())
	return d
}

func (i *identity) contactDesc(h string, now int64) *descriptor.Contact {
	d := &descriptor.Contact{
		V: descriptor.Version, Handle: h, NodeID: i.nodeID, SignPub: i.signPub,
		NoisePub:     i.noisePub(),
		Capabilities: []string{"chat", "rooms"},
		Candidates:   []descriptor.Candidate{{Kind: "direct-tcp", Host: "203.0.113.9", Port: 42001}},
		IssuedAt:     now, ExpiresAt: now + 90000,
	}
	d.Sig = i.sign(d.SigningInput())
	return d
}

// harness is a server plus a fake clock.
type harness struct {
	t   *testing.T
	srv *Server
	clk *clock.Fake
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	clk := clock.NewFake()
	cfg := DefaultConfig()
	srv := New(cfg, clk, NewDiscardLogger())
	t.Cleanup(srv.Shutdown)
	return &harness{t: t, srv: srv, clk: clk}
}

func (h *harness) now() int64 { return h.clk.NowMs() }

// do issues a request and returns the recorder.
func (h *harness) do(method, target string, body any, headers map[string]string) *httptest.ResponseRecorder {
	h.t.Helper()
	var r *http.Request
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			h.t.Fatalf("marshal: %v", err)
		}
		r = httptest.NewRequest(method, target, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	r.RemoteAddr = "198.51.100.7:5555"
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.srv.Handler().ServeHTTP(w, r)
	return w
}

// errCode extracts the §5.9 error code from a response body.
func errCode(t *testing.T, w *httptest.ResponseRecorder) apierr.Code {
	t.Helper()
	var e apierr.Error
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatalf("response was not a §5.9 error envelope: %q", w.Body.String())
	}
	return e.Error.Code
}

// register performs a full §5.1 registration and returns the response.
func (h *harness) register(id *identity, handle string) *httptest.ResponseRecorder {
	h.t.Helper()
	now := h.now()
	req := protocol.RegisterRequest{
		NodeID: id.nodeID, SignPub: id.signPub, IssuedAt: now, Nonce: nextNonce(),
		Handle:            handle,
		PublicDescriptor:  id.publicDesc(handle, now),
		ContactDescriptor: id.contactDesc(handle, now),
	}
	req.Sig = id.sign(req.SigningInput())
	return h.do(http.MethodPost, "/v1/presence/register", req, nil)
}

func (h *harness) mustRegister(id *identity, handle string) protocol.RegisterResponse {
	h.t.Helper()
	w := h.register(id, handle)
	if w.Code != http.StatusOK {
		h.t.Fatalf("register(%s) = %d %s", handle, w.Code, w.Body.String())
	}
	var resp protocol.RegisterResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		h.t.Fatalf("register response: %v", err)
	}
	return resp
}

// searchHeaders builds the §5.4 X-Nex-* envelope.
func (h *harness) searchHeaders(id *identity, handle string) map[string]string {
	now := h.now()
	nonce := nextNonce()
	sig := id.sign(protocol.SearchSigningInput(id.nodeID, id.signPub, now, nonce, handle))
	return map[string]string{
		protocol.HeaderNode:   id.nodeID,
		protocol.HeaderKey:    id.signPub,
		protocol.HeaderIssued: strconv.FormatInt(now, 10),
		protocol.HeaderNonce:  nonce,
		protocol.HeaderSig:    sig,
	}
}

func (h *harness) search(id *identity, handle string) *httptest.ResponseRecorder {
	h.t.Helper()
	return h.do(http.MethodGet, "/v1/discovery/search?handle="+handle, nil, h.searchHeaders(id, handle))
}

// deriveForTest mirrors contract §1.3 so the harness signs the way a client does.
func deriveForTest(seed []byte) ed25519.PrivateKey {
	return wire.DeriveSigningKey(seed)
}
