# Worker B — OpenTUI Interface Rebuild (v1 sprint)

You are rebuilding the interface of **Nex/Nex**, a terminal-native P2P communication app
(TypeScript on Bun, OpenTUI `@opentui/core` + `@opentui/react`). Another worker is upgrading
the core/networking engine against the same contract — do not touch their files.

Read first: `NEX_VISION_v1.md` — §3–5 (UX north star, feel, principles), §11–14 (interaction
model, information architecture, input model), §16–17 (presence, network info), §21
(guardrails — especially 21.2 "don't just polish", 21.5 "no decorative security"), §25–27
(visual direction, motion, responsiveness). Then `src/core/contract.ts` — the **frozen** v1
interface (new: `PeerInfo.identityState/verified/displayName`, `NexApp.setVerified`,
`renameContact`, `getLinkSecurity(): "none" | "transport"`).

Current state: main is green (14 tests, tsc clean) at commit `49986b6`. The existing v0.x UI
(`src/ui/*.tsx`) works but its information architecture is wrong for v1: it treats peers as
addresses, has no conversations list, and leans on slash commands. Treat it as a
proof-of-concept: reuse what helps (scrollbox chat, theme tokens, state bridge pattern),
rebuild the structure.

## Your files

Everything under `src/ui/`: restructure `Nex-tui.tsx`; evolve `use-Nex.ts`, `theme.ts`;
replace `peers-pane.tsx` with `people-pane.tsx`; new `conversations-pane.tsx`; evolve
`conversation-pane.tsx` into `chat-pane.tsx`; replace `link-strip.tsx` with
`context-strip.tsx`; new `add-peer-modal.tsx`, `verify-modal.tsx`; update `index.ts` barrel.
Keep the external signature `NexTui({ app }: { app: NexApp })` UNCHANGED —
`src/main/index.tsx` depends on it and you do not own that file.

Do NOT touch: `src/core/**`, `src/network/**`, `src/main/**`, `tests/**`, `README.md`.

## Target shell

```text
┌ header: ◈ Nex // <node name> · <fingerprint8> ·        ● ONLINE ┐
├──────────────┬───────────────────┬────────────────────────────────┤
│ PEOPLE       │ CONVERSATIONS     │ CHAT                           │
│ ● Roshan  ✓  │ ● Roshan          │ <peer display name>            │
│ ○ CKU        │   last message…   │  12:01:03 Roshan  yo           │
│ + Add Peer   │ ○ CKU    hey  2h  │  12:01:10 YOU     what's good  │
├──────────────┴───────────────────┴────────────────────────────────┤
│ ROSHAN · VERIFIED ID · DIRECT/TCP · 32ms · NO ENCRYPTION          │
│ > _                                                               │
└───────────────────────────────────────────────────────────────────┘
```

Exact arrangement is yours; the hierarchy (People → Conversations → Chat, persistent nav,
clear selection, honest status strip) is mandatory.

### Panes

- **PEOPLE**: every known contact. Row: presence glyph (real status only — `●` connected,
  `◐` connecting, `↻` reconnecting, `○` offline), display name (`displayName ?? name`),
  right-aligned identity mark: `✓` verified (`colors.online`), `·` identified,
  `?` unverified/unknown, `✗` mismatch (`colors.error`). `+ Add Peer` action row at bottom.
  Window around selection when overflowing (reuse v0.x approach), title shows range on overflow.
- **CONVERSATIONS**: contacts that have message history, sorted by last message time desc.
  Two rows each: name + relative time ("2m", "3h", "2d"); preview of last message truncated.
  Selecting one selects that peer and focuses chat/input.
- **CHAT**: preserve v0.x scrollbox behavior exactly (sticky bottom, RENDER_CAP 500, state
  suffixes queued `…` / failed ` ✗`), but attribute outbound to `YOU` and inbound to the
  peer's display name. Empty state: guidance text, not blank.
- **Context strip** (above input): `<DISPLAY NAME> · <identity label> · DIRECT/TCP · <rtt>ms ·
  <security label>`. Identity label from real state: VERIFIED ID (`verified===true`),
  IDENTIFIED (`identityState==="identified"`), UNVERIFIED otherwise, ID MISMATCH
  (`identityState==="mismatch"`, error color). Security label MUST come from
  `app.getLinkSecurity()`: `"none"` renders `NO ENCRYPTION` — never invent ENCRYPTED.
  When no peer selected: show node listening address instead (transport port via app state
  if available through events; else omit segment).

### Breakpoints (spec §27)

- width ≥ 100: three panes (people ~20–24 cols, conversations ~22–28, chat flexes).
- 64–99: two panes — people + chat; conversations merge into people pane as a second
  section (recent chats) OR hide; your call, keep navigation coherent.
- < 64: single column showing the focused pane only (focus decides which).
- Short terminals (< 20 rows): collapse context strip first, then previews; never crash.

### Keyboard

- Tab cycles focus: people → conversations → input → people. Shift+Tab reverses.
- j/k or arrows navigate the focused list. Enter on a person/conversation: select +
  focus input. Any printable typing while a pane is focused jumps to input (message-first).
- `a` (people focused): Add-Peer modal. `v`: Verify modal for selected peer.
- Esc closes modal / backs out. Ctrl+C quits (keep the existing guarded shutdown pattern).
- Slash commands remain for power users: `/connect host:port`, `/peers`, `/ping`,
  `/trust on|off` (alias), `/verify`, `/rename <name>` (empty clears). Plain text always sends.

### Modals

FIRST read the installed API surface before building overlays: inspect
`node_modules/@opentui/core/dist/**/*.d.ts` for dialog/overlay/absolute-positioning support
and use what actually exists. If nothing suitable, render the modal as a centered bordered
box layered over the chat pane area using whatever positioning the library truly supports;
if layering genuinely isn't possible, swap the chat pane content for the modal panel while
open (state `modal: null | "add-peer" | { kind: "verify"; peerId }`) and say so in your report.
- **Add Peer**: title "Add a peer", labeled input for `host:port`, [Connect] / [Cancel];
  Enter=Connect, Esc=Cancel; wire to `app.connectTo`, surface errors in footer error slot.
- **Verify**: shows BOTH full fingerprints (own `app.identity.nodeId`, peer `peerId`)
  wrapped/hex-grouped for human comparison, instruction to compare out-of-band,
  [Confirm] → `setVerified(peerId, true)` / [Deny] → `setVerified(peerId, false)`.

### State bridge

Extend `use-Nex.ts` following the existing push-based pattern (event bus → useState;
no polling beyond the existing 15s latency probe). Derive per-peer lastActivity/preview from
the already-loaded conversations map. Handle `identityState` arriving via peerChanged.

## Constraints & verification

- No decorative security labels, no fake presence, no animation spam (§16, §21.5, §26).
- Tokyo-Night-ish palette continuity; dense but readable; responsive (§25, §27).
- Before finishing: `bunx tsc --noEmit` clean AND `bun test` still green (don't break
  imports used by tests/headless).
- Smoke-run the TUI with the mock transport (`bun run dev -- --mock` or Nex_MOCK=1);
  exercise resize if your environment allows; describe what you verified in your final
  report honestly (what you saw vs. reasoned about).
- Commit on your branch with structured messages (bulleted body, Verified: line,
  Co-authored-by: CommandCodeBot <noreply@commandcode.ai>).
