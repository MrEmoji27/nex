# Nex Rendezvous Service

An optional discovery and introduction service for Nex. It helps two peers find each other
and exchange enough signed metadata to attempt a direct connection — and then it gets out of
the way.

It is implemented against the frozen wire contract, which is the normative byte-level
contract. Where this README and that document disagree, that document wins.

---

## What this service is not

Taken from V3 §4 and §42, and enforced structurally rather than by policy:

- It **never** carries chat, room, voice, or video payloads. There is no frame type and no
  endpoint that can carry message content.
- It **never** receives a Nex private key or seed. The rendezvous signing key is derived
  client-side from the identity seed (§1.3) and only the public half is ever transmitted.
- It stores **nothing on disk**. No database, no presence history, no search log, no IP log.
- It is **not** required for Nex to work. Existing peer relationships, rooms and voice
  sessions are unaffected if this service is offline.
- It is **not** an identity authority. See "What it proves" below — this is the important part.

---

## Running it

```bash
cd rendezvous
go build ./...
go vet ./...
go test ./...

go run ./cmd/rendezvousd
```

The service listens on `:8080` by default and speaks plain HTTP, expecting TLS to be
terminated in front of it. Set `NEX_RENDEZVOUS_TLS_CERT` and `NEX_RENDEZVOUS_TLS_KEY` to
serve HTTPS directly.

Restarting the process is a **supported, routine event**. Every lease lapses and every node
re-registers on its next refresh tick. This is a feature, not a limitation: it proves the
system genuinely depends on leases rather than on the service's memory (V3 §6).

### Configuration

All configuration is environment variables. None of them is a secret — the service holds no
key material and has nothing to authenticate itself with.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEX_RENDEZVOUS_ADDR` | `:8080` | Listen address. |
| `NEX_RENDEZVOUS_TLS_CERT` | *(unset)* | PEM certificate. Set with the key to serve HTTPS directly. |
| `NEX_RENDEZVOUS_TLS_KEY` | *(unset)* | PEM private key for the certificate above. |
| `NEX_RENDEZVOUS_LEASE_TTL_MS` | `90000` | The `now + 90000` term of §5.2.1. Clamped to 90000; it can never be raised above the maximum life of a signed descriptor. |
| `NEX_RENDEZVOUS_REFRESH_AFTER_MS` | `30000` | The `refreshAfterMs` advertised to clients. |
| `NEX_RENDEZVOUS_SWEEP_INTERVAL_MS` | `5000` | How often lapsed state is reclaimed. Correctness does not depend on this; every read path checks expiry itself. |
| `NEX_RENDEZVOUS_MAX_LEASES` | `100000` | §8 global cap. At capacity, register returns `503`. |
| `NEX_RENDEZVOUS_MAX_INTRODUCTIONS` | `10000` | §8 global cap. At capacity, introduction/request returns `503`. |
| `NEX_RENDEZVOUS_TRUST_PROXY` | `false` | Read the client IP from `X-Forwarded-For`. **Only enable behind a proxy that overwrites that header** — otherwise every per-IP rate limit in §8 becomes client-controlled. |

### Endpoints

Base path `/v1`, JSON in and out, request bodies capped at 8192 bytes.

```
POST   /v1/presence/register
POST   /v1/presence/refresh
DELETE /v1/presence
GET    /v1/discovery/search?handle=<exact handle>
POST   /v1/introduction/request
POST   /v1/introduction/respond
GET    /v1/status                 (unauthenticated)
GET    /v1/metrics/public         (unauthenticated, bucketed counts only)
GET    /v1/control                (WebSocket upgrade)
```

---

## What the service proves, and what it does not

This is the section to read before trusting anything this service returns.

### What it verifies

- The signature on a request or descriptor is valid for the `signPub` presented with it.
- The request is fresh (within ±120 s of server time) and its nonce has not been used.
- The descriptors are internally consistent, mutually agreeing, and unexpired.
- The handle is free, or already held by this same `nodeId`.

### What it cannot prove

**The service does not and cannot prove that `signPub` belongs to `nodeId`.**

Nothing in this protocol establishes that link, and no amount of service-side checking would.
A valid signature proves only that a record was not forged or mutated *in transit*. Anyone
can generate a keypair and sign a descriptor claiming any `nodeId` they like.

The binding is established **by the peers, after the introduction**:

```
descriptor.nodeId  ──►  dial candidate  ──►  Noise handshake  ──►  transport reports peerId
                                                                          │
                                          peerId !== descriptor.nodeId ───┴──► HARD STOP
```

A rendezvous introduction is a **candidate**, with exactly the trust level of an
unauthenticated UDP beacon. The Nex client's rendezvous connect path must reuse the same
mismatch check and the same loud failure as `connectDiscovered` and `redeemInvite`.

Accepting an introduction sets the peer to `IDENTIFIED`, never `VERIFIED` (V3 §13).

Two further things the service explicitly does not claim:

- It does **not** provide end-to-end encryption for Nex traffic. It is not in the traffic path
  at all. Encryption is the Noise transport's job.
- It does **not** prove a user is a real-world human, or that a handle corresponds to any
  particular person. A handle is a lookup alias, never an identity (V3 §9), held only for the
  duration of a lease and released when that lease lapses.

---

## Privacy posture

In-memory only, and deliberately forgetful.

Never stored and never logged: request bodies, handles paired with IPs, search terms,
introduction graphs, node IDs, `User-Agent`.

Access log lines carry exactly: timestamp, method, path **without query string**, status code,
a coarse duration bucket, and the error code. The `handle` query parameter is stripped before
any line is written — by cutting the entire query string, not by removing one known key, since
a stripper that knows one parameter name will leak the next one someone adds.

`GET /v1/metrics/public` reports two **bucketed** counts: a raw count below 20 is reported as
`0`, and at or above 20 it is rounded down to the nearest multiple of 5. On a small network an
exact count is a deanonymization aid ("it says 2, and I am one of them").

---

## Design notes worth knowing

**Length-prefixed signing, not canonical JSON.** Every signature is over the framing in §1.4.
Two languages disagree about string escaping, number formatting and key ordering in ways that
stay invisible until they are exploitable.

**External test vectors are mandatory.** `internal/wire/rfc8032_test.go` checks the Ed25519
implementation against the published RFC 8032 §7.1 vectors, transcribed from the RFC itself.
Passing only against the other Nex implementation is explicitly insufficient — a prior audit
caught a self-consistent "Noise" implementation that was not spec-conformant, and only foreign
vectors caught it.

**Search is exact-match only.** No prefix search, no fuzzy match, no listing, no wildcard. A
miss returns `{"result": null}` with `200`, never a `404`, and the miss path does comparable
work to the hit path so latency does not become an oracle either.

**The control channel cannot become a transport.** The only client frame the server will parse
is `{"type":"ping","t":<int>}`, decoded into a struct with no payload field and with unknown
JSON fields rejected. Anything else closes the connection with `1008`. The guarantee is the
absence of any code path that could carry content, not a check that could be relaxed later.

**A dropped control channel does not drop the lease.** Presence is the lease; liveness is the
socket. `CONNECTED` (channel attached) and `CONNECTABLE` (unexpired lease) are independent,
and the client must never infer one from the other.

### Implementation decisions the contract leaves open

These are choices this implementation made where the contract is silent. They are all
client-invisible on the wire, but a reviewer should know they were decisions:

- **One lease per `nodeId`.** Registering again replaces the previous lease and releases the
  handle it held, so a client restarting under a new handle does not have to wait out the old
  lease.
- **Nonce keys are `(nodeId, nonce)`,** not the nonce alone, so one node cannot burn another
  node's nonce space by pre-claiming guessed values.
- **Rate-limit ordering.** The per-IP bucket is charged *before* signature verification —
  verification is the most expensive path and therefore the cheapest thing to attack — and the
  per-`nodeId` bucket is charged *after*, because a `nodeId` is an unauthenticated claim until
  the signature verifies. Charging it earlier would let anyone exhaust a chosen victim's
  allowance by sending garbage in their name. Both buckets are still enforced, as §8 requires;
  only the order differs.
- **Nonces are consumed last,** so a request rejected for any earlier reason does not burn a
  nonce the caller may legitimately retry with.
- **A second control-channel upgrade for the same lease displaces the first** rather than being
  refused, so a client whose socket died half-open can reconnect without waiting out the 90 s
  idle timeout. "One live channel per lease" is still true at every instant.
- **Unknown HTTP body fields are tolerated; unknown control-channel frame fields are not.** An
  unrecognised HTTP field is not covered by the signature and cannot influence anything, while
  rejecting it would break a forward-compatible client. On the control channel the unknown
  field *is* the attack.

---

## Layout

```
cmd/rendezvousd/      entrypoint
internal/wire/        §1.4 length-prefixed framing, §1.3 key derivation, Ed25519 verification
internal/handle/      §2 normalization (trim, NFKC, simple lowercase, ASCII pattern)
internal/descriptor/  §3 PublicDescriptor and ContactDescriptor, signing inputs, validation
internal/protocol/    §5/§7 request, response and frame shapes plus per-operation signing inputs
internal/apierr/      §5.9 error codes, statuses and the single error-writing path
internal/clock/       injectable time source; expiry is tested without sleeping
internal/store/       in-memory leases, nonces, introductions; global caps; metric bucketing
internal/ratelimit/   §8 token buckets and the invalid-signature IP ban
internal/control/     §7 WebSocket control channel and hub
internal/server/      routing, envelope authentication, handlers
```

Dependencies are the standard library plus two modules:

- `github.com/coder/websocket` — the WebSocket implementation, permitted by the task brief.
- `golang.org/x/text` — needed for Unicode **NFKC**, which §2 requires and the standard library
  does not provide. It is a `golang.org/x` module maintained by the Go team.

## Deploying

Both halves ship from `render.yaml` at the repo root: the Go service as a Docker
web service, the website as a static site.

1. Push this repository to GitHub.
2. Render → New → Blueprint → pick the repo. It reads `render.yaml` and creates
   both services.
3. When the service has a URL, set `NEXT_PUBLIC_RENDEZVOUS_URL` on the site
   service to `https://<service>.onrender.com` and redeploy the site.

Step 3 is manual on purpose. The site is a static export, so that URL is baked
in at build time — there is no server to read it later. Wiring it automatically
yields `host:port` where a full `https://` origin is needed, and a near-miss
shows up as "can't reach the service" on every page, which reads like the
backend being down.

### The free plan will bite

A free Render instance sleeps after ~15 minutes without HTTP traffic. This
service should not sleep: the control channel is a long-lived WebSocket and
leases expire on a 90-second clock, so a sleeping instance drops every attached
client and silently lapses everyone's presence. From the outside it looks like
users vanishing at random. Fine for a first look; move to a paid instance before
anyone depends on it.

### Listen address

Render injects `PORT` and routes to nothing else. The service reads it, so no
configuration is needed. `NEX_RENDEZVOUS_ADDR` still overrides it when set, for
running the binary directly.

`NEX_RENDEZVOUS_TRUST_PROXY=true` is set because Render terminates TLS and
proxies: the real client address arrives in `X-Forwarded-For`. Without it every
per-IP rate limit sees one address — Render's — and throttles everyone as one.
Leave it off when running without a proxy in front, or the limits become
client-controlled.

The service also serves HTTPS directly if `NEX_RENDEZVOUS_TLS_CERT` and
`NEX_RENDEZVOUS_TLS_KEY` are set, for hosting without a proxy.

### Building the site by hand

```bash
cd web
NEXT_PUBLIC_RENDEZVOUS_URL=https://<service>.onrender.com npm run build
```

`web/out/` is a plain static export — any file host will serve it.
