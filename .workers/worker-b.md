# Worker B — OpenTUI Interface

You are building the terminal interface of **Nex**, a terminal-native P2P communication app,
using **OpenTUI + React bindings** running on Bun.

Read first: `dream_terminal_communication_foundation_v0_1.md` (the project spec — §20 Terminal UX
Direction and §21 Visualizing the Connection are your design brief), `README.md`, and
`src/core/contract.ts` — the **frozen** interface you consume. You may not modify `contract.ts`,
anything under `src/core/`, or `src/network/tcp.ts` (another worker owns those).

## Your files

- `src/network/mock-transport.ts` — a fake `P2PTransport` + in-memory `NexApp` factory for
  developing the UI without the real network. Include a scripted demo peer that echoes/replies.
- `src/ui/` — the OpenTUI React application
- `src/main/index.tsx` — TUI entrypoint: builds a real app instance from `src/core/app.ts` when it
  exists, otherwise falls back to the mock; selects via env `Nex_MOCK=1`.
- `src/main/headless.ts` — minimal stdin/stdout node for two-terminal testing (uses the same app
  factory; works against the real core once merged).

## UI requirements (from spec §20–21)

1. Header bar: node name, truncated fingerprint, node status dot (`● ONLINE`).
2. Left pane: PEERS list — status glyph per peer (`●` connected, `◐` connecting, `○` offline),
   name, short id.
3. Right pane: CONVERSATION for the selected peer — `name > message` lines, newest at bottom.
4. Bottom: input line `> _`. Enter sends; Up recalls last sent message.
5. Tab / arrow keys switch focus between peers list and input. Ctrl+C quits cleanly
   (`renderer.destroy()` on every exit path — lifecycle rule from OpenTUI docs).
6. A visible link strip between header and panes rendering REAL state only:
   `YOU ●════ PEER   DIRECT/TCP · 12ms` style, using measured round-trip if available from events,
   otherwise connection state. No fake decoration (spec §21 forbids cyberpunk cosplay).
7. Information-dense, readable, monospace-first. Use `@opentui/react` components (`box`, `text`,
   `input`) with `style` props; hooks: `useKeyboard`, `useTerminalDimensions`.

## Mechanics

- Subscribe to the app's event bus; hold state in React (`useSyncExternalStore` or useState+useEffect).
- The UI imports ONLY from `src/core/contract.ts` (types + `NexApp`). It must compile even while
  `src/core/` is still being built by the other worker — until merge, default to the mock app
  (`Nex_MOCK=1` is the default in main/index.tsx until the real one exists).
- `bunx tsc --noEmit` (i.e. `bun run typecheck`) must pass with ONLY your files present — do not
  reference unimplemented core modules in a way that breaks the build; use dynamic import for
  `src/core/app.ts`.

## Definition of done

`bun install && bun run typecheck` pass, and `bun run dev` renders the full interface against the
mock transport (peers, conversation, input, status dots, link strip all live). Commit with clear
messages. When finished, set your Orca worktree comment:
`orca worktree set --worktree active --comment "worker-b complete" --json`.
