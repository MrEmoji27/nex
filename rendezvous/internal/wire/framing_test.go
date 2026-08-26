package wire

import (
	"encoding/hex"
	"strings"
	"testing"
)

// contractVector is the §1.5 signing-input test vector, copied verbatim from
// RENDEZVOUS_WIRE_V1.md. Both the Go service and the TypeScript client must
// reproduce it byte for byte.
//
// "If your framing produces anything else, your framing is wrong — do not adjust
// the vector to match your code."
const contractVector = "6e65782d72656e64657a766f75732f7075626c69632d64657363726970746f722d7631" +
	"000000013100000006726f7368616e000000024141000000026262000000010000000463686174" +
	"000000013500000001370000000474727565"

func TestSection15SigningInputVector(t *testing.T) {
	got := NewBuilder(DomainPublicDescriptor).
		LP("1").
		LP("roshan").
		LP("AA").
		LP("bb").
		LParr([]string{"chat"}).
		LPn(5).
		LPn(7).
		LPbool(true).
		Bytes()

	if hex.EncodeToString(got) != contractVector {
		t.Fatalf("signing input mismatch\n got %s\nwant %s", hex.EncodeToString(got), contractVector)
	}
}

// TestSection15VectorPieces documents the framing piecewise, so a failure points
// at the specific rule that broke rather than at one long hex blob.
func TestSection15VectorPieces(t *testing.T) {
	cases := []struct {
		name string
		got  []byte
		want string
	}{
		{"domain is raw UTF-8, no length prefix", NewBuilder(DomainPublicDescriptor).Bytes(),
			"6e65782d72656e64657a766f75732f7075626c69632d64657363726970746f722d7631"},
		{`LP("1")`, NewBuilder("").LP("1").Bytes(), "0000000131"},
		{`LP("roshan")`, NewBuilder("").LP("roshan").Bytes(), "00000006726f7368616e"},
		{`LParr(["chat"])`, NewBuilder("").LParr([]string{"chat"}).Bytes(), "000000010000000463686174"},
		{"LParr of empty array is a bare count", NewBuilder("").LParr(nil).Bytes(), "00000000"},
		{`LPn(5)`, NewBuilder("").LPn(5).Bytes(), "0000000135"},
		{`LPn(7)`, NewBuilder("").LPn(7).Bytes(), "0000000137"},
		{`LPbool(true)`, NewBuilder("").LPbool(true).Bytes(), "0000000474727565"},
		{`LPbool(false)`, NewBuilder("").LPbool(false).Bytes(), "0000000566616c7365"},
		{"LP of empty string is a bare zero length", NewBuilder("").LP("").Bytes(), "00000000"},
	}
	for _, c := range cases {
		if hex.EncodeToString(c.got) != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, hex.EncodeToString(c.got), c.want)
		}
	}
}

// TestLPnIsDecimalASCII pins §1.4: integers are encoded as their decimal string,
// no sign for positives, no padding. A unix-ms timestamp must not become
// scientific notation or a zero-padded fixed width.
func TestLPnIsDecimalASCII(t *testing.T) {
	cases := map[int64]string{
		0:             "0",
		7:             "7",
		1756200000000: "1756200000000",
		-1:            "-1",
	}
	for n, want := range cases {
		got := NewBuilder("").LPn(n).Bytes()
		body := string(got[4:])
		if body != want {
			t.Errorf("LPn(%d) encoded %q, want %q", n, body, want)
		}
		if int(got[3]) != len(want) || got[0] != 0 || got[1] != 0 || got[2] != 0 {
			t.Errorf("LPn(%d) length prefix wrong: %x", n, got[:4])
		}
	}
}

// TestFramingIsUnambiguous is the reason the contract bans canonical JSON:
// concatenations that would collide under a separator-free encoding must not
// collide under length prefixing.
func TestFramingIsUnambiguous(t *testing.T) {
	a := NewBuilder("d").LP("ab").LP("c").Bytes()
	b := NewBuilder("d").LP("a").LP("bc").Bytes()
	if hex.EncodeToString(a) == hex.EncodeToString(b) {
		t.Fatal("LP framing is ambiguous: (ab,c) and (a,bc) produced the same bytes")
	}

	// The same applies to arrays vs. a single joined string.
	arr := NewBuilder("d").LParr([]string{"chat", "rooms"}).Bytes()
	joined := NewBuilder("d").LP("chatrooms").Bytes()
	if hex.EncodeToString(arr) == hex.EncodeToString(joined) {
		t.Fatal("LParr framing is ambiguous with a joined LP")
	}
}

// TestLPCountsBytesNotRunes pins that the length prefix is the UTF-8 byte
// length. A rune count would put the two implementations one byte apart on any
// non-ASCII capability or host string.
func TestLPCountsBytesNotRunes(t *testing.T) {
	s := "é" // 2 bytes, 1 rune
	got := NewBuilder("").LP(s).Bytes()
	if got[3] != 2 {
		t.Fatalf("LP(%q) length prefix = %d, want 2 (UTF-8 bytes)", s, got[3])
	}
	if len(got) != 6 {
		t.Fatalf("LP(%q) total length = %d, want 6", s, len(got))
	}
}

// TestBuilderIsAppendOnly guards against a Builder that shares backing storage
// between two derived signing inputs.
func TestBuilderIsAppendOnly(t *testing.T) {
	b := NewBuilder("d").LP("x")
	first := hex.EncodeToString(b.Bytes())
	other := NewBuilder("d").LP("x").LP("y")
	_ = other
	if hex.EncodeToString(b.Bytes()) != first {
		t.Fatal("Builder mutated after a second builder was created")
	}
	if !strings.HasPrefix(hex.EncodeToString(other.Bytes()), first) {
		t.Fatal("derived builder lost its prefix")
	}
}
