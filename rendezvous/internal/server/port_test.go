package server

import "testing"

// Most hosts tell a service where to listen through PORT and route to nothing
// else. Getting this wrong deploys cleanly and then serves nobody, because the
// platform health-checks a port the process never bound.
func TestConfigHonoursPort(t *testing.T) {
	t.Setenv("PORT", "10000")
	if got := ConfigFromEnv().Addr; got != ":10000" {
		t.Fatalf("Addr = %q, want \":10000\" — the platform routes only to PORT", got)
	}
}

// An explicit address is a deliberate choice by whoever is running it, so it
// outranks the platform's suggestion.
func TestExplicitAddrBeatsPort(t *testing.T) {
	t.Setenv("PORT", "10000")
	t.Setenv("NEX_RENDEZVOUS_ADDR", "127.0.0.1:9999")
	if got := ConfigFromEnv().Addr; got != "127.0.0.1:9999" {
		t.Fatalf("Addr = %q, want the explicit value to win", got)
	}
}

func TestDefaultAddrWhenNeitherIsSet(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("NEX_RENDEZVOUS_ADDR", "")
	if got := ConfigFromEnv().Addr; got != DefaultAddr {
		t.Fatalf("Addr = %q, want the default %q", got, DefaultAddr)
	}
}
