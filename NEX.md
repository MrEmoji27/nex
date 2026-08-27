# Nex

> Terminal-native peer-to-peer communication. Two autonomous terminal peers, direct link, **no central server** — now with group rooms and voice channels.

**Status: `2.0.0-alpha.7` — home, themes, retention, rooms, voice pipeline, serverless discovery**

## Start here

| Note | What it holds |
| --- | --- |
| [[Rooms and Voice Channels]] | The alpha.6 feature spec — topology, protocol, voice pipeline |
| [[Architecture Map]] | Layered architecture + where every subsystem lives |
| [[Voice Roadmap]] | What stands between the mock codec and real Opus calls |

> **Wire compatibility:** the Noise layer was corrected to spec after alpha.7
> shipped, which changed the handshake transcript. Builds from this tree cannot
> handshake with the released `2.0.0-alpha.7` installer — both sides must be
> rebuilt. The prologue bump to `nex-tcp-v3` makes the mismatch fail fast
> instead of surfacing as a confusing mid-stream decrypt error.

## Repo docs (source of truth)

- `README.md` — run instructions, stack, security notes
- `FEATURES.md` — living tracker (shipped / dormant / designed / roadmap)
- `CHANGELOG.md` — release history
- `WORKLOG.md` — session-by-session build log
- `NEX_DREAM_VISION.md` — the conceptual north star
- `NEX_VISION_v1.md` — v1 product vision & identity model
- `NEX_V2_VISION_AND_ROADMAP.md` — v2 direction (§19 = voice)

## One-line mental model

```
UI -> application services -> P2PTransport abstraction -> transport impl
```

Everything user-facing crosses `src/core/contract.ts`. Nothing above it may
import OpenTUI or a concrete transport.

## Quick commands

A fresh checkout needs BOTH installs before anything below will run. Skipping the
second one is not obvious: the root suite goes green while `web/` fails with
"This is not the tsc command you are looking for", because `npx` then resolves a
long-abandoned package of that name from the registry instead of a local binary.

```bash
bun install                    # root: TUI, core, rendezvous client
cd web && npm install && cd .. # website (separate dependency tree)
```

```bash
bun run dev -- --name zro --port 42101 --data-dir data/local/zro   # TUI node
bun run headless -- --name roshan --port 42102 --data-dir data/local/roshan
bun test          # unit suite
bun run typecheck # tsc --noEmit
bun tests/live-room-voice.ts   # manual: 2-node room+voice smoke over TCP
bun tests/stress-rooms.ts      # manual: 3-node stress (flood/voice/churn)
```

The v3 Rendezvous service and website have their own checks:

```bash
cd rendezvous && go build ./... && go vet ./... && go test ./...
cd web && npx tsc --noEmit && npm run build
```

## Group chat & voice in one screen

```text
zro$  /room lounge:roshan          # host a room, invite roshan
roshan$  /join <roomId>            # accept the invitation
roshan$  /say anyone there?        # room line, relayed via host, authorship kept
zro$  /voice on                    # join the room's voice channel
roshan$  c                         # same, from the people pane (TUI)
roshan$  m                         # mute / unmute
```

The room dies when the host closes it or quits — by design. No server ever
existed; every hop rode an end-to-end Noise_XX encrypted link.
