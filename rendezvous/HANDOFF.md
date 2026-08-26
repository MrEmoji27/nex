# Worker A2 handoff — rendezvous/

Written at completion of the "finish the Go test suite" task (worker-a branch).
Everything below reflects commands actually run in this worktree.

## Verification status — this exact output, just now

```
$ cd rendezvous
$ go build ./...      # clean, no output
$ go vet ./...        # clean, no output
$ gofmt -l .          # clean, no output
$ go test ./... -count=1
ok   nex.rendezvous/internal/apierr       0.7s
ok   nex.rendezvous/internal/conformance  0.6s   (coordinator-owned; semantics untouched,
                                            committed bytes are a line-ending
                                            normalization only — no code change)
ok   nex.rendezvous/internal/control      0.7s
ok   nex.rendezvous/internal/descriptor   0.5s
ok   nex.rendezvous/internal/handle       0.5s
ok   nex.rendezvous/internal/ratelimit    0.5s
ok   nex.rendezvous/internal/server       3.0s
ok   nex.rendezvous/internal/store        0.5s
ok   nex.rendezvous/internal/wire         0.5s
```

**151 top-level test functions across 9 packages** (`rg -c "func Test" --glob "**/*_test.go"`:
wire 9, handle 8, apierr 10, descriptor 17, store 18, ratelimit 17, control 12,
server 51 [integration 17 + controlchannel 11 + abuse 9 + amendments 3 + restart 1],
conformance 9). Several expand into subtests (RFC 8032 vectors run per-direction,
descriptor structure tables run per-row).

## What this task added

### internal/control (was: zero tests)
- **Ping-only client frame rule as a security property**: every non-ping type
  (including all four server→client frame names, casing games, empty type) is
  rejected; content-carrying extras (`payload`, `body`, `to`, …) are rejected via
  DisallowUnknownFields; malformed/trailing/two-frame encodings rejected.
  `TestClientFrameStructurallyCarriesNoContent` asserts by reflection that
  `protocol.ClientFrame` has exactly two scalar fields `{Type,T}` and fails if a
  Payload/Body/Data/To/From-like field ever appears.
- 8192-byte cap inside the parser (exact-cap valid ping accepted, +1 byte refused).
- Hub registry: one channel per lease, remove() identity check, best-effort send
  (unattached → false, oversized → refused not truncated, full queue → dropped
  without blocking, closed channel → false).
- `lease.expiring` driven by explicit times through NotifyExpiring: silent one
  millisecond before `expiresAt-30000`, exactly once at the lead line, never
  duplicated, re-armed when refresh moves the deadline.

### internal/server — WebSocket end-to-end (new file controlchannel_test.go)
Real sockets (httptest.Server + websocket.Dial). Covers §7 over the wire:
upgrade auth failures (404 lease_expired / 400 invalid_request, no upgrade);
ping→pong echo; **1008 PolicyViolation on every non-ping client frame**, including
binary framing of a perfect ping and unknown-field smuggling; frame-cap boundary
(8192 passes with pong, 8193 kills the connection); one-live-channel-per-lease
displacement (first gets 1000 normal closure, replacement fully functional);
**CONNECTED vs CONNECTABLE** — dropping the channel leaves the lease live,
searchable, re-attachable; `lease.expiring` emitted through Sweep at exactly
expiresAt−30000 from the fake clock, once only, re-armed after refresh;
sweeper/shutdown teardown empties the hub; idle timeout tears quiet channels down
(window shortened via `Hub.SetIdleTimeout`, see code changes); control upgrades
rate-limited (7th upgrade = 429 with Retry-After).

### internal/server — V3 §38 abuse (new file abuse_test.go)
Enumeration probes always 200/null and never match wildcards/prefixes; no listing
endpoint under any spelling; handle probing bounded by the §8 per-target extra
column even against nonexistent handles (charged before target lookup, by design);
registration floods cut off per-node then per-IP with rotation; global lease cap
refuses with **503 internal** without evicting live users; intro request floods
bounded; oversized payload boundaries (8193 → 413 unread; exactly 8192 parses then
400; lying Content-Length still caught by the read bound); repeated invalid
signatures drive the §8 IP ban end-to-end (9×401, 10th strike arms it, next valid
request from that source = 429 Retry-After≈300 while other IPs unaffected, ban
lifts via injected clock); 60× replayed nonces all 401 replayed_nonce including
cross-endpoint reuse; malformed traffic always gets the §5.9 envelope.

### internal/server — Amendment regressions (new file amendments_test.go)
- **A2**: unknown / expired / wrong-responder respond rejections have identical
  status AND byte-identical bodies; legitimate accept still works afterwards and
  consumes (double respond → introduction_expired).
- **A3**: refreshed deadline equals min(now+90000, pub.expiresAt, contact.expiresAt)
  with each term exercised as the minimum; descriptor-less refresh refused in all
  three partial shapes without touching the lease. (Mandatory-on-refresh was
  already covered by integration_test.go.)

### internal/server — service restart (new file restart_test.go)
Second `server.New` knows nothing: every leaseId/handle/node lookup nil, counts 0,
hub empty, searches null, metrics zeroed — while the OLD instance still holds its
three leases (proving state was process memory, not global). Nodes re-register on
the fresh service (§9 recovery path).

### Production code changes (minimal, both test-enabling or bug-fixing)

1. **`internal/control`: `Hub.SetIdleTimeout`** — lets tests shorten the §7 idle
   window (WebSocket read deadlines run on wall time no injected clock can move).
   Default stays 90 s; there is deliberately no way to raise it above IdleTimeout.
2. **REAL BUG FIXED — `internal/server.authenticate` burned an IP token on every
   node-limited refusal.** Sequence per request: Allow(op,"",ip) charges per-IP
   *before* signature verification (correct, §8's cheap-path-first rule), then
   Allow(op,nodeID,"") checks per-node *after* verification and could refuse —
   but the IP charge was already spent. Traced live: a register denied by its own
   node bucket left the shared IP bucket one token lighter, taxing co-located
   users for a refused request, contradicting authenticate's own comment
   ("denied by the IP bucket does not burn the node's allowance (and vice
   versa)"). Fix: `ratelimit.Limiter.Refund(op, ip)` returns the token (clamped
   to capacity, no-op for empty-ip/missing bucket) and authenticate calls it on
   the post-verification refusal path. Both orderings preserved; unit test
   `TestRefundRestoresTheIPBucket` pins the primitive. This is behaviour within
   §8's letter but against its intent and our own doc comment — flagging for the
   record rather than as an open question.

## Merge provenance (per coordinator instruction)

Two agents wrote overlapping suites into this worktree; Orca synced them together.
Committed state keeps, per package: **apierr / descriptor / store / ratelimit
tests = the earlier agent's versions** (equivalent-or-stronger coverage: frozen
tables pinned verbatim, eviction regression present, boundary tables complete);
**control unit tests, server WS/abuse/amendment/restart tests = mine** (the
earlier agent had none of those). The earlier agent's ratelimit regression test
(`TestIdleBucketEviction`) and mine (`TestIdleBucketsAreEvicted`, verified to fail
against the original lastMs-based eviction before being superseded) cover the same
bug; theirs ships. Nothing was deleted to make tests pass; no existing test was
weakened or skipped.

## Flake forensics (why the socket tests are written the way they are)

Three real effects were chased down; all fixes are test-side:

1. **coder/websocket cancels the whole connection when a Read context expires.**
   Short-lived read contexts cannot implement "expect silence"; every connection
   is therefore served by ONE reader goroutine whose context is never cancelled,
   observed through a channel.
2. **websocket.Dial can beat the server goroutine to hub.add.** A test that swept/
   shut down immediately after Dial raced the registration: the channel attached
   AFTER the close, then sat attached forever (90 s wall-clock idle). Symptom was
   intermittent "connection never closed" / hub-count hangs. Fixed by
   `awaitAttached` before any hub interaction.
3. **Server-initiated closes of an idle hijacked conn can surface client-side as
   abrupt EOF instead of a close frame on Windows**, and teardown can lag. §7
   mandates a close code only for non-ping frames (1008 — asserted strictly and
   reliable everywhere). For sweeper/shutdown closures the tests assert the
   contractual fact (channel stops counting as connected; hub empties promptly)
   and accept either close-frame or EOF for the stream itself, with generous
   windows.

## Still untested / known gaps

- TLS/proxy paths (`TrustProxyHeaders`, ListenAndServe TLS): nothing drives a
  real proxy hop. TrustProxyHeaders-off is the default and correct-by-default;
  on-path XFF handling is untested.
- Search timing-padding remains weak (inherited from previous handoff): the miss
  path marshals a decoy signing input, but body sizes differ (null vs descriptor),
  which §5.4 arguably also forbids ("response size class"). Unchanged; needs a
  contract decision (pad body? fixed-size envelope?) before it can be tested.
- `AllowIntroTarget`'s override borrowing of OpIntroRequest.PerNode remains
  awkward (inherited note); covered indirectly by abuse tests but not by a direct
  override-interaction test.
- Idle timeout is tested at a shortened window only (see SetIdleTimeout above);
  the 90 s value itself is pinned as a constant test.
- No IPv6/multi-IP-normalisation tests for clientIP; no HTTP/2 upgrade path tests.

## Next step

Nothing blocking. If continuing: pick up the search size-class question first —
it is the only place the contract, not the code, is unresolved.
