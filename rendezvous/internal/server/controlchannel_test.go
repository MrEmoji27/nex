package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"nex.rendezvous/internal/apierr"
	"nex.rendezvous/internal/protocol"
	"nex.rendezvous/internal/ratelimit"
)

// The §7 control channel is exercised over a real WebSocket (httptest.Server +
// websocket.Dial), because the interesting behaviour — close codes, frame
// caps, displacement — lives in the socket lifecycle.
//
// Two mechanical notes:
//   - Every connection is served by ONE background reader goroutine whose
//     context is never cancelled. In coder/websocket, letting a Read context
//     expire closes the whole connection, so short-lived read contexts cannot
//     be used for "expect nothing" assertions; events are observed through a
//     channel instead.
//   - The idle timeout runs on the wall clock, which no injected clock can
//     advance. Those tests shorten the window through Hub.SetIdleTimeout and
//     then wait on blocking I/O only — never on sleeps.

func startWSServer(t *testing.T, h *harness) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(h.srv.Handler())
	t.Cleanup(s.Close)
	return s
}

func wsURL(httpURL string) string {
	return "ws://" + strings.TrimPrefix(httpURL, "http://") + "/v1/control"
}

// controlHeaders signs the §7 upgrade envelope for one attempt.
func (h *harness) controlHeaders(id *identity, leaseID string) http.Header {
	now := h.now()
	nonce := nextNonce()
	sig := id.sign(protocol.ControlSigningInput(id.nodeID, id.signPub, now, nonce, leaseID))
	hd := http.Header{}
	hd.Set(protocol.HeaderNode, id.nodeID)
	hd.Set(protocol.HeaderKey, id.signPub)
	hd.Set(protocol.HeaderIssued, strconv.FormatInt(now, 10))
	hd.Set(protocol.HeaderNonce, nonce)
	hd.Set(protocol.HeaderSig, sig)
	hd.Set(protocol.HeaderLease, leaseID)
	return hd
}

func dialControl(t *testing.T, base string, hdr http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, wsURL(base), &websocket.DialOptions{HTTPHeader: hdr})
}

func writeText(t *testing.T, c *websocket.Conn, payload string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
		t.Fatalf("write %q: %v", payload, err)
	}
}

func pingJSON(tv int64) string {
	return `{"type":"ping","t":` + strconv.FormatInt(tv, 10) + `}`
}

// wsChan carries everything one connection receives, in order.
type wsEvent struct {
	data []byte
	err  error
}

func startWSReader(t *testing.T, c *websocket.Conn) <-chan wsEvent {
	t.Helper()
	ch := make(chan wsEvent, 16)
	go func() {
		for {
			typ, data, err := c.Read(context.Background())
			if err != nil {
				ch <- wsEvent{err: err}
				return
			}
			if typ == websocket.MessageText {
				ch <- wsEvent{data: data}
			}
		}
	}()
	return ch
}

// readFrame waits for the next text frame or fails.
func readFrame(t *testing.T, ch <-chan wsEvent) []byte {
	t.Helper()
	select {
	case ev := <-ch:
		if ev.err != nil {
			t.Fatalf("expected a frame, connection closed: %v", ev.err)
		}
		return ev.data
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a frame")
		return nil
	}
}

// pingPong does one full round trip and checks the echo.
func pingPong(t *testing.T, c *websocket.Conn, ch <-chan wsEvent, tv int64) {
	t.Helper()
	writeText(t, c, pingJSON(tv))
	var pong protocol.PongFrame
	if err := json.Unmarshal(readFrame(t, ch), &pong); err != nil {
		t.Fatalf("pong was not JSON: %v", err)
	}
	if pong.Type != protocol.FramePong || pong.T != tv {
		t.Fatalf("pong = %+v, want type=pong t=%d", pong, tv)
	}
}

// expectClose waits for the connection to close and reports its close code.
func expectClose(t *testing.T, ch <-chan wsEvent) websocket.StatusCode {
	t.Helper()
	for {
		select {
		case ev := <-ch:
			if ev.err != nil {
				return websocket.CloseStatus(ev.err)
			}
			continue // drain queued server frames before the close
		case <-time.After(10 * time.Second):
			t.Fatalf("connection never closed")
			return -1
		}
	}
}

// expectCloseErr waits for the connection to end and reports the close code
// and raw error; the error is nil only on timeout.
func expectCloseErr(t *testing.T, ch <-chan wsEvent) (websocket.StatusCode, error) {
	t.Helper()
	return expectCloseErrWithin(t, ch, 10*time.Second)
}

// expectCloseErrWithin is expectCloseErr with a custom window, for paths whose
// teardown timing belongs to the OS rather than to the service.
func expectCloseErrWithin(t *testing.T, ch <-chan wsEvent, window time.Duration) (websocket.StatusCode, error) {
	t.Helper()
	for {
		select {
		case ev := <-ch:
			if ev.err != nil {
				return websocket.CloseStatus(ev.err), ev.err
			}
			continue
		case <-time.After(window):
			t.Fatalf("connection never closed within %v", window)
			return -1, nil
		}
	}
}

// expectSilence asserts that no FRAME arrives within d. A close event inside
// the window is reported, since "quietly open" is the thing under test.
func expectSilence(t *testing.T, ch <-chan wsEvent, d time.Duration) {
	t.Helper()
	select {
	case ev := <-ch:
		if ev.err != nil {
			t.Fatalf("connection closed while expecting silence: %v", ev.err)
		}
		t.Fatalf("unexpected frame while expecting silence: %s", ev.data)
	case <-time.After(d):
	}
}

// httpErrCode extracts the §5.9 code from a non-upgraded HTTP response.
func httpErrCode(t *testing.T, r *http.Response) apierr.Code {
	t.Helper()
	if r == nil {
		t.Fatal("no response to inspect")
	}
	defer r.Body.Close()
	var e apierr.Error
	if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
		t.Fatalf("response was not a §5.9 error envelope: %v", err)
	}
	return e.Error.Code
}

func respStatus(r *http.Response) int {
	if r == nil {
		return -1
	}
	return r.StatusCode
}

// awaitAttached waits until the hub reports the lease's channel. websocket.Dial
// returns as soon as the CLIENT processed the 101, which can beat the server
// goroutine to hub.add; acting on the hub before attachment lands would race.
func awaitAttached(t *testing.T, h *harness, leaseID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, id := range h.srv.Hub().LeaseIDs() {
			if id == leaseID {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("channel for lease %s never became attached", leaseID)
}

// dialFor registers id under handle and opens its control channel.
func dialFor(t *testing.T, h *harness, base string, id *identity, handle string) (*websocket.Conn, <-chan wsEvent, protocol.RegisterResponse) {
	t.Helper()
	lease := h.mustRegister(id, handle)
	c, resp, err := dialControl(t, base, h.controlHeaders(id, lease.LeaseID))
	if err != nil {
		t.Fatalf("upgrade: %v (http %v)", err, respStatus(resp))
	}
	awaitAttached(t, h, lease.LeaseID)
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return c, startWSReader(t, c), lease
}

// liftControlLimits raises the §8 rows a socket test would otherwise trip by
// registering/dialing repeatedly. Only tests asserting the limits themselves
// leave them alone.
func liftControlLimits(h *harness) {
	h.srv.Limiter().SetRule(ratelimit.OpRegister, ratelimit.Rule{PerNode: 1000, PerIP: 1000})
	h.srv.Limiter().SetRule(ratelimit.OpControl, ratelimit.Rule{PerNode: 1000, PerIP: 1000})
}

// TestControlUpgradeRejectsBadLease: the upgrade is authenticated like any
// other endpoint; an unknown leaseId is 404 lease_expired with no upgrade.
func TestControlUpgradeRejectsBadLease(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	base := startWSServer(t, h).URL

	// Unknown lease.
	_, httpResp, err := dialControl(t, base, h.controlHeaders(zro, strings.Repeat("ab", 16)))
	if err == nil {
		t.Fatalf("upgrade with unknown lease succeeded")
	}
	if respStatus(httpResp) != http.StatusNotFound || httpErrCode(t, httpResp) != apierr.LeaseExpired {
		t.Fatalf("unknown lease upgrade = %v / %v", respStatus(httpResp), httpErrCode(t, httpResp))
	}

	// Missing header entirely → invalid_request 400 before anything else.
	hdr := h.controlHeaders(zro, strings.Repeat("cd", 16))
	hdr.Del(protocol.HeaderLease)
	if _, httpResp2, err := dialControl(t, base, hdr); err == nil || respStatus(httpResp2) != http.StatusBadRequest {
		t.Fatalf("missing X-Nex-Lease = %v / %v", respStatus(httpResp2), err)
	}

	// A valid lease upgrades fine.
	lease := h.mustRegister(zro, "zro-two")
	c, _, err := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
	if err != nil {
		t.Fatalf("valid upgrade failed: %v", err)
	}
	awaitAttached(t, h, lease.LeaseID)
	c.Close(websocket.StatusNormalClosure, "")
}

// --- the ping-only rule, end to end ---

// TestControlOnlyPingSurvives is THE security property: every non-ping client
// frame — including every server-side frame name, casing games, content-
// carrying extras and binary framing — closes the channel with 1008, and a
// plain ping keeps working right up to the moment the rule fires.
func TestControlOnlyPingSurvives(t *testing.T) {
	h := newHarness(t)
	liftControlLimits(h)
	zro := newIdentity("zro")
	base := startWSServer(t, h).URL

	frames := []string{
		`{"type":"introduction.request","requestId":"x","fromHandle":"zro"}`,
		`{"type":"introduction.response","requestId":"x","accept":true}`,
		`{"type":"lease.expiring","expiresAt":123}`,
		`{"type":"pong","t":1}`,
		`{"type":"","t":1}`,
		`{"type":"ping ","t":1}`,
		`{"type":"PING","t":1}`,
		`{"type":"message","to":"roshan","body":"are you there?"}`,
		`[1,2,3]`,
		`not json at all`,
	}
	for _, frame := range frames {
		c, ch, _ := dialFor(t, h, base, zro, "zro")

		pingPong(t, c, ch, 42) // alive before the offence

		writeText(t, c, frame)

		if got := expectClose(t, ch); got != websocket.StatusPolicyViolation {
			t.Fatalf("frame %q: close code = %v, want 1008 PolicyViolation", frame, got)
		}
	}

	// Binary framing of an otherwise-perfect ping: still refused.
	c, ch, _ := dialFor(t, h, base, zro, "zro-bin")
	pingPong(t, c, ch, 41)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	err := c.Write(ctx, websocket.MessageBinary, []byte(pingJSON(1)))
	cancel()
	if err != nil {
		t.Fatalf("binary write: %v", err)
	}
	if got := expectClose(t, ch); got != websocket.StatusPolicyViolation {
		t.Fatalf("binary ping: close code = %v, want 1008", got)
	}

	// An unknown field on an otherwise-valid ping is refused too — this is
	// what makes the rule structural rather than a naming convention.
	c2, ch2, _ := dialFor(t, h, base, zro, "zro-field")
	pingPong(t, c2, ch2, 40)
	writeText(t, c2, `{"type":"ping","t":1,"payload":"smuggled"}`)
	if got := expectClose(t, ch2); got != websocket.StatusPolicyViolation {
		t.Fatalf("extra-field ping: close code = %v, want 1008", got)
	}

	// And the hub really has nobody attached after all that.
	waitForHubCount(t, h, 0)
}

// TestControlFrameCapIs8192 drives the §7 cap over the wire: exactly 8192
// bytes passes (a padded-but-valid ping), one byte more kills the connection.
func TestControlFrameCapIs8192(t *testing.T) {
	h := newHarness(t)
	liftControlLimits(h)
	zro := newIdentity("zro")
	base := startWSServer(t, h).URL
	c, ch, _ := dialFor(t, h, base, zro, "zro")

	// Exactly at the cap: canonical ping plus trailing spaces (legal JSON).
	baseJSON := pingJSON(1756200000000)
	atCap := baseJSON + strings.Repeat(" ", protocol.MaxFrameBytes-len(baseJSON))
	if len(atCap) != protocol.MaxFrameBytes {
		t.Fatalf("construction = %d bytes", len(atCap))
	}
	writeText(t, c, atCap)
	var pong protocol.PongFrame
	if err := json.Unmarshal(readFrame(t, ch), &pong); err != nil || pong.T != 1756200000000 {
		t.Fatalf("exact-cap ping not answered: %v %+v", err, pong)
	}

	// One byte over: the connection dies.
	over := baseJSON + strings.Repeat(" ", protocol.MaxFrameBytes-len(baseJSON)+1)
	writeText(t, c, over)
	if got := expectClose(t, ch); got == -1 {
		t.Fatal("oversized frame did not close the connection")
	}
}

// TestOneLiveChannelPerLease covers §8's extra column: a second upgrade for
// the same lease displaces the first, so one live channel per lease holds at
// every instant without stranding a half-open client for 90 s.
func TestOneLiveChannelPerLease(t *testing.T) {
	h := newHarness(t)
	liftControlLimits(h)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")
	base := startWSServer(t, h).URL

	first, _, err := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
	if err != nil {
		t.Fatalf("first upgrade: %v", err)
	}
	awaitAttached(t, h, lease.LeaseID)
	firstCh := startWSReader(t, first)
	pingPong(t, first, firstCh, 1)

	second, _, err := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
	if err != nil {
		t.Fatalf("second upgrade: %v", err)
	}
	t.Cleanup(func() { second.Close(websocket.StatusNormalClosure, "") })
	secondCh := startWSReader(t, second)
	awaitAttached(t, h, lease.LeaseID) // replacement registered...

	if got := expectClose(t, firstCh); got != websocket.StatusNormalClosure {
		t.Fatalf("displaced channel closed with %v, want 1000 normal closure", got)
	}
	if n := h.srv.Hub().Count(); n != 1 {
		t.Fatalf("hub count = %d during displacement, want 1", n)
	}
	// The replacement is fully functional.
	pingPong(t, second, secondCh, 2)
}

// TestDroppedChannelDoesNotDropLease is the CONNECTED vs CONNECTABLE
// distinction of V3 §7: presence is the lease, liveness is the socket.
func TestDroppedChannelDoesNotDropLease(t *testing.T) {
	h := newHarness(t)
	liftControlLimits(h)
	zro := newIdentity("zro")
	watcher := newIdentity("watcher")
	h.mustRegister(watcher, "watcher")
	base := startWSServer(t, h).URL

	c, ch, lease := dialFor(t, h, base, zro, "zro")
	pingPong(t, c, ch, 9)

	// CONNECTED: attached. CONNECTABLE: live lease. Both true.
	if n := h.srv.Hub().Count(); n != 1 {
		t.Fatalf("hub count = %d while attached", n)
	}
	if l := h.srv.Store().LeaseByID(lease.LeaseID); l == nil {
		t.Fatal("lease missing while connected")
	}

	// Drop the channel from the client side. The server answers the close
	// handshake; the reader sees it as the stream ending.
	c.Close(websocket.StatusNormalClosure, "")
	select {
	case ev := <-ch:
		if ev.err == nil {
			t.Fatalf("unexpected frame during client close: %s", ev.data)
		}
		if got := websocket.CloseStatus(ev.err); got != websocket.StatusNormalClosure {
			t.Fatalf("client-initiated close surfaced as %v (%v)", got, ev.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server never finished the close handshake")
	}

	// The lease survives untouched — discoverable, refreshable, unexpired.
	if l := h.srv.Store().LeaseByID(lease.LeaseID); l == nil {
		t.Fatal("dropping the control channel dropped the lease")
	}
	w := h.search(watcher, "zro")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"nodeId":"`+zro.nodeID+`"`) {
		t.Fatalf("node not discoverable after channel drop: %d %s", w.Code, w.Body.String())
	}
	if n := h.srv.Hub().Count(); n != 0 {
		t.Fatalf("hub count = %d after drop, want 0", n)
	}
	// Re-attachment works without re-registering.
	c2, _, err := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
	if err != nil {
		t.Fatalf("re-attach: %v", err)
	}
	awaitAttached(t, h, lease.LeaseID)
	c2Ch := startWSReader(t, c2)
	pingPong(t, c2, c2Ch, 10)
}

// TestLeaseExpiringEmittedAtLeadTime drives the §7 notification from the fake
// clock through Sweep(): once, at exactly expiresAt-30000; silent before;
// never duplicated; re-armed by a refresh that moves the deadline.
func TestLeaseExpiringEmittedAtLeadTime(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	base := startWSServer(t, h).URL

	_, ch, lease := dialFor(t, h, base, zro, "zro")
	expiresAt := lease.ExpiresAt

	readExpiring := func() *protocol.LeaseExpiringFrame {
		var f protocol.LeaseExpiringFrame
		if err := json.Unmarshal(readFrame(t, ch), &f); err != nil {
			t.Fatalf("lease.expiring parse: %v", err)
		}
		return &f
	}

	// One millisecond before the lead line: silence.
	h.clk.SetMs(expiresAt - 30001)
	h.srv.Sweep()
	expectSilence(t, ch, 250*time.Millisecond)

	// At the lead line: exactly one notice.
	h.clk.SetMs(expiresAt - 30000)
	h.srv.Sweep()
	if f := readExpiring(); f.Type != protocol.FrameLeaseExpiring || f.ExpiresAt != expiresAt {
		t.Fatalf("notice = %+v, want expiresAt=%d", f, expiresAt)
	}
	// Same deadline again: never a duplicate.
	h.srv.Sweep()
	expectSilence(t, ch, 250*time.Millisecond)

	// Refresh moves the deadline; the notice re-arms for it.
	h.clk.Advance(10 * time.Second)
	now := h.now()
	full := protocol.RefreshRequest{
		NodeID: zro.nodeID, SignPub: zro.signPub, IssuedAt: now, Nonce: nextNonce(),
		LeaseID:           lease.LeaseID,
		PublicDescriptor:  zro.publicDesc("zro", now),
		ContactDescriptor: zro.contactDesc("zro", now),
	}
	full.Sig = zro.sign(full.SigningInput())
	if w := h.do(http.MethodPost, "/v1/presence/refresh", full, nil); w.Code != http.StatusOK {
		t.Fatalf("refresh = %d %s", w.Code, w.Body.String())
	}
	newDeadline := now + 90000

	// Well before the NEW lead line: still silent.
	h.clk.SetMs(newDeadline - 30001)
	h.srv.Sweep()
	expectSilence(t, ch, 250*time.Millisecond)

	// New lead line: second notice, carrying the moved deadline.
	h.clk.SetMs(newDeadline - 30000)
	h.srv.Sweep()
	if f := readExpiring(); f.ExpiresAt != newDeadline {
		t.Fatalf("second notice = %+v, want expiresAt=%d", f, newDeadline)
	}
}

// waitForHubCount polls until the hub holds n channels. The removal of a
// closed channel happens asynchronously on the serving goroutine, so an
// instant check would race it.
func waitForHubCount(t *testing.T, h *harness, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if h.srv.Hub().Count() == n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("hub count never reached %d (is %d)", n, h.srv.Hub().Count())
}

// TestSweeperClosesChannelOfLapsedLease: when the lease finally lapses, the
// sweeper closes attached channels (1000) and empties the hub — CONNECTED
// implies CONNECTABLE, never the reverse.
func TestSweeperClosesChannelOfLapsedLease(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	base := startWSServer(t, h).URL

	_, ch, lease := dialFor(t, h, base, zro, "zro")

	h.clk.Advance(91 * time.Second)
	h.srv.Sweep()

	// The contract fixes what this closure MEANS (the channel stops counting
	// as connected; the lease is reclaimed) but not its close code, and on
	// Windows the TCP teardown can race the close frame into an abrupt EOF.
	// So: any stream end is acceptance; the hub and store states are the
	// assertions that matter.
	if got, raw := expectCloseErr(t, ch); raw == nil {
		t.Fatalf("expected the lapsed lease to end the channel, got close status %v", got)
	}
	waitForHubCount(t, h, 0)
	if h.srv.Store().LeaseByID(lease.LeaseID) != nil {
		t.Fatal("lease survived its own sweep")
	}
}

// TestShutdownClosesAllChannels: GoingAway on shutdown, per CloseAll.
func TestShutdownClosesAllChannels(t *testing.T) {
	h := newHarness(t)
	a, b := newIdentity("alpha"), newIdentity("bravo")
	base := startWSServer(t, h).URL

	_, cha, _ := dialFor(t, h, base, a, "alpha")
	_, chb, _ := dialFor(t, h, base, b, "bravo")

	h.srv.Shutdown()

	// The contract-relevant fact: nothing counts as CONNECTED after shutdown.
	waitForHubCount(t, h, 0)
	for name, ch := range map[string]<-chan wsEvent{"alpha": cha, "bravo": chb} {
		// The sockets follow eventually; on Windows the teardown of an idle
		// hijacked connection can lag well behind the logical close.
		if got, raw := expectCloseErrWithin(t, ch, 25*time.Second); raw == nil {
			t.Fatalf("channel %s survived shutdown (status %v)", name, got)
		}
	}
}

// TestIdleTimeoutClosesQuietChannel shortens the §7 window and proves a
// quiet channel is torn down by the SERVER at the deadline. Note what is
// asserted and why: §7 fixes the timeout (90 s) but not a close code for it,
// and in coder/websocket a read whose context expires fails the connection
// before any close frame can be written — so the client observes an abrupt
// EOF. The contract-relevant fact is that the dead channel stops counting as
// CONNECTED.
func TestIdleTimeoutClosesQuietChannel(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.srv.Hub().SetIdleTimeout(150 * time.Millisecond)
	base := startWSServer(t, h).URL

	_, ch, _ := dialFor(t, h, base, zro, "zro")

	// expectCloseErr fails unless the reader observes the connection ending
	// within its window. The observed end is an EOF without a close frame
	// (see note above); any close frame the library does manage to send would
	// also be acceptable.
	got, raw := expectCloseErr(t, ch)
	if raw == nil {
		t.Fatalf("expected the idle deadline to end the stream, got close status %v", got)
	}
	waitForHubCount(t, h, 0)
}

// TestPingsKeepChannelAlive proves the same window is pushed forward by
// client pings: with a 150 ms timeout, pinging every 50 ms for well past the
// timeout keeps the channel open, and stopping the pings ends it.
func TestPingsKeepChannelAlive(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	h.srv.Hub().SetIdleTimeout(150 * time.Millisecond)
	base := startWSServer(t, h).URL

	c, ch, _ := dialFor(t, h, base, zro, "zro")

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		tv := int64(100)
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				tv++
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				err := c.Write(ctx, websocket.MessageText, []byte(pingJSON(tv)))
				cancel()
				if err != nil {
					return
				}
			}
		}
	}()

	// Drain pongs for 700 ms across a 150 ms idle window (>4x): every ping
	// must be answered, proving the channel stayed open throughout.
	deadline := time.Now().Add(700 * time.Millisecond)
	pongs := 0
	for time.Now().Before(deadline) {
		var pf protocol.PongFrame
		if err := json.Unmarshal(readFrame(t, ch), &pf); err != nil || pf.Type != "pong" {
			t.Fatalf("expected pongs, got %v (%v)", pf, err)
		}
		pongs++
	}
	close(stop)
	<-done
	if pongs < 8 {
		t.Fatalf("only %d pongs in 700 ms — channel was dropping activity", pongs)
	}

	// Channel is still usable right now.
	writeText(t, c, pingJSON(999))
	var pong protocol.PongFrame
	if err := json.Unmarshal(readFrame(t, ch), &pong); err != nil || pong.T != 999 {
		t.Fatalf("channel dead despite steady pings: %v %+v", err, pong)
	}

	// Quiet now: the idle window tears the channel down (abruptly — see the
	// idle-test note about close codes).
	if got, raw := expectCloseErr(t, ch); got == -1 && raw == nil {
		t.Fatal("channel survived idleness after pings stopped")
	}
	waitForHubCount(t, h, 0)
}

// TestControlUpgradeIsRateLimited ties §8 to §7: control upgrades are limited
// per node (6/min); the seventh upgrade in a minute is refused with 429 and
// Retry-After before any upgrade happens.
func TestControlUpgradeIsRateLimited(t *testing.T) {
	h := newHarness(t)
	zro := newIdentity("zro")
	lease := h.mustRegister(zro, "zro")
	h.srv.Limiter().SetRule(ratelimit.OpControl, ratelimit.Rule{PerNode: 6, PerIP: 600})
	base := startWSServer(t, h).URL

	for i := 0; i < 6; i++ {
		c, resp, err := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
		if err != nil {
			t.Fatalf("upgrade %d refused early: %v (%v)", i+1, err, respStatus(resp))
		}
		c.Close(websocket.StatusNormalClosure, "")
		// Give the server handler a moment-free way out: displacement is not
		// needed here, distinct leases would be, so burn the node bucket only.
		_ = i
	}
	_, lastResp, lastErr := dialControl(t, base, h.controlHeaders(zro, lease.LeaseID))
	if lastErr == nil || respStatus(lastResp) != http.StatusTooManyRequests {
		t.Fatalf("7th upgrade = %v / %v, want HTTP 429", respStatus(lastResp), lastErr)
	}
	if ra := lastResp.Header.Get("Retry-After"); ra == "" {
		t.Fatal("429 without Retry-After")
	}
}
