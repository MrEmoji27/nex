package server

import (
	"encoding/json"
	"strings"
	"testing"

	"nex.rendezvous/internal/protocol"
)

// Wire contract §5.4 as amended (Amendment 4).
//
// Status code and timing were already equalised between a search hit and a
// miss. Response LENGTH was not: a 15-byte {"result":null} against a ~600-byte
// hit fingerprints handle existence perfectly, which defeats the enumeration
// control §26 depends on. Every 200 is now padded to one constant, so length
// carries no information — and unlike "comparable size class", that is a
// property a test can actually assert.

func TestSearchHitAndMissAreByteIdenticalInLength(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")
	h.mustRegister(roshan, "roshan")

	hit := h.search(zro, "roshan")
	miss := h.search(zro, "nobodyhome")

	if hit.Code != 200 || miss.Code != 200 {
		t.Fatalf("both must be 200; hit=%d miss=%d", hit.Code, miss.Code)
	}
	if hit.Body.Len() != miss.Body.Len() {
		t.Fatalf("length oracle: hit=%d bytes, miss=%d bytes — a search response must not reveal existence by size",
			hit.Body.Len(), miss.Body.Len())
	}
	if hit.Body.Len() != protocol.SearchResponseBytes {
		t.Fatalf("search response = %d bytes, want the fixed %d", hit.Body.Len(), protocol.SearchResponseBytes)
	}
}

// A hit must stay the same size regardless of how large the descriptor inside
// it is, otherwise padding merely narrows the oracle instead of closing it.
func TestSearchLengthIsIndependentOfDescriptorSize(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")

	small := newIdentity("ab")
	h.mustRegister(small, "abc")

	large := newIdentity("long")
	h.mustRegister(large, strings.Repeat("z", 32)) // longest legal handle

	a := h.search(zro, "abc")
	b := h.search(zro, strings.Repeat("z", 32))

	if a.Body.Len() != b.Body.Len() {
		t.Fatalf("descriptor size leaks through: %d vs %d bytes", a.Body.Len(), b.Body.Len())
	}
}

func TestSearchPadIsPresentAndIgnorable(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	roshan := newIdentity("roshan")
	h.mustRegister(roshan, "roshan")

	for _, tc := range []struct {
		name  string
		query string
		hit   bool
	}{
		{"hit", "roshan", true},
		{"miss", "nobodyhome", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := h.search(zro, tc.query)

			// The padding must not disturb the meaningful field.
			var parsed protocol.SearchResponse
			if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
				t.Fatalf("padded response does not parse: %v", err)
			}
			if tc.hit && parsed.Result == nil {
				t.Fatal("hit lost its result under padding")
			}
			if !tc.hit && parsed.Result != nil {
				t.Fatal("miss gained a result")
			}
			if parsed.Pad == "" {
				t.Fatal("no _pad member; the response cannot be a fixed size without it")
			}

			// A client that ignores _pad entirely still reads the response
			// correctly — the contract requires clients to ignore it.
			var minimal struct {
				Result *json.RawMessage `json:"result"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &minimal); err != nil {
				t.Fatalf("a client ignoring _pad cannot parse the body: %v", err)
			}
		})
	}
}

// The register-side guard is what keeps the padding budget satisfiable: no
// stored descriptor may be large enough to overflow the fixed envelope.
func TestPublicDescriptorBudgetLeavesHeadroom(t *testing.T) {
	if protocol.MaxPublicDescriptorBytes >= protocol.SearchResponseBytes {
		t.Fatalf("descriptor budget %d must be below the response size %d",
			protocol.MaxPublicDescriptorBytes, protocol.SearchResponseBytes)
	}
}
