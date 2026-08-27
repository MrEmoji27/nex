// Package protocol holds the request/response shapes of RENDEZVOUS_WIRE_V1 §5
// and §7, together with the signing input for every operation.
//
// Both the service and the test client build signing inputs from this one place.
// That is deliberate: the framing rules in §1.4 are the part of the contract
// most likely to drift, and a second hand-rolled copy inside the tests would
// only prove that the copy agrees with itself.
package protocol

import (
	"nex.rendezvous/internal/descriptor"
	"nex.rendezvous/internal/wire"
)

// MaxBodyBytes is the §5 hard limit on a request body. Measured before parsing.
const MaxBodyBytes = 8192

// MaxFrameBytes is the §7 cap on a WebSocket frame.
const MaxFrameBytes = 8192

// ClockSkewMs is the §4 freshness window: issuedAt must be within ±120000 ms of
// server time.
const ClockSkewMs = 120000

// NonceTTLMs is the §4 replay window: the service keeps nonces for 300 s.
const NonceTTLMs = 300000

// MaxIntroductionLifetimeMs is the §5.5 bound on expiresAt - issuedAt.
const MaxIntroductionLifetimeMs = 120000

// Header names used by the two GET-shaped authenticated endpoints (§5.4, §7).
const (
	HeaderNode   = "X-Nex-Node"
	HeaderKey    = "X-Nex-Key"
	HeaderIssued = "X-Nex-Issued"
	HeaderNonce  = "X-Nex-Nonce"
	HeaderSig    = "X-Nex-Sig"
	HeaderLease  = "X-Nex-Lease"
)

// Envelope is the set of fields every signed request body carries (§4).
//
// There are no bearer tokens, no cookies, and no server-issued secrets beyond an
// opaque leaseId.
type Envelope struct {
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	IssuedAt int64  `json:"issuedAt"`
	Nonce    string `json:"nonce"`
	Sig      string `json:"sig"`
}

// RegisterRequest is the §5.1 body.
type RegisterRequest struct {
	NodeID            string              `json:"nodeId"`
	SignPub           string              `json:"signPub"`
	IssuedAt          int64               `json:"issuedAt"`
	Nonce             string              `json:"nonce"`
	Handle            string              `json:"handle"`
	PublicDescriptor  *descriptor.Public  `json:"publicDescriptor"`
	ContactDescriptor *descriptor.Contact `json:"contactDescriptor"`
	Sig               string              `json:"sig"`
}

// Envelope extracts the common fields.
func (r *RegisterRequest) Envelope() Envelope {
	return Envelope{r.NodeID, r.SignPub, r.IssuedAt, r.Nonce, r.Sig}
}

// SigningInput builds the §5.1 input:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(handle)
//	LP(publicDescriptor.sig) LP(contactDescriptor.sig)
//
// Binding both inner signatures into the outer one means a register request
// cannot be replayed with a swapped descriptor.
func (r *RegisterRequest) SigningInput() []byte {
	var pubSig, contactSig string
	if r.PublicDescriptor != nil {
		pubSig = r.PublicDescriptor.Sig
	}
	if r.ContactDescriptor != nil {
		contactSig = r.ContactDescriptor.Sig
	}
	return wire.NewBuilder(wire.DomainRegister).
		LP(r.NodeID).
		LP(r.SignPub).
		LPn(r.IssuedAt).
		LP(r.Nonce).
		LP(r.Handle).
		LP(pubSig).
		LP(contactSig).
		Bytes()
}

// RegisterResponse is the §5.1 200 body.
type RegisterResponse struct {
	LeaseID        string `json:"leaseId"`
	Handle         string `json:"handle"`
	ExpiresAt      int64  `json:"expiresAt"`
	RefreshAfterMs int64  `json:"refreshAfterMs"`
}

// RefreshRequest is the §5.2 body.
//
// Both descriptors are mandatory and must be freshly signed. There is no
// descriptor-less refresh (§5.2, Amendment 3): the optional form existed only
// for "address changed" roaming, and it left the lease expiry undefined for
// every other case.
type RefreshRequest struct {
	NodeID            string              `json:"nodeId"`
	SignPub           string              `json:"signPub"`
	IssuedAt          int64               `json:"issuedAt"`
	Nonce             string              `json:"nonce"`
	LeaseID           string              `json:"leaseId"`
	PublicDescriptor  *descriptor.Public  `json:"publicDescriptor"`
	ContactDescriptor *descriptor.Contact `json:"contactDescriptor"`
	Sig               string              `json:"sig"`
}

// Envelope extracts the common fields.
func (r *RefreshRequest) Envelope() Envelope {
	return Envelope{r.NodeID, r.SignPub, r.IssuedAt, r.Nonce, r.Sig}
}

// SigningInput builds the §5.2 input, which is now fixed-shape:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(leaseId)
//	LP(publicDescriptor.sig) LP(contactDescriptor.sig)
//
// Both slots are always present. A missing descriptor signs the empty string
// and will not verify against a correctly built client request, which is the
// intended outcome: refresh without descriptors is not a request shape any more.
func (r *RefreshRequest) SigningInput() []byte {
	var pubSig, contactSig string
	if r.PublicDescriptor != nil {
		pubSig = r.PublicDescriptor.Sig
	}
	if r.ContactDescriptor != nil {
		contactSig = r.ContactDescriptor.Sig
	}
	return wire.NewBuilder(wire.DomainRefresh).
		LP(r.NodeID).
		LP(r.SignPub).
		LPn(r.IssuedAt).
		LP(r.Nonce).
		LP(r.LeaseID).
		LP(pubSig).
		LP(contactSig).
		Bytes()
}

// RefreshResponse is the §5.2 200 body.
type RefreshResponse struct {
	ExpiresAt      int64 `json:"expiresAt"`
	RefreshAfterMs int64 `json:"refreshAfterMs"`
}

// UnregisterRequest is the §5.3 body.
type UnregisterRequest struct {
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	IssuedAt int64  `json:"issuedAt"`
	Nonce    string `json:"nonce"`
	LeaseID  string `json:"leaseId"`
	Sig      string `json:"sig"`
}

// Envelope extracts the common fields.
func (r *UnregisterRequest) Envelope() Envelope {
	return Envelope{r.NodeID, r.SignPub, r.IssuedAt, r.Nonce, r.Sig}
}

// SigningInput builds the §5.3 input:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(leaseId)
func (r *UnregisterRequest) SigningInput() []byte {
	return wire.NewBuilder(wire.DomainUnregister).
		LP(r.NodeID).
		LP(r.SignPub).
		LPn(r.IssuedAt).
		LP(r.Nonce).
		LP(r.LeaseID).
		Bytes()
}

// SearchSigningInput builds the §5.4 input. Search has no body, so the envelope
// travels in X-Nex-* headers.
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(handle)
func SearchSigningInput(nodeID, signPub string, issuedAt int64, nonce, handle string) []byte {
	return wire.NewBuilder(wire.DomainSearch).
		LP(nodeID).
		LP(signPub).
		LPn(issuedAt).
		LP(nonce).
		LP(handle).
		Bytes()
}

// SearchResponse is the §5.4 200 body. A miss is result:null with 200 — never a
// 404. The status code must not be an existence oracle.
//
// Pad brings every response to exactly SearchResponseBytes so response LENGTH is
// not an oracle either (§5.4 as amended). It carries no meaning, is not signed,
// and clients must ignore it.
type SearchResponse struct {
	Result *descriptor.Public `json:"result"`
	Pad    string             `json:"_pad"`
}

// SearchResponseBytes is the fixed serialized size of every 200 from
// /v1/discovery/search. A worst-case PublicDescriptor under the §3 limits
// serializes to 859 bytes, so this leaves headroom without being wasteful.
const SearchResponseBytes = 1024

// MaxPublicDescriptorBytes bounds a registered public descriptor so the padding
// budget above stays satisfiable. §3's field limits already keep a conforming
// descriptor under this, so it rejects nothing a correct node can produce.
const MaxPublicDescriptorBytes = 896

// IntroductionRequest is the §5.5 body.
//
// The requester ships their own contact descriptor with the request. That is
// deliberate consent: to ask for an introduction is to offer your own address.
// The target's contact descriptor is not returned here.
type IntroductionRequest struct {
	NodeID       string `json:"nodeId"`
	SignPub      string `json:"signPub"`
	IssuedAt     int64  `json:"issuedAt"`
	Nonce        string `json:"nonce"`
	RequestID    string `json:"requestId"`
	TargetHandle string `json:"targetHandle"`
	FromHandle   string `json:"fromHandle"`
	// Public already, and the recipient needs it to seal a reply back.
	FromSignPub string `json:"fromSignPub"`
	// Opaque here by design: the requester's address, sealed to the target.
	// This service holds no key that opens it, which is the point.
	SealedContact string `json:"sealedContact"`
	ExpiresAt     int64  `json:"expiresAt"`
	Sig           string `json:"sig"`
}

// Envelope extracts the common fields.
func (r *IntroductionRequest) Envelope() Envelope {
	return Envelope{r.NodeID, r.SignPub, r.IssuedAt, r.Nonce, r.Sig}
}

// SigningInput builds the §5.5 input:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(requestId)
//	LP(targetHandle) LP(fromHandle) LP(fromSignPub) LP(sealedContact) LPn(expiresAt)
//
// The sealed blob is signed, not a field inside it: the service cannot open the
// blob, so signing the ciphertext is what binds the address to its sender.
func (r *IntroductionRequest) SigningInput() []byte {
	return wire.NewBuilder(wire.DomainIntroRequest).
		LP(r.NodeID).
		LP(r.SignPub).
		LPn(r.IssuedAt).
		LP(r.Nonce).
		LP(r.RequestID).
		LP(r.TargetHandle).
		LP(r.FromHandle).
		LP(r.FromSignPub).
		LP(r.SealedContact).
		LPn(r.ExpiresAt).
		Bytes()
}

// IntroductionRequestResponse is the §5.5 202 body.
type IntroductionRequestResponse struct {
	RequestID string `json:"requestId"`
	ExpiresAt int64  `json:"expiresAt"`
}

// IntroductionRespond is the §5.6 body.
//
// accept:true must carry contactDescriptor; accept:false must not — omit the
// field entirely and sign the empty string in its slot.
type IntroductionRespond struct {
	NodeID    string `json:"nodeId"`
	SignPub   string `json:"signPub"`
	IssuedAt  int64  `json:"issuedAt"`
	Nonce     string `json:"nonce"`
	RequestID string `json:"requestId"`
	Accept    bool   `json:"accept"`
	// Opaque: the responder's address, sealed to the requester.
	SealedContact string `json:"sealedContact,omitempty"`
	Sig           string `json:"sig"`
}

// Envelope extracts the common fields.
func (r *IntroductionRespond) Envelope() Envelope {
	return Envelope{r.NodeID, r.SignPub, r.IssuedAt, r.Nonce, r.Sig}
}

// SigningInput builds the §5.6 input:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(requestId)
//	LP(accept) LP(sealedContact or "")
func (r *IntroductionRespond) SigningInput() []byte {
	contactSig := r.SealedContact
	return wire.NewBuilder(wire.DomainIntroRespond).
		LP(r.NodeID).
		LP(r.SignPub).
		LPn(r.IssuedAt).
		LP(r.Nonce).
		LP(r.RequestID).
		LPbool(r.Accept).
		LP(contactSig).
		Bytes()
}

// IntroductionRespondResponse is the §5.6 200 body.
type IntroductionRespondResponse struct {
	OK bool `json:"ok"`
}

// ControlSigningInput builds the §7 input for the WebSocket upgrade:
//
//	LP(nodeId) LP(signPub) LPn(issuedAt) LP(nonce) LP(leaseId)
func ControlSigningInput(nodeID, signPub string, issuedAt int64, nonce, leaseID string) []byte {
	return wire.NewBuilder(wire.DomainControl).
		LP(nodeID).
		LP(signPub).
		LPn(issuedAt).
		LP(nonce).
		LP(leaseID).
		Bytes()
}

// StatusResponse is the §5.7 body. Unauthenticated.
type StatusResponse struct {
	Version    string            `json:"version"`
	UptimeSec  int64             `json:"uptimeSec"`
	Components map[string]string `json:"components"`
}

// Component health values (§5.7).
const (
	Operational = "operational"
	Degraded    = "degraded"
	Down        = "down"
)

// MetricsResponse is the §5.8 body. Both counts are bucketed; see store.Bucket.
type MetricsResponse struct {
	NodesConnected   int   `json:"nodesConnected"`
	NodesConnectable int   `json:"nodesConnectable"`
	SampledAt        int64 `json:"sampledAt"`
}

// Control-channel frame types (§7).
const (
	FrameIntroductionRequest  = "introduction.request"
	FrameIntroductionResponse = "introduction.response"
	FrameLeaseExpiring        = "lease.expiring"
	FramePong                 = "pong"
	FramePing                 = "ping"
)

// IntroductionRequestFrame is a server -> client frame (§7).
type IntroductionRequestFrame struct {
	Type       string `json:"type"`
	RequestID  string `json:"requestId"`
	FromHandle string `json:"fromHandle"`
	// Public already, and the recipient needs it to seal a reply back.
	FromSignPub string `json:"fromSignPub"`
	// Opaque here by design: the requester's address, sealed to the target.
	// This service holds no key that opens it, which is the point.
	SealedContact string `json:"sealedContact"`
	ExpiresAt     int64  `json:"expiresAt"`
}

// IntroductionResponseFrame is a server -> client frame (§7).
type IntroductionResponseFrame struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
	Accept    bool   `json:"accept"`
	// Opaque: the responder's address, sealed to the requester.
	SealedContact string `json:"sealedContact,omitempty"`
}

// LeaseExpiringFrame is a server -> client frame (§7), sent once at
// expiresAt - 30000 ms.
type LeaseExpiringFrame struct {
	Type      string `json:"type"`
	ExpiresAt int64  `json:"expiresAt"`
}

// PongFrame is a server -> client frame (§7).
type PongFrame struct {
	Type string `json:"type"`
	T    int64  `json:"t"`
}

// ClientFrame is the ONLY shape the server will accept from a client.
//
// It has exactly two fields and no payload field of any kind. This is the
// structural guarantee of §7 / V3 §25: there is no frame type that carries
// content, so the control channel cannot become a message transport. Decoding
// rejects unknown fields, so a client cannot smuggle a body past it either.
type ClientFrame struct {
	Type string `json:"type"`
	T    int64  `json:"t"`
}
