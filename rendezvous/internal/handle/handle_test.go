package handle

import (
	"strings"
	"testing"
)

// TestContractSection21Vectors is the shared normalization table from
// RENDEZVOUS_WIRE_V1 §2.1. The TypeScript client runs the same table; any
// divergence here is a divergence in who can find whom.
func TestContractSection21Vectors(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string // empty means "rejected"
		why   string
	}{
		{"plain", "roshan", "roshan", ""},
		{"surrounding ascii whitespace", "  Roshan  ", "roshan", ""},
		{"uppercase", "ROSHAN", "roshan", ""},
		{"halfwidth katakana NFKC-folds to kana, still non-ASCII", "ﾛｼｬﾝ", "", "handle_invalid, non-ASCII"},
		{"too short", "ro", "", "too short"},
		{"leading underscore", "_roshan", "", "must start alphanumeric"},
		{"illegal char", "roshan!", "", "illegal char"},
		{"digits and dash", "zro-2", "zro-2", ""},
		{"too long", strings.Repeat("a", 33), "", "too long"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := Normalize(c.input)
			if c.want == "" {
				if err == nil {
					t.Fatalf("Normalize(%q) = %q, want rejection (%s)", c.input, got, c.why)
				}
				if err != ErrInvalid {
					t.Fatalf("Normalize(%q) returned %v, want ErrInvalid", c.input, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Normalize(%q) rejected: %v", c.input, err)
			}
			if got != c.want {
				t.Fatalf("Normalize(%q) = %q, want %q", c.input, got, c.want)
			}
		})
	}
}

// TestKatakanaVectorFoldsAsTheContractSays double-checks the intermediate step
// of the §2.1 katakana row: NFKC turns halfwidth katakana into full katakana.
// The rejection must come from the ASCII pattern, not from a failure to normalize.
func TestKatakanaVectorFoldsAsTheContractSays(t *testing.T) {
	const halfwidth = "ﾛｼｬﾝ" // ﾛｼｬﾝ
	const full = "ロシャン"      // ロシャン
	if got := nfkcForTest(halfwidth); got != full {
		t.Fatalf("NFKC(%q) = %q, want %q", halfwidth, got, full)
	}
	if _, err := Normalize(halfwidth); err != ErrInvalid {
		t.Fatalf("katakana handle accepted, want ErrInvalid")
	}
}

// TestNFKCIsActuallyApplied proves step 2 is not a no-op. Without NFKC the
// fullwidth form would fail the ASCII pattern and a user typing on a CJK IME
// could never register the handle they see on screen.
func TestNFKCIsActuallyApplied(t *testing.T) {
	got, err := Normalize("ＲＯＳＨＡＮ") // fullwidth ROSHAN
	if err != nil {
		t.Fatalf("fullwidth latin rejected: %v", err)
	}
	if got != "roshan" {
		t.Fatalf("NFKC(fullwidth) = %q, want %q", got, "roshan")
	}

	// Ligature: NFKC decomposes U+FB01 to "fi".
	if got, err := Normalize("ﬁne"); err != nil || got != "fine" {
		t.Fatalf("Normalize(ligature) = %q, %v; want %q", got, err, "fine")
	}

	// Compatibility digits: U+2081 SUBSCRIPT ONE folds to "1".
	if got, err := Normalize("a₁b"); err != nil || got != "a1b" {
		t.Fatalf("Normalize(subscript) = %q, %v; want %q", got, err, "a1b")
	}
}

// TestNormalizeIsIdempotent: the client normalizes before sending and the
// service re-normalizes before storing or comparing. If the operation were not
// idempotent those two steps would disagree.
func TestNormalizeIsIdempotent(t *testing.T) {
	inputs := []string{"roshan", "  ROSHAN ", "ＲＯＳＨＡＮ", "zro-2", "a_b_c", strings.Repeat("z", 32)}
	for _, in := range inputs {
		once, err := Normalize(in)
		if err != nil {
			t.Fatalf("Normalize(%q): %v", in, err)
		}
		twice, err := Normalize(once)
		if err != nil {
			t.Fatalf("Normalize(Normalize(%q)): %v", in, err)
		}
		if once != twice {
			t.Fatalf("not idempotent: %q -> %q -> %q", in, once, twice)
		}
	}
}

// TestBoundaryLengths pins the 3..32 window exactly.
func TestBoundaryLengths(t *testing.T) {
	if _, err := Normalize(strings.Repeat("a", 2)); err == nil {
		t.Error("2 chars accepted, want rejection")
	}
	if got, err := Normalize(strings.Repeat("a", 3)); err != nil || len(got) != 3 {
		t.Errorf("3 chars rejected: %v", err)
	}
	if got, err := Normalize(strings.Repeat("a", 32)); err != nil || len(got) != 32 {
		t.Errorf("32 chars rejected: %v", err)
	}
	if _, err := Normalize(strings.Repeat("a", 33)); err == nil {
		t.Error("33 chars accepted, want rejection")
	}
}

// TestRejectsHostileShapes covers input that a lenient normalizer would "repair".
// Every one of these must be rejected outright — no silent repair (§2).
func TestRejectsHostileShapes(t *testing.T) {
	bad := []string{
		"",
		"   ",
		"-roshan",    // must start alphanumeric
		"ro shan",    // interior space
		"ro\tshan",   // interior tab
		"ro\nshan",   // interior newline
		"roshan\x00", // NUL
		"ro/shan",    // path separator
		"ro.shan",    // dot
		"ro:shan",
		"ro%20shan", // percent-encoded space stays literal
		"Roßhan",    // sharp s: simple lowercase keeps it, non-ASCII -> reject
		"roshan​",   // zero-width space survives NFKC
		"‮roshan",   // RTL override
		"рoshan",    // Cyrillic homoglyph
		"ROSHAN!",
		"__ab",
		"9",
		"a-", // 2 chars
	}
	for _, in := range bad {
		if got, err := Normalize(in); err == nil {
			t.Errorf("Normalize(%q) = %q, want rejection", in, got)
		}
	}
}

// TestUnicodeSpaceIsNotTrimmed: step 1 trims ASCII whitespace only. A non-ASCII
// space must fail the pattern rather than be quietly removed.
func TestUnicodeSpaceIsNotTrimmed(t *testing.T) {
	// U+00A0 NO-BREAK SPACE NFKC-folds to U+0020, but trimming already happened,
	// so the result carries a leading space and fails the pattern.
	if got, err := Normalize(" roshan"); err == nil {
		t.Fatalf("Normalize(nbsp+roshan) = %q, want rejection", got)
	}
	// U+3000 IDEOGRAPHIC SPACE likewise.
	if got, err := Normalize("roshan　"); err == nil {
		t.Fatalf("Normalize(roshan+ideographic space) = %q, want rejection", got)
	}
}

// TestTrimsEveryASCIIWhitespaceByte pins the six-byte trim set.
func TestTrimsEveryASCIIWhitespaceByte(t *testing.T) {
	for _, ws := range []string{" ", "\t", "\n", "\v", "\f", "\r"} {
		got, err := Normalize(ws + "roshan" + ws)
		if err != nil || got != "roshan" {
			t.Errorf("trim %q: got %q, err %v", ws, got, err)
		}
	}
}
