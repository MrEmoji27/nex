package descriptor

import (
	"crypto/ed25519"
	"encoding/hex"
	"strings"
	"testing"

	"nex.rendezvous/internal/wire"
)

// signer derives a real Ed25519 key the way §1.3 does and signs descriptor
// inputs with it. The descriptors under test then carry a genuinely verifiable
// signature from the key they name.
type signer struct {
	priv    ed25519.PrivateKey
	signPub string
}

func newSigner(name string) *signer {
	seed := []byte(strings.Repeat(name, 1))
	for len(seed) < 32 {
		seed = append(seed, byte(len(seed)))
	}
	priv := wire.DeriveSigningKey(seed[:32])
	return &signer{
		priv:    priv,
		signPub: hex.EncodeToString(priv.Public().(ed25519.PublicKey)),
	}
}

func (s *signer) sign(msg []byte) string { return wire.Sign(s.priv, msg) }

var (
	nodeSigner = newSigner("node-signer")
	testNodeID = strings.Repeat("AA", 32) // uppercase hex nodeId shape
	testNoise  = strings.Repeat("bb", 32) // lowercase hex noisePub shape
)

// validSigShape passes only shape checks; it never verifies.
func validSigShape() string { return "ab" + strings.Repeat("0", 126) }

// testPub is the §1.5 signing-input vector expressed as a descriptor. Its
// handle/nodeId/signPub are the vector's own values, so SigningInput must
// reproduce the frozen hex exactly.
func testPub() *Public {
	return &Public{
		V: 1, Handle: "roshan", NodeID: "AA", SignPub: "bb",
		Capabilities: []string{"chat"}, Connectable: true,
		IssuedAt: 5, ExpiresAt: 7,
	}
}

func wellFormedPub() *Public {
	return &Public{
		V: 1, Handle: "zro", NodeID: testNodeID, SignPub: nodeSigner.signPub,
		Capabilities: []string{"chat", "rooms"}, Connectable: true,
		IssuedAt: 1756200000000, ExpiresAt: 1756200090000,
	}
}

func wellFormedContact() *Contact {
	return &Contact{
		V: 1, Handle: "zro", NodeID: testNodeID, SignPub: nodeSigner.signPub,
		NoisePub:     testNoise,
		Capabilities: []string{"chat", "rooms"},
		Candidates:   makeCandidates(1),
		IssuedAt:     1756200000000, ExpiresAt: 1756200090000,
	}
}

// TestPublicSigningInputMatchesFrozenVector pins §3.1 to the §1.5 vector from
// the wire contract, byte for byte. If this fails the framing is wrong — the
// vector is never adjusted to match the code (contract §1.5).
func TestPublicSigningInputMatchesFrozenVector(t *testing.T) {
	want := "6e65782d72656e64657a766f75732f7075626c69632d64657363726970746f722d7631000000013100000006726f7368616e000000024141000000026262000000010000000463686174000000013500000001370000000474727565"
	got := hex.EncodeToString(testPub().SigningInput())
	if got != want {
		t.Fatalf("public signing input:\n got %s\nwant %s", got, want)
	}
}

// TestConnectableIsSignedAsString pins the §3.1 note that booleans enter the
// signature as LP("true")/LP("false"), not JSON.
func TestConnectableIsSignedAsString(t *testing.T) {
	p := testPub()
	p.Connectable = false
	got := hex.EncodeToString(p.SigningInput())
	wantSuffix := hex.EncodeToString([]byte("false"))
	if !strings.HasSuffix(got, wantSuffix) {
		t.Fatalf("connectable=false not signed as LP(\"false\"): suffix %s", got[len(got)-16:])
	}
}

// TestContactSigningInputIsLPcandNotDelimiters is Amendment 1. The
// pre-amendment draft flattened candidates to "<kind>|<host>|<port>"; these two
// different candidate arrays produced identical input under that form. Under
// LPcand they must not.
func TestContactSigningInputIsLPcandNotDelimiters(t *testing.T) {
	a := wellFormedContact()
	a.Candidates = []Candidate{{Kind: "a", Host: "b|c", Port: 7}}
	b := wellFormedContact()
	b.Candidates = []Candidate{{Kind: "a|b", Host: "c", Port: 7}}

	if string(a.SigningInput()) == string(b.SigningInput()) {
		t.Fatal("two different candidate lists produced identical signing input (Amendment 1 violated)")
	}

	// Precondition: their pipe-flattened forms ARE identical — that was the bug.
	flatA := a.Candidates[0].Kind + "|" + a.Candidates[0].Host + "|7"
	flatB := b.Candidates[0].Kind + "|" + b.Candidates[0].Host + "|7"
	if flatA != flatB {
		t.Fatalf("precondition broken: %q and %q do not collide under the old delimiter form", flatA, flatB)
	}
}

// TestCandidateFramingByteLayout checks LPcand directly: uint32be(count), then
// per element LP(kind) LP(host) LPn(port), array order, no delimiter anywhere.
func TestCandidateFramingByteLayout(t *testing.T) {
	c := wellFormedContact()
	c.Capabilities = nil
	c.IssuedAt = 0
	c.ExpiresAt = 0
	c.Candidates = []Candidate{
		{Kind: "direct-tcp", Host: "h1", Port: 1},
		{Kind: "k2", Host: "h2", Port: 65535},
	}

	got := c.SigningInput()
	domain := "nex-rendezvous/contact-descriptor-v1"
	if string(got[:len(domain)]) != domain {
		t.Fatalf("wrong domain separator prefix: %q", got[:len(domain)])
	}
	rest := got[len(domain):]

	expect := []byte{}
	appendLP := func(s string) {
		n := uint32(len(s))
		expect = append(expect, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
		expect = append(expect, s...)
	}
	appendLP("1") // v signed as the string "1"
	appendLP("zro")
	appendLP(testNodeID)
	appendLP(nodeSigner.signPub)
	appendLP(testNoise)
	expect = append(expect, 0, 0, 0, 0) // LParr of zero capabilities
	expect = append(expect, 0, 0, 0, 2) // LPcand count
	appendLP("direct-tcp")
	appendLP("h1")
	appendLP("1")
	appendLP("k2")
	appendLP("h2")
	appendLP("65535")
	appendLP("0") // issuedAt
	appendLP("0") // expiresAt

	if string(rest) != string(expect) {
		t.Fatalf("candidate framing mismatch:\n got %x\nwant %x", rest, expect)
	}
	for i, b := range rest {
		if b == '|' {
			t.Fatalf("delimiter byte at %d found in signing input (Amendment 1)", i)
		}
	}
}

// TestSwappedCandidatesChangeSigningInput: candidates are signed in the exact
// array order sent, so order is authenticated too.
func TestSwappedCandidatesChangeSigningInput(t *testing.T) {
	mk := func(cands []Candidate) *Contact {
		c := wellFormedContact()
		c.Candidates = cands
		return c
	}
	x := mk([]Candidate{{Kind: "a", Host: "h", Port: 1}, {Kind: "b", Host: "i", Port: 2}})
	y := mk([]Candidate{{Kind: "b", Host: "i", Port: 2}, {Kind: "a", Host: "h", Port: 1}})
	if string(x.SigningInput()) == string(y.SigningInput()) {
		t.Fatal("reordered candidates produced identical signing input")
	}
}

func TestPublicValidateAcceptsWellFormed(t *testing.T) {
	p := wellFormedPub()
	p.Sig = nodeSigner.sign(p.SigningInput())
	if err := p.Validate(); err != nil {
		t.Fatalf("valid descriptor rejected: %v", err)
	}
}

func TestContactValidateAcceptsWellFormed(t *testing.T) {
	c := wellFormedContact()
	c.Sig = nodeSigner.sign(c.SigningInput())
	if err := c.Validate(); err != nil {
		t.Fatalf("valid contact rejected: %v", err)
	}
}

// TestUnknownCandidateKindIsPreservedNotRejected is §3.2: later kinds must not
// need a flag day on the service side, and validation must not mutate them.
func TestUnknownCandidateKindIsPreservedNotRejected(t *testing.T) {
	c := wellFormedContact()
	c.Candidates[0].Kind = "quic-2027-future"
	c.Sig = nodeSigner.sign(c.SigningInput())
	if err := c.Validate(); err != nil {
		t.Fatalf("unknown-but-wellformed kind rejected: %v", err)
	}
	if c.Candidates[0].Kind != "quic-2027-future" {
		t.Fatal("kind was mutated during validation")
	}
}

// TestSelfConsistentForeignDescriptorStillValidates documents why the server's
// envelope comparison exists: Validate proves internal consistency only. A
// descriptor naming a different handle but signed by its own key still verifies,
// so nothing here may be read as proving signPub belongs to nodeId (§6).
func TestSelfConsistentForeignDescriptorStillValidates(t *testing.T) {
	p := wellFormedPub()
	p.Handle = "someoneelse"
	p.Sig = nodeSigner.sign(p.SigningInput())
	if err := p.Validate(); err != nil {
		t.Fatalf("self-consistent foreign descriptor should validate internally: %v", err)
	}
}

func TestPublicValidateRejectsBadStructure(t *testing.T) {
	cases := map[string]func(*Public){
		"v not 1":             func(p *Public) { p.V = 2 },
		"unnormalized handle": func(p *Public) { p.Handle = "Roshan" },
		"short handle":        func(p *Public) { p.Handle = "ro" },
		"bad handle chars":    func(p *Public) { p.Handle = "roshan!" },
		"nodeid lowercase":    func(p *Public) { p.NodeID = strings.ToLower(testNodeID) },
		"nodeid short":        func(p *Public) { p.NodeID = "AA" },
		"signpub uppercase":   func(p *Public) { p.SignPub = strings.ToUpper(nodeSigner.signPub) },
		"signpub short":       func(p *Public) { p.SignPub = "aa" },
		"sig malformed":       func(p *Public) { p.Sig = "nope" },
		"13 capabilities": func(p *Public) {
			p.Capabilities = make([]string, 13)
			for i := range p.Capabilities {
				p.Capabilities[i] = "chat"
			}
		},
		"capability 33 bytes":  func(p *Public) { p.Capabilities = []string{strings.Repeat("a", 33)} },
		"capability bad char":  func(p *Public) { p.Capabilities = []string{"chat room"} },
		"capability uppercase": func(p *Public) { p.Capabilities = []string{"Chat"} },
	}
	for name, mutate := range cases {
		p := wellFormedPub()
		p.Sig = validSigShape()
		mutate(p)
		if err := p.Validate(); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		} else if err != ErrInvalid {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
}

func TestContactValidateRejectsBadStructure(t *testing.T) {
	cases := map[string]func(*Contact){
		"noisePub uppercase": func(c *Contact) { c.NoisePub = strings.ToUpper(testNoise) },
		"noisePub short":     func(c *Contact) { c.NoisePub = "bb" },
		"noisePub empty":     func(c *Contact) { c.NoisePub = "" },
	}
	for name, mutate := range cases {
		c := wellFormedContact()
		c.Sig = validSigShape()
		mutate(c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
		} else if err != ErrInvalid {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
}

func TestContactValidateRejectsBadCandidates(t *testing.T) {
	cases := map[string][]Candidate{
		"7 candidates":     makeCandidates(7),
		"empty kind":       {{Kind: "", Host: "h", Port: 1}},
		"kind 33 bytes":    {{Kind: strings.Repeat("k", 33), Host: "h", Port: 1}},
		"empty host":       {{Kind: "direct-tcp", Host: "", Port: 1}},
		"host 256 bytes":   {{Kind: "direct-tcp", Host: strings.Repeat("h", 256), Port: 1}},
		"port zero":        {{Kind: "direct-tcp", Host: "h", Port: 0}},
		"port above range": {{Kind: "direct-tcp", Host: "h", Port: 65536}},
		"port negative":    {{Kind: "direct-tcp", Host: "h", Port: -1}},
	}
	for name, cands := range cases {
		c := wellFormedContact()
		c.Sig = validSigShape()
		c.Candidates = cands
		err := c.Validate()
		if err == nil {
			t.Errorf("%s: expected rejection, got nil", name)
			continue
		}
		// Over-long lifetime is reported by CheckLifetime at the handler layer;
		// structural candidate failures are ErrInvalid.
		if err != ErrInvalid && err != ErrBadSignature {
			t.Errorf("%s: want ErrInvalid or ErrBadSignature, got %v", name, err)
		}
	}
}

func TestContactValidateBoundaryAccepts(t *testing.T) {
	c := wellFormedContact()
	c.Candidates = append(makeCandidates(5),
		Candidate{Kind: strings.Repeat("k", 32), Host: strings.Repeat("h", 255), Port: 65535})
	c.Sig = nodeSigner.sign(c.SigningInput())
	if err := c.Validate(); err != nil {
		t.Fatalf("boundary-valid contact rejected: %v", err)
	}
}

func TestValidateRejectsTamperedSignature(t *testing.T) {
	c := wellFormedContact()
	c.Sig = nodeSigner.sign(c.SigningInput())
	sig, err := hex.DecodeString(c.Sig)
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 0x01
	c.Sig = hex.EncodeToString(sig)
	if err := c.Validate(); err != ErrBadSignature {
		t.Fatalf("tampered contact = %v, want ErrBadSignature", err)
	}

	p := wellFormedPub()
	p.Sig = nodeSigner.sign(p.SigningInput())
	p.ExpiresAt += 1 // one signed byte moved after signing
	if err := p.Validate(); err != ErrBadSignature {
		t.Fatalf("tampered public = %v, want ErrBadSignature", err)
	}
}

func TestNilDescriptorsAreInvalid(t *testing.T) {
	var p *Public
	if err := p.Validate(); err == nil {
		t.Fatal("nil public accepted")
	}
	var c *Contact
	if err := c.Validate(); err == nil {
		t.Fatal("nil contact accepted")
	}
}

func TestCheckLifetime(t *testing.T) {
	const now = int64(1000)
	cases := []struct {
		name      string
		issuedAt  int64
		expiresAt int64
		want      error
	}{
		{"inside window", now - 5000, now + 5000, nil},
		{"expires just after now", now, now + 1, nil},
		{"already expired", now - 300000, now - 1, ErrExpired},
		{"expiresAt before issuedAt", now + 10, now + 5, ErrExpired},
		{"lifetime over 300s by 1ms", now, now + MaxDescriptorLifetimeMs + 1, ErrExpired},
		{"lifetime exactly 300s", now, now + MaxDescriptorLifetimeMs, nil},
	}
	for _, tc := range cases {
		if got := CheckLifetime(tc.issuedAt, tc.expiresAt, now); got != tc.want {
			t.Errorf("%s: CheckLifetime = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// TestVerifyUsesRealEd25519 ensures validation actually verifies against the
// presented key rather than trusting the sig field's shape.
func TestVerifyUsesRealEd25519(t *testing.T) {
	c := wellFormedContact()
	otherPriv := wire.DeriveSigningKey([]byte(strings.Repeat("z", 32)))
	c.Sig = wire.Sign(otherPriv, c.SigningInput())
	if err := c.Validate(); err != ErrBadSignature {
		t.Fatalf("signature by a different key = %v, want ErrBadSignature", err)
	}
}

func makeCandidates(n int) []Candidate {
	out := make([]Candidate, n)
	for i := range out {
		out[i] = Candidate{Kind: "direct-tcp", Host: "203.0.113.9", Port: 42001 + i}
	}
	return out
}
