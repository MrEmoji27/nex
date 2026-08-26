// Package handle implements the handle normalization rules of the frozen wire
// contract (RENDEZVOUS_WIRE_V1 §2).
//
// A handle is a lookup alias, never an identity (V3 §9). Rendezvous does not own
// a permanent namespace and does not arbitrate ownership disputes: a handle is
// first-come and held only for the duration of the lease.
package handle

import (
	"errors"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// ErrInvalid is returned for anything that does not survive normalization.
// The caller maps it to the wire error code handle_invalid (400).
//
// There is no silent repair and no substitution: a handle the service quietly
// rewrote is a handle the user did not choose.
var ErrInvalid = errors.New("handle: invalid")

// MinLen and MaxLen bound the normalized form: ^[a-z0-9][a-z0-9_-]{2,31}$.
const (
	MinLen = 3
	MaxLen = 32
)

// asciiSpace is the set trimmed in step 1. "ASCII whitespace" is exactly these
// six code points; Unicode space separators are NOT trimmed, they simply fail
// the final ASCII pattern.
const asciiSpace = " \t\n\v\f\r"

// Normalize applies contract §2 in order:
//
//  1. trim leading/trailing ASCII whitespace
//  2. apply Unicode NFKC
//  3. lowercase (Unicode simple lowercase)
//  4. require ^[a-z0-9][a-z0-9_-]{2,31}$
//
// Step 2 is why fullwidth input such as "ＲＯＳＨＡＮ" is accepted as "roshan"
// while halfwidth katakana such as "ﾛｼｬﾝ" is rejected: NFKC folds the former to
// ASCII and the latter to non-ASCII kana, and step 4 is ASCII-only.
func Normalize(raw string) (string, error) {
	s := strings.Trim(raw, asciiSpace)
	s = norm.NFKC.String(s)
	s = toSimpleLower(s)
	if !valid(s) {
		return "", ErrInvalid
	}
	return s, nil
}

// toSimpleLower applies Unicode *simple* lowercase, one rune at a time. Full
// case folding is deliberately not used: it is locale- and context-sensitive,
// and two implementations that disagree about it disagree about who owns a
// handle.
func toSimpleLower(s string) string {
	return strings.Map(unicode.ToLower, s)
}

// valid enforces ^[a-z0-9][a-z0-9_-]{2,31}$ over bytes. The pattern is ASCII-only,
// so a byte-wise check and a rune-wise check agree, and any multi-byte rune fails.
func valid(s string) bool {
	if len(s) < MinLen || len(s) > MaxLen {
		return false
	}
	if !isAlnum(s[0]) {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if !isAlnum(c) && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

func isAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}
