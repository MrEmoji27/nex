package apierr

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestStatusMappingIsTheFrozenTable pins every row of the §5.9 table. A wrong
// status for one code is a wire-contract violation, not an internal detail.
func TestStatusMappingIsTheFrozenTable(t *testing.T) {
	cases := []struct {
		code Code
		want int
	}{
		{InvalidRequest, 400},
		{StaleRequest, 400},
		{HandleInvalid, 400},
		{InvalidSignature, 401},
		{ReplayedNonce, 401},
		{NotFound, 404},
		{LeaseExpired, 404},
		{IntroductionExpired, 404},
		{HandleTaken, 409},
		{PayloadTooLarge, 413},
		{RateLimited, 429},
		{Internal, 500},
	}
	if len(status) != len(cases) {
		t.Fatalf("§5.9 table has %d rows, code set has %d — update both together", len(cases), len(status))
	}
	for _, tc := range cases {
		if got := Status(tc.code); got != tc.want {
			t.Errorf("Status(%s) = %d, want %d", tc.code, got, tc.want)
		}
	}
}

func TestUnknownCodeFallsBackToInternal(t *testing.T) {
	if got := Status(Code("not_a_code")); got != http.StatusInternalServerError {
		t.Errorf("unknown code = %d, want 500", got)
	}
	if Message(Code("not_a_code")) == "" {
		t.Error("unknown code must still get a message")
	}
}

// TestWriteEmitsTheFrozenShape checks the exact wire envelope of §5.9 and that
// Content-Type is application/json.
func TestWriteEmitsTheFrozenShape(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, New(HandleTaken))

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q", ct)
	}
	var body Error
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, w.Body.String())
	}
	if body.Error.Code != HandleTaken {
		t.Errorf("code = %q", body.Error.Code)
	}
	if body.Error.Message != Message(HandleTaken) {
		t.Errorf("message = %q, want the fixed string", body.Error.Message)
	}
	// Exactly two keys inside error, exactly one top-level key.
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(w.Body.Bytes(), &raw)
	if len(raw) != 1 {
		t.Fatalf("top-level keys = %d, want 1", len(raw))
	}
	var inner map[string]json.RawMessage
	_ = json.Unmarshal(raw["error"], &inner)
	if len(inner) != 2 {
		t.Fatalf("error keys = %d, want exactly {code,message}", len(inner))
	}
}

// TestWriteUsesOverrideStatus covers the two contract-specified overrides:
// §5.6's collapsed 404 (via defaults) and §8's 503 internal at global capacity.
func TestWriteUsesOverrideStatus(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, WithStatus(Internal, http.StatusServiceUnavailable))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("overridden status = %d, want 503", w.Code)
	}
	var body Error
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body.Error.Code != Internal {
		t.Errorf("override changed the code: %q", body.Error.Code)
	}
}

func TestRateLimitSetsRetryAfter(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, RateLimit(42))
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "42" {
		t.Fatalf("Retry-After = %q, want 42", got)
	}
}

func TestRateLimitClampsToAtLeastOneSecond(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, RateLimit(0))
	if got := w.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1 (never zero or negative)", got)
	}
	w = httptest.NewRecorder()
	Write(w, RateLimit(-5))
	if got := w.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}
}

// TestNonRateLimitedErrorsCarryNoRetryAfter: the header is specified only for
// 429; its presence elsewhere would be a contract deviation.
func TestNonRateLimitedErrorsCarryNoRetryAfter(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, New(LeaseExpired))
	if got := w.Header().Get("Retry-After"); got != "" {
		t.Fatalf("Retry-After on a non-429 = %q", got)
	}
}

// TestMessagesNeverEchoRequestData is the §5.9 rule that messages carry no user
// data. The message table is fixed strings, so the strongest meaningful
// assertion is that plausible request values can never appear in one: no
// interpolation points anywhere in the table, and no sample handle, nodeId or
// leaseId fragment shows up in any message.
func TestMessagesNeverEchoRequestData(t *testing.T) {
	sampleHandle := "roshan"
	sampleNodeID := strings.Repeat("AA", 32)
	sampleLease := strings.Repeat("ab", 16)
	for code := range status {
		m := Message(code)
		if strings.ContainsAny(m, "%{}") {
			t.Errorf("message(%s) = %q contains an interpolation point", code, m)
		}
		for _, frag := range []string{sampleHandle, sampleNodeID, sampleLease} {
			if strings.Contains(m, frag) {
				t.Errorf("message(%s) = %q contains request data %q", code, m, frag)
			}
		}
	}
}

func TestNilErrorWritesInternal(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, nil)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("nil error wrote %d, want 500", w.Code)
	}
	var body Error
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body.Error.Code != Internal {
		t.Fatalf("nil error code = %q", body.Error.Code)
	}
}

func TestRateLimitHelperEnforcesMinimum(t *testing.T) {
	if e := RateLimit(0); e.RetryAfterSec != 1 {
		t.Fatalf("RateLimit(0).RetryAfterSec = %d", e.RetryAfterSec)
	}
}
