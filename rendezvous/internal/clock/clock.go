// Package clock provides the injectable time source used everywhere in the
// service, so expiry behaviour can be tested without sleeping.
package clock

import (
	"sync"
	"time"
)

// Clock is the time source. Everything that expires — leases, nonces,
// introductions, rate-limit buckets, IP bans — reads time through this.
type Clock interface {
	// Now returns the current time.
	Now() time.Time
	// NowMs returns the current time as unix milliseconds, the unit the wire
	// contract uses for every timestamp field.
	NowMs() int64
}

// Real is the production clock.
type Real struct{}

func (Real) Now() time.Time { return time.Now() }
func (Real) NowMs() int64   { return time.Now().UnixMilli() }

// Fake is a manually advanced clock for tests.
type Fake struct {
	mu sync.Mutex
	t  time.Time
}

// NewFake starts a fake clock at a fixed, arbitrary instant. The value is
// deliberately a round unix-ms number so failure messages are readable.
func NewFake() *Fake {
	return &Fake{t: time.UnixMilli(1756200000000).UTC()}
}

// NewFakeAt starts a fake clock at a specific unix-ms instant.
func NewFakeAt(ms int64) *Fake { return &Fake{t: time.UnixMilli(ms).UTC()} }

func (f *Fake) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t
}

func (f *Fake) NowMs() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.t.UnixMilli()
}

// Advance moves the fake clock forward.
func (f *Fake) Advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

// SetMs jumps the fake clock to an absolute unix-ms instant.
func (f *Fake) SetMs(ms int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = time.UnixMilli(ms).UTC()
}
