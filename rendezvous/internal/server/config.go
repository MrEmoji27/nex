package server

import (
	"os"
	"strconv"
	"time"
)

// Version is reported by GET /v1/status (§5.7).
const Version = "1.0.0"

// Config is the service's runtime configuration. Every field has a safe default
// so the zero-configuration case is also the correct one.
type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string

	// TLSCertFile and TLSKeyFile enable HTTPS directly. Left empty, the service
	// serves plain HTTP and expects TLS to be terminated in front of it.
	TLSCertFile string
	TLSKeyFile  string

	// LeaseTTLMs is the "now + 90000" term of §5.2.1. The effective lease
	// expiry is min(now+LeaseTTLMs, publicDescriptor.expiresAt,
	// contactDescriptor.expiresAt), so a lease can never outlive the
	// descriptors it hands out.
	LeaseTTLMs int64

	// RefreshAfterMs is the refreshAfterMs the service advertises (§5.1, §5.2).
	RefreshAfterMs int64

	// SweepInterval is how often lapsed leases, introductions, nonces and rate
	// buckets are reclaimed. Correctness does not depend on it: every read path
	// checks expiry itself.
	SweepInterval time.Duration

	// MaxLeases and MaxPendingIntroductions are the §8 global caps.
	MaxLeases               int
	MaxPendingIntroductions int

	// TrustProxyHeaders makes the service read the client IP from
	// X-Forwarded-For. Only enable it behind a proxy that overwrites the header;
	// otherwise every per-IP limit in §8 becomes client-controlled.
	TrustProxyHeaders bool
}

// Contract-derived defaults.
const (
	DefaultAddr           = ":8080"
	DefaultLeaseTTLMs     = 90000
	DefaultRefreshAfterMs = 30000
	DefaultSweepInterval  = 5 * time.Second
)

// DefaultConfig returns the configuration the service runs with when nothing is
// set.
func DefaultConfig() Config {
	return Config{
		Addr:                    DefaultAddr,
		LeaseTTLMs:              DefaultLeaseTTLMs,
		RefreshAfterMs:          DefaultRefreshAfterMs,
		SweepInterval:           DefaultSweepInterval,
		MaxLeases:               0, // store default
		MaxPendingIntroductions: 0, // store default
	}
}

// ConfigFromEnv reads the documented environment variables over the defaults.
//
// Nothing here reads a secret: the service holds no keys, and there is nothing
// for it to authenticate itself with.
func ConfigFromEnv() Config {
	c := DefaultConfig()
	// PORT is how most hosts (Render, Railway, Heroku) tell a service where to
	// listen, and they route to nothing else. Honoured first so a deploy works
	// with no configuration at all; NEX_RENDEZVOUS_ADDR still wins when set, so
	// a hand-run instance can bind whatever it likes.
	if v := os.Getenv("PORT"); v != "" {
		c.Addr = ":" + v
	}
	if v := os.Getenv("NEX_RENDEZVOUS_ADDR"); v != "" {
		c.Addr = v
	}
	c.TLSCertFile = os.Getenv("NEX_RENDEZVOUS_TLS_CERT")
	c.TLSKeyFile = os.Getenv("NEX_RENDEZVOUS_TLS_KEY")
	if v := envInt64("NEX_RENDEZVOUS_LEASE_TTL_MS"); v > 0 {
		c.LeaseTTLMs = v
	}
	if v := envInt64("NEX_RENDEZVOUS_REFRESH_AFTER_MS"); v > 0 {
		c.RefreshAfterMs = v
	}
	if v := envInt64("NEX_RENDEZVOUS_SWEEP_INTERVAL_MS"); v > 0 {
		c.SweepInterval = time.Duration(v) * time.Millisecond
	}
	if v := envInt64("NEX_RENDEZVOUS_MAX_LEASES"); v > 0 {
		c.MaxLeases = int(v)
	}
	if v := envInt64("NEX_RENDEZVOUS_MAX_INTRODUCTIONS"); v > 0 {
		c.MaxPendingIntroductions = int(v)
	}
	if v := os.Getenv("NEX_RENDEZVOUS_TRUST_PROXY"); v == "1" || v == "true" {
		c.TrustProxyHeaders = true
	}
	return c.normalized()
}

// normalized clamps configuration that would violate the contract if honoured.
func (c Config) normalized() Config {
	if c.Addr == "" {
		c.Addr = DefaultAddr
	}
	// A lease may never outlive the maximum life of the descriptors it serves.
	if c.LeaseTTLMs <= 0 || c.LeaseTTLMs > DefaultLeaseTTLMs {
		c.LeaseTTLMs = DefaultLeaseTTLMs
	}
	if c.RefreshAfterMs <= 0 {
		c.RefreshAfterMs = DefaultRefreshAfterMs
	}
	if c.RefreshAfterMs > c.LeaseTTLMs {
		c.RefreshAfterMs = c.LeaseTTLMs / 2
	}
	if c.SweepInterval <= 0 {
		c.SweepInterval = DefaultSweepInterval
	}
	return c
}

func envInt64(name string) int64 {
	v := os.Getenv(name)
	if v == "" {
		return 0
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		return 0
	}
	return n
}
