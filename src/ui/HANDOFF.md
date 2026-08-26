# HANDOFF — Worker C: TUI + ASCII animation system (branch v1-ui)

## What was built

### 1. Shared animation clock — `src/ui/use-tick.ts` (extended, not replaced)
- **One clock registry for the whole app.** Every frame-based effect subscribes
  through `useTick(active, rate)`; the registry keeps exactly one `setInterval`
  per distinct rate and tears it down when the last subscriber at that rate
  unsubscribes. **Zero subscribers = zero timers**, so a truly idle app runs no
  animation timers at all (the idle-spinner-pins-a-core failure mode is
  structurally impossible now). Timers are `.unref()`ed so they can never hold
  the process open.
- Existing semantics preserved: `useTick`, `useChangeFlash`, `SPINNER_FRAMES`,
  `spinnerFrame`, `dotsFrame` keep their signatures and behavior; all prior
  call sites work unchanged, they just share clocks now.
- **Reduced motion:** `animsEnabled()` honors `NEX_NO_ANIM=1` (legacy),
  `NEX_NO_MOTION=1`, or `NO_MOTION=1`.
- **MotionScope** (`<MotionScope suspended={bool}>`): declarative, reference-
  counted suspension. The shell suspends everything beneath it while any modal
  is open — covered surfaces stop repainting entirely instead of animating
  unseen; a modal wraps itself in `<MotionScope suspended={false}>` to keep its
  own surface alive (AddPeerModal does this).

### 2. Pure animation vocabulary — `src/ui/anim.ts` (new)
Deterministic math only — no timers, no React, no theme access:
easings (`easeInQuad`, `easeOutQuad`, `easeInOutQuad`, `easeOutCubic`),
`timelineAt(phases, elapsedMs)` for sequencing,
`spriteFrame(frames, tick, pingPong)`,
`seekBar(cells, tick)` (indeterminate drift bar — honest by construction: it
shows activity, never a fake percentage), and `revealText(text, progress)`.
The shared clock remains the only heartbeat anywhere.

### 3. THE UNION SCENE — `src/ui/union-scene.tsx` (new)
The sphere/union metaphor from V3 §17–§18 and dream vision §17–§18, on the
character grid. Two autonomous nodes (`◉` … `◉`); part of each reaches toward
the other; a shared structure forms; when the session ends only the
relationship dissolves — both nodes remain.

Phases, driven ONLY by real link state via `unionPhaseForStatus(PeerStatus)`:

| PeerStatus      | Phase          | Visual                                            |
|-----------------|----------------|---------------------------------------------------|
| `discovered`    | apart          | two nodes, "nearby · not linked"                  |
| `connecting`    | reaching       | dashes grow inward from both sides, center OPEN   |
| `authenticating`| acknowledging  | full reach, `✦` proof-exchange spark in the gap   |
| `connected`     | formed         | bloom: bridge sweeps out, `\___/` arc draws, "UNION FORMED" types in — then settles CALM (dream vision §19: no looping spectacle on a healthy link) |
| `reconnecting`  | dissolving     | arc lifts away first, bridge breaks center-out into dust; afterwards an honest retry pulse (the link IS retrying); caption "reconnecting…" |
| `offline`       | apart          | "offline · autonomous"                            |

Honesty contract (V3 §18): the bridge never closes before `connected`; it
starts dissolving the moment trouble is reported. Every state also states
itself in words — animation is never the only channel.

`unionMiniGlyph(status)` renders the SAME language as a static 5-cell glyph
(`◉───◉` formed, `◉─ ─◉` reaching, `◉─✦─◉` acknowledging, `◉╌ ╌◉`
reconnecting, `◉   ◉` apart) for one-row surfaces.

### 4. Where it is applied (meaning first)
- **AddPeerModal** hosts the centrepiece during the connect flow. Stage is fed
  by REAL events: nex-tui watches the bus for `peerChanged` with status
  `authenticating` while a dial is in flight (`connectStage` prop); anything
  before that event is shown as "connecting". Success plays the union-formed
  beat (existing 800 ms settle kept). Failure reads apart again: "no answer ·
  both autonomous". Terminals < 20 rows keep the old compact modal.
- **ContextStrip** leads with the static union mini-glyph colored by real
  status — persistent state without spending frames.
- **VoiceStrip** (extracted from nex-tui into `voice-strip.tsx`): speaking
  rings pulse through `◉◎◉○` ONLY while the pipeline reports voice activity;
  muted ⊘ / idle ○ are static; the room segment blips on participant
  join/leave (`useChangeFlash`).
- **People pane**: existing per-row link-up/down flashes retained; NEARBY
  header now blips when the discovered set changes (peer arrival/loss).
- **Chat**: outbound `queued` marks tick their dots while a send is genuinely
  in flight; arrival flash (inbound vs outbound emphasis) unchanged.
- **Header honesty fix**: only `starting` spins. OFFLINE used to spin forever,
  implying activity that isn't happening; it now sits as a static dim `○`.
- **Home wordmark**: boot shimmer rewritten on wall-clock + easing through the
  shared clock (releases its timer the moment the sweep completes); the
  tagline now types itself in once (`revealText`). Reduced motion shows the
  settled state immediately.

## Tested vs only read

Actually tested (all green):
- `bun x tsc --noEmit` clean.
- `bun test`: 193 pass / 0 fail (baseline reproduced after `bun install`;
  the fresh clone initially lacked node_modules).
- Offscreen render harness (@opentui `testRender`, real renderer → captured
  character frames):
  - Gallery of all five scene phases: frames differ over time with motion on;
    mid-flight captures show reaching holding an OPEN center gap, formed
    blooming progressively (bridge → arc → label).
  - Reduced motion (`NEX_NO_MOTION=1`, then separately `NEX_NO_ANIM=1`):
    frames byte-identical across time; static states unambiguous
    (reaching keeps a wide visible gap; formed shows full bridge + arc +
    literal "UNION FORMED"; dissolving shows separated nodes + "reconnecting").
  - `<MotionScope suspended>` freezes covered scenes (identical frames).
  - Status→phase/glyph mapping table printed for all six PeerStatus values.
  - Full-app smoke with the mock app: HOME, Add-Peer modal hosting the union
    scene ("two autonomous nodes"), shell context strip showing `◉───◉ ECHO ·
    IDENTIFIED · DIRECT/TCP`.
- Real-terminal check: launched `bun run dev` under Windows ConPTY and read
  the ANSI byte stream: home screen paints, header transitions
  `◐ STARTING → ● ONLINE`, wordmark shimmer sweeps cell-by-cell, tagline
  reveal types in (" direct · enc" → … → "no server"), then the stream goes
  quiet — i.e. after the one-shot reveal nothing repaints. No crash; process
  ran until killed. (Interactive keyboard driving wasn't possible from this
  sandbox; that path is covered by the mockInput harness above.)

Only read (not executed here): the TCP/noise transports' exact event ordering
in production (read `encrypted-tcp-transport.ts`: emits `authenticating`
during the noise handshake, then `connected`; reconnect path emits
`reconnecting`). The modal's stage display trusts those events; if a future
transport skips `authenticating` the scene simply shows "connecting" until
resolved — honest degradation.

Reduced-motion verification specifically: env-var paths exercised through the
real renderer (B/C checks above) plus code review that every animated element
has a text/static equivalent (labels always present; spinner→static glyphs;
seek bar→"…"; shimmer→settled colors; speaking pulse→filled/hollow rings).

## DECISIONS
1. **Centrepiece placement.** The full union drama lives in the connect flow
   (Add-Peer modal) — the moment a union actually forms for THIS user. V3 §31
   describes a website hero animation; porting it to the TUI as an autonomous
   loop would violate §18 (state-driven, not decorative). Persistent surfaces
   use the static mini-glyph so one language covers everywhere.
2. **Connected is calm.** After the ~760 ms formation bloom the scene stops
   animating. Dream vision §19 forbids constant sphere spectacle; a steady
   bridge reads as health, and zero ticking honors the perf budget.
3. **Reconnecting keeps breathing.** After the dissolve, a slow reach-and-rest
   pulse loops because the real transport IS retrying. If status flips back to
   connected, the formation bloom replays (true re-union).
4. **Offline never spins** (header). A spinner on a dead node implies futile
   activity; static ○ + "OFFLINE".
5. **Compact terminals (<20 rows)** keep the pre-existing compact modal text;
   there is no room for a 3-row scene there. Defensible degradation.
6. **Direct connected→offline jump** snaps to apart without replaying the
   dissolve. In practice transports emit `reconnecting` first (read, not
   executed), so the dissolve normally plays; handling the rare direct jump
   with scene-local history wasn't worth the complexity/risk.
7. **Modal coverage gating** uses React context (MotionScope) rather than
   drilling a `paused` prop through every pane; modals opt themselves back in.
8. **No new dependencies** — everything builds on @opentui 0.5.6 + React 19
   already present.

## What remains / suggestions for the next worker
- `bun run dev` interactive key-by-key verification on a human's terminal
  (especially Add-Peer against a live encrypted node to watch dialing →
  authenticating → UNION FORMED with real handshake timing).
- Room join/leave currently blips the voice strip room name; a short scene
  flourish inside the chat pane on room transitions could ride the same
  timeline helpers if wanted.
- `anim.ts` exports more easings than currently used (`easeInQuad`,
  `easeInOutQuad`, `linear`) — deliberate small vocabulary for future scenes;
  trim if you prefer minimal surface.
- If OpenTUI later exposes terminal focus/blur events, wire them to
  suspendMotion() so background windows also stop ticking (currently the clock
  already costs nothing when nothing is animating).
