// Package conformance asserts the Go service against the frozen
// cross-implementation vectors in rendezvous/testdata/vectors.json.
//
// That file is the source of truth, not this package and not the TypeScript
// client. The vectors were produced by two implementations written
// independently against the contract and confirmed to agree byte for byte; both
// sides now assert against the recorded result, so a later divergence fails a
// test rather than surfacing as an interop bug nobody can reproduce.
//
// V3 §15: passing only against the other Nex implementation proves they share a
// bug. These vectors are checked in precisely so neither side can drift alone.
//
// If a test here fails, the implementation changed. Fix the code, not the file.
package conformance

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"nex.rendezvous/internal/descriptor"
	"nex.rendezvous/internal/wire"
)

type candidate struct {
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

type vectors struct {
	IdentitySeedHex        string `json:"identitySeedHex"`
	SignKeyDerivationLabel string `json:"signKeyDerivationLabel"`
	SignPub                string `json:"signPub"`

	PublicDescriptor struct {
		V               int      `json:"v"`
		Handle          string   `json:"handle"`
		NodeID          string   `json:"nodeId"`
		SignPub         string   `json:"signPub"`
		Capabilities    []string `json:"capabilities"`
		Connectable     bool     `json:"connectable"`
		IssuedAt        int64    `json:"issuedAt"`
		ExpiresAt       int64    `json:"expiresAt"`
		SigningInputHex string   `json:"signingInputHex"`
		SignatureHex    string   `json:"signatureHex"`
	} `json:"publicDescriptor"`

	ContactDescriptor struct {
		V               int         `json:"v"`
		Handle          string      `json:"handle"`
		NodeID          string      `json:"nodeId"`
		SignPub         string      `json:"signPub"`
		NoisePub        string      `json:"noisePub"`
		Capabilities    []string    `json:"capabilities"`
		Candidates      []candidate `json:"candidates"`
		IssuedAt        int64       `json:"issuedAt"`
		ExpiresAt       int64       `json:"expiresAt"`
		SigningInputHex string      `json:"signingInputHex"`
		SignatureHex    string      `json:"signatureHex"`
	} `json:"contactDescriptor"`

	ContactDescriptorCollision struct {
		Candidates      []candidate `json:"candidates"`
		SigningInputHex string      `json:"signingInputHex"`
	} `json:"contactDescriptorCollision"`
}

func load(t *testing.T) vectors {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return v
}

func toCandidates(in []candidate) []descriptor.Candidate {
	out := make([]descriptor.Candidate, 0, len(in))
	for _, c := range in {
		out = append(out, descriptor.Candidate{Kind: c.Kind, Host: c.Host, Port: c.Port})
	}
	return out
}

func (v vectors) public() *descriptor.Public {
	d := v.PublicDescriptor
	return &descriptor.Public{
		V: d.V, Handle: d.Handle, NodeID: d.NodeID, SignPub: d.SignPub,
		Capabilities: d.Capabilities, Connectable: d.Connectable,
		IssuedAt: d.IssuedAt, ExpiresAt: d.ExpiresAt,
	}
}

func (v vectors) contact(cands []candidate) *descriptor.Contact {
	d := v.ContactDescriptor
	return &descriptor.Contact{
		V: d.V, Handle: d.Handle, NodeID: d.NodeID, SignPub: d.SignPub, NoisePub: d.NoisePub,
		Capabilities: d.Capabilities, Candidates: toCandidates(cands),
		IssuedAt: d.IssuedAt, ExpiresAt: d.ExpiresAt,
	}
}

func mustSeed(t *testing.T, h string) []byte {
	t.Helper()
	b, err := hex.DecodeString(h)
	if err != nil {
		t.Fatalf("bad seed hex: %v", err)
	}
	return b
}

func TestDerivedSigningKeyMatches(t *testing.T) {
	v := load(t)
	priv := wire.DeriveSigningKey(mustSeed(t, v.IdentitySeedHex))
	got := hex.EncodeToString(priv.Public().(ed25519.PublicKey))
	if got != v.SignPub {
		t.Fatalf("signPub mismatch:\n got %s\nwant %s", got, v.SignPub)
	}
}

func TestDerivationLabelHasNotDrifted(t *testing.T) {
	v := load(t)
	// A silent label change would rotate every node's rendezvous identity and
	// look exactly like a service-side outage rather than a code change.
	if wire.SignKeyDerivationLabel != v.SignKeyDerivationLabel {
		t.Fatalf("derivation label drifted: %q, vectors say %q",
			wire.SignKeyDerivationLabel, v.SignKeyDerivationLabel)
	}
}

func TestPublicDescriptorSigningInputMatches(t *testing.T) {
	v := load(t)
	got := hex.EncodeToString(v.public().SigningInput())
	if got != v.PublicDescriptor.SigningInputHex {
		t.Fatalf("public signing input mismatch:\n got %s\nwant %s", got, v.PublicDescriptor.SigningInputHex)
	}
}

func TestPublicDescriptorSignatureMatches(t *testing.T) {
	v := load(t)
	priv := wire.DeriveSigningKey(mustSeed(t, v.IdentitySeedHex))
	got := hex.EncodeToString(ed25519.Sign(priv, v.public().SigningInput()))
	if got != v.PublicDescriptor.SignatureHex {
		t.Fatalf("public signature mismatch:\n got %s\nwant %s", got, v.PublicDescriptor.SignatureHex)
	}
}

func TestContactDescriptorSigningInputMatches(t *testing.T) {
	v := load(t)
	// The second candidate deliberately contains a pipe in both kind and host.
	got := hex.EncodeToString(v.contact(v.ContactDescriptor.Candidates).SigningInput())
	if got != v.ContactDescriptor.SigningInputHex {
		t.Fatalf("contact signing input mismatch:\n got %s\nwant %s", got, v.ContactDescriptor.SigningInputHex)
	}
}

func TestContactDescriptorSignatureMatches(t *testing.T) {
	v := load(t)
	priv := wire.DeriveSigningKey(mustSeed(t, v.IdentitySeedHex))
	got := hex.EncodeToString(ed25519.Sign(priv, v.contact(v.ContactDescriptor.Candidates).SigningInput()))
	if got != v.ContactDescriptor.SignatureHex {
		t.Fatalf("contact signature mismatch:\n got %s\nwant %s", got, v.ContactDescriptor.SignatureHex)
	}
}

func TestRecordedSignaturesVerify(t *testing.T) {
	v := load(t)
	pub, err := hex.DecodeString(v.SignPub)
	if err != nil {
		t.Fatalf("bad signPub hex: %v", err)
	}
	for _, tc := range []struct {
		name  string
		input []byte
		sig   string
	}{
		{"public", v.public().SigningInput(), v.PublicDescriptor.SignatureHex},
		{"contact", v.contact(v.ContactDescriptor.Candidates).SigningInput(), v.ContactDescriptor.SignatureHex},
	} {
		sig, err := hex.DecodeString(tc.sig)
		if err != nil {
			t.Fatalf("%s: bad signature hex: %v", tc.name, err)
		}
		if !ed25519.Verify(ed25519.PublicKey(pub), tc.input, sig) {
			t.Fatalf("%s: recorded signature does not verify", tc.name)
		}
	}
}

// TestAmendment1NoCandidateCollision is the regression guard for the signature
// malleability that Amendment 1 removed. Under the pre-amendment
// kind-pipe-host-pipe-port flattening these two candidate arrays produced
// identical signing input; under LPcand every field carries its own length
// prefix, so nothing a host or kind contains can forge a boundary.
func TestAmendment1NoCandidateCollision(t *testing.T) {
	v := load(t)
	a := v.contact(v.ContactDescriptor.Candidates).SigningInput()
	b := v.contact(v.ContactDescriptorCollision.Candidates).SigningInput()

	if bytes.Equal(a, b) {
		t.Fatal("candidate signing is malleable: two different candidate arrays produced identical signing input")
	}
	if got := hex.EncodeToString(b); got != v.ContactDescriptorCollision.SigningInputHex {
		t.Fatalf("collision-probe signing input mismatch:\n got %s\nwant %s", got, v.ContactDescriptorCollision.SigningInputHex)
	}
}

func TestSignatureDoesNotCarryAcrossCandidateSplits(t *testing.T) {
	v := load(t)
	priv := wire.DeriveSigningKey(mustSeed(t, v.IdentitySeedHex))
	sig := ed25519.Sign(priv, v.contact(v.ContactDescriptor.Candidates).SigningInput())
	other := v.contact(v.ContactDescriptorCollision.Candidates).SigningInput()

	if ed25519.Verify(priv.Public().(ed25519.PublicKey), other, sig) {
		t.Fatal("a signature over one candidate split verified over a different one")
	}
}
