// Package descriptor implements the two signed descriptor types of
// RENDEZVOUS_WIRE_V1 §3.
//
// The split between PublicDescriptor and ContactDescriptor is what makes V3 §11
// ("do not expose unrestricted connection details before the recipient has
// responded") enforceable rather than aspirational: search can only ever return
// the public view, which carries no transport candidates, no IP and no port.
package descriptor

import (
	"errors"
	"strconv"

	"nex.rendezvous/internal/handle"
	"nex.rendezvous/internal/wire"
)

// Version is the only protocol version accepted in v1.
const Version = 1

// Limits from §3.2. They apply to both descriptor types where the field exists.
const (
	MaxCapabilities = 12
	MaxCapLen       = 32
	MaxCandidates   = 6
	MaxHostLen      = 255
	MaxKindLen      = 32
	MinPort         = 1
	MaxPort         = 65535
)

// MaxDescriptorLifetimeMs is the §5.1 bound: expiresAt - issuedAt <= 300000.
const MaxDescriptorLifetimeMs = 300000

// ErrInvalid marks any descriptor that fails structural validation.
var ErrInvalid = errors.New("descriptor: invalid")

// ErrBadSignature marks a descriptor whose own signature does not verify.
var ErrBadSignature = errors.New("descriptor: signature does not verify")

// ErrExpired marks a descriptor that is already past expiresAt, or whose
// lifetime exceeds the §5.1 bound.
var ErrExpired = errors.New("descriptor: expired or over-long lifetime")

// Candidate is one transport candidate. Kind is deliberately a free string:
// §3.2 requires unknown kinds to be preserved on the service side rather than
// rejected, so a later candidate kind does not need a flag day.
type Candidate struct {
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

// SignInto appends this candidate's own length-prefixed fields to a signing
// input, per the §3.2 LPcand form:
//
//	LPcand(a) = uint32be(len(a)) || for each element: LP(kind) || LP(host) || LPn(port)
//
// There is no delimiter and therefore nothing an attacker-supplied kind or host
// can do to forge a field boundary.
func (c Candidate) SignInto(b *wire.Builder) {
	b.LP(c.Kind).LP(c.Host).LPn(int64(c.Port))
}

// Public is the descriptor returned by search (§3.1).
//
// No transport candidates. No IP address. No port. Search reveals that a handle
// is currently connectable and which identity claims it — nothing that lets a
// stranger dial.
type Public struct {
	V            int      `json:"v"`
	Handle       string   `json:"handle"`
	NodeID       string   `json:"nodeId"`
	SignPub      string   `json:"signPub"`
	Capabilities []string `json:"capabilities"`
	Connectable  bool     `json:"connectable"`
	IssuedAt     int64    `json:"issuedAt"`
	ExpiresAt    int64    `json:"expiresAt"`
	Sig          string   `json:"sig"`
}

// SigningInput builds the §3.1 signing input:
//
//	LP(v) LP(handle) LP(nodeId) LP(signPub) LParr(capabilities)
//	LPn(issuedAt) LPn(expiresAt) LP(connectable)
//
// v is signed as the string "1" and connectable as "true"/"false".
func (p *Public) SigningInput() []byte {
	return wire.NewBuilder(wire.DomainPublicDescriptor).
		LP(strconv.Itoa(p.V)).
		LP(p.Handle).
		LP(p.NodeID).
		LP(p.SignPub).
		LParr(p.Capabilities).
		LPn(p.IssuedAt).
		LPn(p.ExpiresAt).
		LPbool(p.Connectable).
		Bytes()
}

// Validate checks structure and then the descriptor's own signature.
//
// It does NOT prove that signPub belongs to nodeId. Nothing in this protocol
// establishes that link (§6) — the binding happens later, in the Noise
// handshake, when the dialing peer pins nodeId.
func (p *Public) Validate() error {
	if p == nil {
		return ErrInvalid
	}
	if err := validateCommon(p.V, p.Handle, p.NodeID, p.SignPub, p.Capabilities, p.Sig); err != nil {
		return err
	}
	if !wire.Verify(p.SignPub, p.SigningInput(), p.Sig) {
		return ErrBadSignature
	}
	return nil
}

// Contact is the descriptor released only after an accepted introduction (§3.2).
type Contact struct {
	V            int         `json:"v"`
	Handle       string      `json:"handle"`
	NodeID       string      `json:"nodeId"`
	SignPub      string      `json:"signPub"`
	NoisePub     string      `json:"noisePub"`
	Capabilities []string    `json:"capabilities"`
	Candidates   []Candidate `json:"candidates"`
	IssuedAt     int64       `json:"issuedAt"`
	ExpiresAt    int64       `json:"expiresAt"`
	Sig          string      `json:"sig"`
}

// SigningInput builds the §3.2 signing input:
//
//	LP(v) LP(handle) LP(nodeId) LP(signPub) LP(noisePub)
//	LParr(capabilities) LPcand(candidates) LPn(issuedAt) LPn(expiresAt)
//
// Candidates are signed in the exact array order sent.
func (c *Contact) SigningInput() []byte {
	b := wire.NewBuilder(wire.DomainContactDescriptor).
		LP(strconv.Itoa(c.V)).
		LP(c.Handle).
		LP(c.NodeID).
		LP(c.SignPub).
		LP(c.NoisePub).
		LParr(c.Capabilities).
		Count(len(c.Candidates))
	for _, cand := range c.Candidates {
		cand.SignInto(b)
	}
	return b.LPn(c.IssuedAt).LPn(c.ExpiresAt).Bytes()
}

// Validate checks structure, candidate limits, and then the signature.
func (c *Contact) Validate() error {
	if c == nil {
		return ErrInvalid
	}
	if err := validateCommon(c.V, c.Handle, c.NodeID, c.SignPub, c.Capabilities, c.Sig); err != nil {
		return err
	}
	if !wire.IsNoisePub(c.NoisePub) {
		return ErrInvalid
	}
	if len(c.Candidates) > MaxCandidates {
		return ErrInvalid
	}
	for _, cand := range c.Candidates {
		if err := validateCandidate(cand); err != nil {
			return err
		}
	}
	if !wire.Verify(c.SignPub, c.SigningInput(), c.Sig) {
		return ErrBadSignature
	}
	return nil
}

// validateCandidate applies the §3.2 limits. The kind is not checked against a
// whitelist: §3.2 requires unknown kinds to be preserved, not rejected, so a
// later candidate kind does not need a flag day.
//
// There is deliberately no delimiter-escaping rule here. Under LPcand each
// candidate field carries its own length prefix, so no kind or host value can
// forge a field boundary — the ambiguity is designed out rather than validated
// against (contract §3.2, Amendment 1).
func validateCandidate(c Candidate) error {
	if c.Kind == "" || len(c.Kind) > MaxKindLen {
		return ErrInvalid
	}
	if c.Host == "" || len(c.Host) > MaxHostLen {
		return ErrInvalid
	}
	if c.Port < MinPort || c.Port > MaxPort {
		return ErrInvalid
	}
	return nil
}

func validateCommon(v int, h, nodeID, signPub string, caps []string, sig string) error {
	if v != Version {
		return ErrInvalid
	}
	// The handle must already be in normalized form. The service re-normalizes
	// and compares rather than repairing: §2 forbids silent rewriting.
	norm, err := handle.Normalize(h)
	if err != nil || norm != h {
		return ErrInvalid
	}
	if !wire.IsNodeID(nodeID) {
		return ErrInvalid
	}
	if len(signPub) != 64 || !wire.IsLowerHex(signPub) {
		return ErrInvalid
	}
	if !wire.IsSig(sig) {
		return ErrInvalid
	}
	if len(caps) > MaxCapabilities {
		return ErrInvalid
	}
	for _, c := range caps {
		if !validCapability(c) {
			return ErrInvalid
		}
	}
	return nil
}

// validCapability enforces "at most 12 capabilities, each <= 32 bytes matching
// ^[a-z0-9-]+$" (§3.2).
func validCapability(c string) bool {
	if c == "" || len(c) > MaxCapLen {
		return false
	}
	for i := 0; i < len(c); i++ {
		b := c[i]
		if (b < 'a' || b > 'z') && (b < '0' || b > '9') && b != '-' {
			return false
		}
	}
	return true
}

// CheckLifetime applies the §5.1 freshness rules that register and refresh run
// on both descriptors: expiresAt > now, and expiresAt - issuedAt <= 300000.
func CheckLifetime(issuedAt, expiresAt, nowMs int64) error {
	if expiresAt <= nowMs {
		return ErrExpired
	}
	if expiresAt < issuedAt {
		return ErrExpired
	}
	if expiresAt-issuedAt > MaxDescriptorLifetimeMs {
		return ErrExpired
	}
	return nil
}
