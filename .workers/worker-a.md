# Worker A — Core, Networking & Persistence

You are building the engine of **Nex**, a terminal-native P2P communication app (TypeScript on
Bun). Another worker is building the OpenTUI interface against the same contract — do not touch
their files.

Read first: `dream_terminal_communication_foundation_v0_1.md` (the project spec — §5 self-sustained,
§17 identity model, §19 local persistence are your brief), `README.md`, and `src/core/contract.ts`
— the **frozen** interface you implement. You may not modify `contract.ts`, anything under
`src/ui/`, or `src/main/index.tsx` (another worker owns those).

## Your files

- `src/core/identity.ts` — implement `IdentityStore`: generate a persistent node identity
  (crypto-random 32-byte seed -> nodeId as uppercase hex fingerprint), load/save under
  `data/local/identity.json`. First run generates; later runs load. Survive restarts (spec §5).
- `src/core/state/persistence.ts` — implement `ConversationStore` + `PeerRegistryStore`:
  JSON-per-peer files under `data/local/conversations/<peerId>.json`,
  registry at `data/local/peers.json`. Append-only for conversations.
- `src/network/tcp/tcp-transport.ts` — implement `P2PTransport` over plain TCP using Bun APIs
  (`Bun.listen` / `Bun.connect`). Wire protocol: newline-delimited JSON frames —
  `{"v":1,"type":"hello","nodeId":"...","name":"..."}`,
  `{"v":1,"type":"msg","id":"...","content":"..."}`, `{"v":1,"type":"ping","t":<ms>}` /
  `{"v":1,"type":"pong","t":<ms>}` (for latency measurement). Handshake: dial sends `hello`,
  waits for peer `hello` before resolving `dial()`. Emit events via TransportEvents.
  Default listen port: **42000**; if taken, bind 42001..42010.
- `src/core/app.ts` — implement `NexApp`: wires identity + stores + transport into the facade.
  On startup: load/create identity, start transport, restore registry + conversations from disk.
  Route inbound messages into conversation store and emit `message` events. Outbound: queue ->
  transport.send -> mark sent/failed. Clean `shutdown()`.
- `tests/tcp-transport.test.ts` — Bun test: spin up two transports on localhost, assert handshake,
  bidirectional messages, persistence across app restart (new instance sees old conversation).

## Constraints

- Node never requires any server. Everything persists locally under `data/local/`.
- No custom cryptography (spec §26): v0.1 transport is plaintext TCP behind the abstraction;
  toxcore replaces it in v1. Do not roll your own crypto.
- Keep the transport dumb and reliable; latency comes from ping/pong round-trip timing.

## Definition of done

`bun install && bun run typecheck && bun run test` all pass (your tests only need your own files +
contract). Commit with clear messages. When finished, set your Orca worktree comment:
`orca worktree set --worktree active --comment "worker-a complete" --json`.
