// Package wire implements the length-prefixed signing framing and the Ed25519
// verification rules of the frozen wire contract (RENDEZVOUS_WIRE_V1 §1).
//
// Canonical JSON is deliberately NOT used: two languages disagree about string
// escaping, number formatting and key ordering in ways that stay invisible until
// they are exploitable. Every signature is over the framing below instead.
package wire

import (
	"encoding/binary"
	"strconv"
)

// Builder accumulates a SIGNING_INPUT.
//
//	LP(s)    = uint32be(byteLength(UTF8(s))) || UTF8(s)
//	LPn(n)   = LP(decimal ASCII representation of n)
//	LParr(a) = uint32be(len(a)) || LP(a[0]) || LP(a[1]) || ...
//
// There is no separator byte between fields; the length prefixes make the
// concatenation unambiguous.
type Builder struct {
	buf []byte
}

// NewBuilder starts a signing input with the given domain separator. The domain
// is written as raw UTF-8, without a length prefix (contract §1.4:
// SIGNING_INPUT = UTF8(<domain separator>) || <fields...>).
func NewBuilder(domain string) *Builder {
	b := &Builder{buf: make([]byte, 0, 256)}
	b.buf = append(b.buf, domain...)
	return b
}

// LP appends a length-prefixed string.
func (b *Builder) LP(s string) *Builder {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(s)))
	b.buf = append(b.buf, hdr[:]...)
	b.buf = append(b.buf, s...)
	return b
}

// LPn appends an integer as its decimal ASCII representation, length-prefixed.
// No sign for positives, no padding.
func (b *Builder) LPn(n int64) *Builder {
	return b.LP(strconv.FormatInt(n, 10))
}

// LPbool appends a boolean as LP("true") / LP("false").
func (b *Builder) LPbool(v bool) *Builder {
	if v {
		return b.LP("true")
	}
	return b.LP("false")
}

// LParr appends a count-prefixed array of length-prefixed strings.
func (b *Builder) LParr(a []string) *Builder {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(a)))
	b.buf = append(b.buf, hdr[:]...)
	for _, s := range a {
		b.LP(s)
	}
	return b
}

// Bytes returns the accumulated signing input.
func (b *Builder) Bytes() []byte { return b.buf }

// Count appends a bare uint32be element count with no payload of its own.
//
// It exists for LPcand (contract §3.2 as amended): a candidate array is a count
// followed by each element's own length-prefixed fields, with no delimiter
// anywhere. An earlier draft flattened candidates to "<kind>|<host>|<port>",
// which reintroduced exactly the ambiguity §1.4 exists to eliminate.
func (b *Builder) Count(n int) *Builder {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(n))
	b.buf = append(b.buf, hdr[:]...)
	return b
}
