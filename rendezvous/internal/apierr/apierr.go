// Package apierr holds the frozen error vocabulary of RENDEZVOUS_WIRE_V1 §5.9.
//
// The wire shape is exactly:
//
//	{ "error": { "code": "rate_limited", "message": "human readable, no user data" } }
//
// Messages never echo a handle, nodeId, or any part of the request body.
package apierr

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Code is a wire error code. The set is closed; §5.9 is normative.
type Code string

const (
	InvalidRequest      Code = "invalid_request"
	StaleRequest        Code = "stale_request"
	HandleInvalid       Code = "handle_invalid"
	InvalidSignature    Code = "invalid_signature"
	ReplayedNonce       Code = "replayed_nonce"
	NotFound            Code = "not_found"
	LeaseExpired        Code = "lease_expired"
	IntroductionExpired Code = "introduction_expired"
	HandleTaken         Code = "handle_taken"
	PayloadTooLarge     Code = "payload_too_large"
	RateLimited         Code = "rate_limited"
	Internal            Code = "internal"
)

// status is the §5.9 code -> HTTP status table.
var status = map[Code]int{
	InvalidRequest:      http.StatusBadRequest,            // 400
	StaleRequest:        http.StatusBadRequest,            // 400
	HandleInvalid:       http.StatusBadRequest,            // 400
	InvalidSignature:    http.StatusUnauthorized,          // 401
	ReplayedNonce:       http.StatusUnauthorized,          // 401
	NotFound:            http.StatusNotFound,              // 404
	LeaseExpired:        http.StatusNotFound,              // 404
	IntroductionExpired: http.StatusNotFound,              // 404
	HandleTaken:         http.StatusConflict,              // 409
	PayloadTooLarge:     http.StatusRequestEntityTooLarge, // 413
	RateLimited:         http.StatusTooManyRequests,       // 429
	Internal:            http.StatusInternalServerError,   // 500
}

// Status returns the default HTTP status for a code.
func Status(c Code) int {
	if s, ok := status[c]; ok {
		return s
	}
	return http.StatusInternalServerError
}

// message is the fixed human-readable text per code. Fixed strings are the
// simplest way to guarantee §5.9's "no user data" rule: there is no format verb
// anywhere on this path that could interpolate a handle or a nodeId.
var message = map[Code]string{
	InvalidRequest:      "request was malformed or failed validation",
	StaleRequest:        "request timestamp is outside the accepted window",
	HandleInvalid:       "handle failed normalization",
	InvalidSignature:    "signature did not verify",
	ReplayedNonce:       "nonce has already been used",
	NotFound:            "not found",
	LeaseExpired:        "lease is unknown or expired",
	IntroductionExpired: "introduction is unknown or expired",
	HandleTaken:         "handle is currently held by another node",
	PayloadTooLarge:     "request body exceeds the maximum size",
	RateLimited:         "rate limit exceeded",
	Internal:            "service is unable to accept this request",
}

// Message returns the fixed message for a code.
func Message(c Code) string {
	if m, ok := message[c]; ok {
		return m
	}
	return "unexpected error"
}

// Error is the JSON envelope of §5.9.
type Error struct {
	Error Body `json:"error"`
}

// Body is the inner object.
type Body struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

// E is a Go error carrying a wire code, so handlers can return one value.
type E struct {
	Code Code
	// HTTPStatus overrides the §5.9 default. Used only where the contract
	// itself specifies a different status for a code: §5.6 (403 not_found)
	// and §8 (503 internal at global capacity).
	HTTPStatus int
	// RetryAfterSec populates the Retry-After header on 429 responses (§5.9).
	RetryAfterSec int
}

func (e *E) Error() string { return string(e.Code) }

// New builds an E with the default status for the code.
func New(c Code) *E { return &E{Code: c} }

// WithStatus builds an E with an explicit status, for the two contract-specified
// overrides.
func WithStatus(c Code, httpStatus int) *E { return &E{Code: c, HTTPStatus: httpStatus} }

// RateLimit builds a 429 carrying Retry-After.
func RateLimit(retryAfterSec int) *E {
	if retryAfterSec < 1 {
		retryAfterSec = 1
	}
	return &E{Code: RateLimited, RetryAfterSec: retryAfterSec}
}

// Write emits the error response. It is the only place in the service that
// writes an error body.
func Write(w http.ResponseWriter, e *E) {
	if e == nil {
		e = New(Internal)
	}
	code := e.HTTPStatus
	if code == 0 {
		code = Status(e.Code)
	}
	if e.Code == RateLimited && e.RetryAfterSec > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(e.RetryAfterSec))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(Error{Body{Code: e.Code, Message: Message(e.Code)}})
}
