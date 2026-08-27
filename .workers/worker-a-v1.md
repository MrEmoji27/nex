# Worker A — Core, Networking & Persistence (v1 sprint)

You are building the engine of **Nex/Nex**, a terminal-native P2P communication app
(TypeScript on Bun). Another worker is rebuilding the OpenTUI interface against the same
contract — do not touch their files.

Read first: `NEX_VISION_v1.md` (§6–8 identity/trust, §16 presence, §21 guardrails),
`src/core/contract.ts` — the **frozen** v1 interface you implement (already extended with
`IdentityState`, `verified`, `displayName`, `setVerified`, `renameContact`, `getLinkSecurity`,
`TransportSecurity`). You may not modify `contract.ts`, anything under `src/ui/`, or
anything under `src/main/index.tsx`.

Current state: main is green (14 tests, tsc clean) at commit `49986b6`. The facade methods
`setVerified`/`renameContact`/`getLinkSecurity` already exist in `src/core/app.ts` and the
mock transport. Your job is to make identity cryptographically real and reconnect robust.

## Your files

- `src/core/identity.ts`
- `src/core/state/persistence.ts`
- `src/network/tcp-transport.ts` (and anything it imports under `src/network/`)
- `tests/tcp-transport.test.ts` (+ new test files as needed)
- You may extend `src/core/app.ts` ONLY where noted below (handshake → identityState wiring).

Do NOT touch: `src/core/contract.ts`, `src/ui/**`, `src/main/**`, `README.md`.

## Task 1 — Real fingerprint (no more seed-as-nodeId)

In `generateIdentity()`: keep the crypto-random 32-byte `seedHex`; compute
`nodeId = SHA-256(seedBytes)` as uppercase hex (64 chars). The fingerprint must no longer
contain the secret.

**Migration** (`FileIdentityStore.load` path in app start or store itself): if a stored
identity has `nodeId === uppercase(seedHex)` (legacy shape), derive the new nodeId from the
seed via SHA-256, rewrite `identity.json`, then migrate local data:
- rename `conversations/<oldNodeId>.json` → `<newNodeId>.json`
- rewrite `peers.json`: any entry with `peerId === <some old-style id>` keeps its data but
  its peerId is unknowable until that peer re-handshakes — leave remote entries alone;
  only fix entries whose peerId equals OUR old nodeId (should not exist, but be safe).
Document this limitation in a short comment. Add a round-trip migration test using a temp dir.

## Task 2 — Mutual proof-of-possession handshake

Wire protocol stays newline-delimited JSON frames. Implement EXACTLY this scheme
(TOFU + derived verifier, HMAC-SHA256/SHA-256 only):

Setup (per side, derivable at any time):
`V_own = hex(HMAC-SHA256(key: seedBytes, msg: "Nex-attest-v1:" + nodeId))`
V_own acts as a verifier token derived from the secret seed.

Handshake flow:
1. Dialer sends `{type:"hello", nodeId, name, nonce}` (nonce = 32 random bytes, hex).
2. Responder replies `{type:"hello", nodeId, name, nonce, attest}` where
   `attest = V_own` (the responder's verifier) and `nonce` is the responder's fresh nonce.
3. Dialer sends `{type:"prove", proof}` where
   `proof = hex(HMAC-SHA256(key: V_dialer_bytes, msg: responderNonceHex))`.
4. Responder sends `{type:"prove", proof = hex(HMAC-SHA256(key: V_responder_bytes, msg: dialerNonceHex))}`
   (can ride on its hello or a second frame — your choice, keep it simple and ordered).
5. Each side verifies the OTHER's proof against its remembered verifier for that nodeId:
   - No record of this nodeId (first meeting): store `(nodeId -> V_peer)` and mark
     `identityState: "unknown"` locally (trust-on-first-use).
   - Record exists: recompute `HMAC(V_peer, freshNonceHex)` and compare:
     - equal → `identityState: "identified"`
     - different → `identityState: "mismatch"` and drop the connection (keep the record).
6. `dial()` resolves only after steps 3–4 complete, returning PeerInfo with the resulting
   identityState. Inbound connections follow the mirror logic and emit peerChanged.

Store attestations per-nodeId at `<dataDir>/attestations.json` via a small concrete store
class in persistence.ts (no contract change needed; node-app.ts wiring stays supervisor-owned
— export the class and note the constructor signature in your final report).

Known/documented limitations (put in a short comment): V is transmitted once at first
meeting, so a first-meeting MITM is outside v1 scope; this proves continuity of control,
not real-world human identity (NEX_VISION_v1.md §7).

Mock transport: leave logic as-is except make `dial()` return
`identityState: "identified"` for its scripted peers so the UI can render states.

## Task 3 — Auto-reconnect

When an established connection drops WITHOUT a local `drop()` call: mark peer
`status:"reconnecting"`, emit peerChanged, redial its last address with exponential backoff
(1s, 2s, 4s ... cap 30s, unlimited attempts while running). On success → `"connected"` +
re-handshake updates identityState. On `drop()` or shutdown → cancel timers, `"offline"`.
Guard against timer leaks (previous sprint had an interval-leak bug — test it).

## Task 4 — App-layer wiring

In `app.ts` ONLY add: after `dial()` resolves, map transport-reported identityState onto the
merged PeerInfo (preserve existing value when transport reports none). Nothing else.

## Tests (target ≥20 total)

Existing 14 must stay green. Add: handshake ok (repeat meeting → identified), wrong-seed
impostor → mismatch + drop, legacy identity migration round-trip, reconnect transitions
(drop server → reconnecting → restart server → connected), no leaked timers after shutdown,
renameContact/setVerified persist across restart.

## Constraints

- No custom cryptography beyond HMAC-SHA256/SHA-256 challenge-response as specified.
- Never log seed material. Secrets stay under the node's dataDir.
- Windows dev box: use Bun APIs, avoid POSIX-only calls.
- Verify before finishing: `bun test` all green + `bunx tsc --noEmit` clean.
- Commit on your branch with structured messages (bulleted body, Verified: line,
  Co-authored-by: CommandCodeBot <noreply@commandcode.ai>).
