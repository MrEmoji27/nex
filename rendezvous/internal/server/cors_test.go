package server

import (
	"net/http"
	"testing"
)

// The website reads /v1/status and /v1/metrics/public from a browser on a
// different origin. Without CORS those fetches fail and the site shows its
// "service unreachable" state forever — which is exactly what happened, and was
// missed because the site had only ever been tested with the backend down, so
// "unreachable" looked correct.
func TestPublicEndpointsAllowCrossOriginReads(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/v1/status", "/v1/metrics/public"} {
		t.Run(path, func(t *testing.T) {
			w := h.do(http.MethodGet, path, nil, map[string]string{"Origin": "https://nex.example"})
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Fatalf("Access-Control-Allow-Origin = %q, want \"*\" — a browser cannot read this", got)
			}
		})
	}
}

func TestPublicEndpointsAnswerPreflight(t *testing.T) {
	h := newHarness(t)

	w := h.do(http.MethodOptions, "/v1/metrics/public", nil, map[string]string{
		"Origin":                        "https://nex.example",
		"Access-Control-Request-Method": "GET",
	})
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("preflight Access-Control-Allow-Origin = %q, want \"*\"", got)
	}
}

// Everything else is spoken to by a Nex node, never a browser. Handing those
// endpoints a permissive origin would let any page a user happens to visit
// drive their presence, so the absence of CORS there is a security property,
// not an oversight.
func TestAuthenticatedEndpointsDoNotAllowCrossOrigin(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct{ method, path string }{
		{http.MethodPost, "/v1/presence/register"},
		{http.MethodPost, "/v1/presence/refresh"},
		{http.MethodDelete, "/v1/presence"},
		{http.MethodGet, "/v1/discovery/search"},
		{http.MethodPost, "/v1/introduction/request"},
		{http.MethodPost, "/v1/introduction/respond"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			w := h.do(tc.method, tc.path, nil, map[string]string{"Origin": "https://evil.example"})
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
				t.Fatalf("%s exposes Access-Control-Allow-Origin = %q; a browser must not be able to drive this endpoint",
					tc.path, got)
			}
		})
	}
}
