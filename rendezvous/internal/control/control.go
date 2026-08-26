// Package control implements the WebSocket control channel of
// RENDEZVOUS_WIRE_V1 §7.
//
// The channel exists to notify a node that someone is looking for it. It is not
// a transport and structurally cannot become one: the only frame the server
// will parse from a client is {"type":"ping","t":<int>}, decoded into a struct
// with no payload field and with unknown JSON fields rejected. There is no code
// path by which a client frame carries content (V3 §25).
//
// Presence is the lease; liveness is the socket. Dropping this channel does not
// drop the lease — that is the CONNECTED vs CONNECTABLE distinction of V3 §7,
// and the client reports the two states independently.
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"

	"nex.rendezvous/internal/protocol"
)

// IdleTimeout is the §7 idle timeout. Clients ping every 30 s.
const IdleTimeout = 90 * time.Second

// ExpiringLeadMs is when lease.expiring is sent: once, at expiresAt - 30000 ms.
const ExpiringLeadMs = 30000

// sendQueue bounds how much a slow or wedged client can make the service buffer.
// Introductions are best-effort by contract (§5.5): if the queue is full the
// frame is dropped rather than blocking the requester's HTTP handler.
const sendQueue = 16

// Conn is one attached control channel.
type Conn struct {
	leaseID string
	nodeID  string

	ws          *websocket.Conn
	send        chan []byte
	idleTimeout time.Duration

	closeOnce sync.Once
	closed    chan struct{}

	mu sync.Mutex
	// expiringFor is the lease deadline lease.expiring was last sent for. A
	// refresh moves the deadline, and the notice is due again for the new one.
	expiringFor int64
}

// NodeID reports which node this channel belongs to.
func (c *Conn) NodeID() string { return c.nodeID }

// LeaseID reports which lease authorized this channel.
func (c *Conn) LeaseID() string { return c.leaseID }

// trySend queues a frame. It never blocks: a client that cannot keep up loses
// frames, it does not slow the service down.
func (c *Conn) trySend(payload []byte) bool {
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.send <- payload:
		return true
	default:
		return false
	}
}

// Close shuts the channel down. Safe to call repeatedly and from any goroutine.
func (c *Conn) Close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		close(c.closed)
		_ = c.ws.Close(code, reason)
	})
}

// Hub tracks every attached control channel.
//
// At most one channel per lease (§8). A second upgrade for the same lease
// displaces the first rather than being refused: a client whose socket died
// half-open must be able to get back in without waiting out the 90 s idle
// timeout, and "one live channel" is still true at every instant.
type Hub struct {
	mu      sync.Mutex
	byLease map[string]*Conn

	// idleTimeoutOverride lets tests shorten the §7 idle timeout. Zero means
	// the contract value; there is no way to raise it above IdleTimeout from
	// configuration, because 90 s is what §7 says.
	idleTimeoutOverride time.Duration
}

// NewHub builds an empty hub.
func NewHub() *Hub { return &Hub{byLease: make(map[string]*Conn)} }

// SetIdleTimeout overrides the per-read idle window. Test-facing: the
// WebSocket read deadline runs on wall-clock time, which no injected clock can
// advance, so shortening the window is the only way to exercise the timeout
// without sleeping. Production callers never do this.
func (h *Hub) SetIdleTimeout(d time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.idleTimeoutOverride = d
}

func (h *Hub) idleTimeoutLocked() time.Duration {
	if h.idleTimeoutOverride > 0 && h.idleTimeoutOverride < IdleTimeout {
		return h.idleTimeoutOverride
	}
	return IdleTimeout
}

// add registers a channel, displacing any existing one for the same lease.
func (h *Hub) add(c *Conn) {
	h.mu.Lock()
	prev, existed := h.byLease[c.leaseID]
	h.byLease[c.leaseID] = c
	h.mu.Unlock()
	if existed && prev != c {
		prev.Close(websocket.StatusNormalClosure, "replaced by a newer control channel")
	}
}

// remove unregisters a channel if it is still the current one for its lease.
func (h *Hub) remove(c *Conn) {
	h.mu.Lock()
	if cur, ok := h.byLease[c.leaseID]; ok && cur == c {
		delete(h.byLease, c.leaseID)
	}
	h.mu.Unlock()
}

// Count reports live control-channel attachments — §5.8's nodesConnected,
// before bucketing.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.byLease)
}

// SendToLease delivers one server -> client frame. Delivery is best-effort: the
// requester learns the outcome only through §5.6's response, or not at all.
func (h *Hub) SendToLease(leaseID string, frame any) bool {
	h.mu.Lock()
	c := h.byLease[leaseID]
	h.mu.Unlock()
	if c == nil {
		return false
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return false
	}
	if len(payload) > protocol.MaxFrameBytes {
		// A frame the contract's own cap forbids is a bug, not something to
		// truncate and ship.
		return false
	}
	return c.trySend(payload)
}

// CloseLease drops the channel for a lease that no longer exists. Called when
// the sweeper reclaims a lapsed lease and on unregister.
func (h *Hub) CloseLease(leaseID string) {
	h.mu.Lock()
	c := h.byLease[leaseID]
	h.mu.Unlock()
	if c != nil {
		c.Close(websocket.StatusNormalClosure, "lease no longer live")
	}
}

// LeaseIDs snapshots the attached lease IDs.
func (h *Hub) LeaseIDs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.byLease))
	for id := range h.byLease {
		out = append(out, id)
	}
	return out
}

// NotifyExpiring sends lease.expiring once per lease deadline, at
// expiresAt - 30000 ms. Driven from the service's background tick.
func (h *Hub) NotifyExpiring(leaseID string, expiresAt, nowMs int64) {
	h.mu.Lock()
	c := h.byLease[leaseID]
	h.mu.Unlock()
	if c == nil {
		return
	}
	if nowMs < expiresAt-ExpiringLeadMs {
		return
	}
	c.mu.Lock()
	already := c.expiringFor == expiresAt
	if !already {
		c.expiringFor = expiresAt
	}
	c.mu.Unlock()
	if already {
		return
	}
	payload, err := json.Marshal(protocol.LeaseExpiringFrame{
		Type:      protocol.FrameLeaseExpiring,
		ExpiresAt: expiresAt,
	})
	if err != nil {
		return
	}
	c.trySend(payload)
}

// CloseAll shuts every channel down. Used on service shutdown.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	conns := make([]*Conn, 0, len(h.byLease))
	for _, c := range h.byLease {
		conns = append(conns, c)
	}
	h.byLease = make(map[string]*Conn)
	h.mu.Unlock()
	for _, c := range conns {
		c.Close(websocket.StatusGoingAway, "service shutting down")
	}
}

// Serve takes an accepted WebSocket and runs it until it closes.
//
// It blocks, so callers run it on the request goroutine.
func (h *Hub) Serve(ctx context.Context, ws *websocket.Conn, leaseID, nodeID string) {
	ws.SetReadLimit(protocol.MaxFrameBytes)

	c := &Conn{
		leaseID:     leaseID,
		nodeID:      nodeID,
		ws:          ws,
		send:        make(chan []byte, sendQueue),
		closed:      make(chan struct{}),
		idleTimeout: h.idleTimeoutLocked(),
	}
	h.add(c)

	ctx, cancel := context.WithCancel(ctx)
	defer func() {
		cancel()
		h.remove(c)
		c.Close(websocket.StatusNormalClosure, "")
	}()

	go c.writeLoop(ctx)
	c.readLoop(ctx)
}

func (c *Conn) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.closed:
			return
		case payload := <-c.send:
			wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := c.ws.Write(wctx, websocket.MessageText, payload)
			cancel()
			if err != nil {
				c.Close(websocket.StatusInternalError, "write failed")
				return
			}
		}
	}
}

// readLoop enforces the §7 client-frame rule.
//
// Anything that is not exactly {"type":"ping","t":<int>} closes the connection
// with 1008. Note what is NOT here: there is no default branch that forwards an
// unrecognised frame anywhere, no payload field to read, and no map[string]any
// that could carry one. The absence is the guarantee.
func (c *Conn) readLoop(ctx context.Context) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, c.idleTimeout)
		typ, data, err := c.ws.Read(readCtx)
		cancel()
		if err != nil {
			c.Close(websocket.StatusNormalClosure, "")
			return
		}
		if typ != websocket.MessageText {
			c.Close(websocket.StatusPolicyViolation, "unsupported frame")
			return
		}
		frame, ok := parseClientFrame(data)
		if !ok {
			c.Close(websocket.StatusPolicyViolation, "unsupported frame")
			return
		}
		payload, err := json.Marshal(protocol.PongFrame{Type: protocol.FramePong, T: frame.T})
		if err != nil {
			c.Close(websocket.StatusInternalError, "")
			return
		}
		if !c.trySend(payload) {
			// The client is not draining its own pongs; nothing useful is left
			// to do on this socket.
			c.Close(websocket.StatusPolicyViolation, "client is not reading")
			return
		}
	}
}

// parseClientFrame decodes the one and only accepted client frame.
//
// DisallowUnknownFields is what makes the ping-only rule structural rather than
// conventional: a frame carrying an extra field — a body, a payload, a "to" —
// is rejected outright instead of being silently ignored, so no future edit can
// accidentally start reading one.
func parseClientFrame(data []byte) (protocol.ClientFrame, bool) {
	if len(data) > protocol.MaxFrameBytes {
		return protocol.ClientFrame{}, false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var f protocol.ClientFrame
	if err := dec.Decode(&f); err != nil {
		return protocol.ClientFrame{}, false
	}
	// Exactly one JSON value per frame; trailing content is not a ping.
	if dec.More() {
		return protocol.ClientFrame{}, false
	}
	if f.Type != protocol.FramePing {
		return protocol.ClientFrame{}, false
	}
	return f, true
}
