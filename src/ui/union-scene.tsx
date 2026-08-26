// The Nex union scene — V3 §17/§18 and dream vision §17/§18 rendered on the
// character grid. Two autonomous nodes; part of each reaches toward the other;
// a shared structure forms; when the session ends only the relationship
// dissolves — both nodes remain.
//
// HONESTY CONTRACT (V3 §18): this scene is a pure projection of REAL link
// state. The bridge never closes before `connected`; it starts dissolving the
// moment the link reports trouble; a healthy link settles calm instead of
// looping spectacle (dream vision §19). Every state also states itself in
// words — animation is never the only channel.
//
// One visual language everywhere: ContextStrip reuses unionMiniGlyph() so the
// persistent strip and this centrepiece read as the same system.
import { useRef } from "react"
import type { ReactNode } from "react"
import type { PeerStatus } from "../core/contract.ts"
import { colors } from "./theme"
import { animsEnabled, useTick } from "./use-tick"
import {
  clamp01,
  easeInQuad,
  easeOutCubic,
  easeOutQuad,
  revealText,
  spriteFrame,
  timelineAt,
} from "./anim"

export type UnionPhase =
  | { kind: "apart"; caption?: string }
  | { kind: "reaching"; caption?: string }
  | { kind: "acknowledging"; caption?: string }
  | { kind: "formed"; name?: string }
  | { kind: "dissolving"; caption?: string }

/** Real status -> scene phase. Never invents a state the link did not report. */
export function unionPhaseForStatus(status: PeerStatus | undefined): UnionPhase {
  switch (status) {
    case "connecting":
      return { kind: "reaching" }
    case "authenticating":
      return { kind: "acknowledging" }
    case "connected":
      return { kind: "formed" }
    case "reconnecting":
      return { kind: "dissolving" }
    case "discovered":
      return { kind: "apart", caption: "nearby · not linked" }
    default:
      return { kind: "apart", caption: "offline · autonomous" }
  }
}

/** Five-cell miniature of the SAME language for one-row surfaces. */
export function unionMiniGlyph(status: PeerStatus | undefined): string {
  switch (status) {
    case "connected":
      return "◉───◉"
    case "authenticating":
      return "◉─✦─◉"
    case "connecting":
      return "◉─ ─◉"
    case "reconnecting":
      return "◉╌ ╌◉"
    case "discovered":
      return "◉ · ◉"
    default:
      return "◉   ◉"
  }
}

const GROW_MS = 900
const BLOOM_PHASES = [
  { name: "bridge", ms: 260 },
  { name: "arc", ms: 300 },
  { name: "label", ms: 200 },
] as const
const DISSOLVE_PHASES = [
  { name: "fray", ms: 300 },
  { name: "break", ms: 360 },
] as const
const RECONNECT_CYCLE_MS = 2400

const SPARK_FRAMES = ["✦", "·"] as const
const TIP_FRAMES = ["─", "╌"] as const

interface Span {
  text: string
  fg: string
}

const space = (n: number): string => (n > 0 ? " ".repeat(n) : "")

/**
 * Bridge track length for a scene box of `width`. Rows are built from
 * pad + ◉ + track + ◉ + pad; the track keeps a few spare cells so a full
 * bridge never measures out to exactly the box width — exact-width multi-span
 * rows soft-wrap on some OpenTUI layout passes, which corrupts the fixed
 * three-row block. Verified across widths 24..64.
 */
const TRACK_SLACK = 4

function trackWidth(width: number, pad: number): number {
  return Math.max(4, width - pad * 2 - 2 - TRACK_SLACK)
}

interface SceneGrid {
  bridge: Span[]
  arc: Span[]
  caption: Span[]
}

/**
 * Center-out ordering helper: indices of a span of `len` cells sorted by
 * distance from its middle. Used to grow/shrink bridges and arcs symmetrically.
 */
function centerOut(len: number): number[] {
  const order: number[] = []
  const mid = (len - 1) / 2
  for (let d = 0; d <= Math.ceil(mid); d++) {
    const lo = Math.floor(mid - d)
    const hi = Math.ceil(mid + d)
    if (lo >= 0 && lo <= hi) order.push(lo)
    if (hi > lo) order.push(hi)
  }
  return order.filter((i) => i >= 0 && i < len)
}

function nodes(width: number, pad: number): Span[] {
  const inner = trackWidth(width, pad)
  return [
    { text: space(pad), fg: colors.textMuted },
    { text: "◉", fg: colors.accent },
    { text: space(inner), fg: colors.textMuted },
    { text: "◉", fg: colors.identity },
    { text: space(pad), fg: colors.textMuted },
  ]
}

function trimTrailing(spans: Span[]): Span[] {
  const out = [...spans]
  while (out.length > 0 && out[out.length - 1]!.text.length === 0) out.pop()
  const last = out[out.length - 1]
  if (last && /^\s+$/.test(last.text)) out[out.length - 1] = { ...last, text: "" }
  return out
}

function renderApart(width: number, pad: number, caption: string | undefined): SceneGrid {
  const cap = caption ?? ""
  return {
    bridge: trimTrailing(nodes(width, pad)),
    arc: [],
    caption: cap ? [{ text: cap, fg: colors.textMuted }] : [],
  }
}

function renderReaching(
  width: number,
  pad: number,
  elapsed: number,
  motion: boolean,
  caption: string | undefined,
): SceneGrid {
  const L = trackWidth(width, pad)
  // Center cell stays OPEN until `connected`: an unfinished bridge must never
  // read as a union (dream vision §17 — tied to actual state). Statically
  // (reduced motion) the gap is kept wide so the frame is unambiguous.
  const half = Math.floor((L - 1) / 2)
  const grow = motion ? easeOutCubic(clamp01(elapsed / GROW_MS)) : 0.72
  const leftN = Math.round(grow * half)
  const rightN = Math.round(grow * half)
  const arrived = motion && grow >= 1
  const tip =
    motion && arrived ? spriteFrame(TIP_FRAMES, Math.floor(elapsed / 220)) : "─"
  // Both nodes hold their positions for the whole phase (dream vision §17:
  // two autonomous nodes; part of EACH reaches toward the other). Each half
  // track is full width from the start; the fill grows inward from its own
  // node, so nothing slides and the frame never jumps from the apart state.
  const dashL =
    leftN > 0 ? "─".repeat(leftN - 1) + tip + space(half - leftN) : space(half)
  const dashR =
    rightN > 0 ? space(half - rightN) + tip + "─".repeat(rightN - 1) : space(half)
  const center = arrived ? { text: "·", fg: colors.warning } : { text: " ", fg: colors.warning }

  const dotTick = Math.floor(elapsed / 360)
  const dots = motion ? ".".repeat((dotTick % 3) + 1) : ""
  const label = caption ?? "reaching"

  return {
    bridge: trimTrailing([
      { text: space(pad), fg: colors.textMuted },
      { text: "◉", fg: colors.accent },
      { text: dashL, fg: colors.warning },
      center,
      { text: dashR, fg: colors.warning },
      { text: "◉", fg: colors.identity },
      { text: space(pad), fg: colors.textMuted },
    ]),
    arc: [],
    caption: [{ text: `${label}${dots}`, fg: colors.warning }],
  }
}

function renderAcknowledging(
  width: number,
  pad: number,
  elapsed: number,
  motion: boolean,
  caption: string | undefined,
): SceneGrid {
  const L = trackWidth(width, pad)
  const spark = motion ? spriteFrame(SPARK_FRAMES, Math.floor(elapsed / 170)) : "✦"
  const half = Math.floor((L - 1) / 2)
  const dotTick = Math.floor(elapsed / 360)
  const dots = motion ? ".".repeat((dotTick % 3) + 1) : ""
  const label = caption ?? "proving identity"

  return {
    bridge: trimTrailing([
      { text: space(pad), fg: colors.textMuted },
      { text: "◉", fg: colors.accent },
      { text: "─".repeat(half), fg: colors.warning },
      { text: spark, fg: colors.accent },
      { text: "─".repeat(L - 1 - half), fg: colors.warning },
      { text: "◉", fg: colors.identity },
      { text: space(pad), fg: colors.textMuted },
    ]),
    arc: [],
    caption: [{ text: `${label}${dots}`, fg: colors.warning }],
  }
}

function renderFormed(
  width: number,
  pad: number,
  elapsed: number,
  motion: boolean,
): SceneGrid {
  const L = trackWidth(width, pad)
  const pos = timelineAt(BLOOM_PHASES, motion ? elapsed : Number.MAX_SAFE_INTEGER)

  // Bridge sweeps outward from the center…
  const bridgeOrder = centerOut(L)
  const filled = Math.round(easeOutQuad(pos.name === "bridge" ? pos.progress : 1) * L)
  const bridgeCells = new Array<string>(L).fill(" ")
  for (let i = 0; i < Math.min(filled, L); i++) bridgeCells[bridgeOrder[i]!] = "─"
  const settling = pos.done || pos.name !== "bridge"

  // …then the arc `\___/` draws beneath it…
  const arcLen = L + 1
  const arcOrder = centerOut(arcLen)
  const arcCount = Math.round(
    easeOutQuad(pos.name === "arc" ? pos.progress : pos.name === "label" || pos.done ? 1 : 0) *
      arcLen,
  )
  const arcCells = new Array<string>(arcLen).fill(" ")
  for (let i = 0; i < Math.min(arcCount, arcLen); i++) {
    const idx = arcOrder[i]!
    arcCells[idx] = idx === 0 ? "\\" : idx === arcLen - 1 ? "/" : "_"
  }

  // …and the label types itself in. Text always accompanies the drawing.
  const labelProgress =
    pos.name === "label" ? easeOutCubic(pos.progress) : pos.done ? 1 : 0
  const label = revealText("UNION FORMED", labelProgress)
  const lead = Math.max(0, Math.floor((width - label.length) / 2))

  const bridgeFg = settling ? colors.success : colors.heading
  return {
    bridge: trimTrailing([
      { text: space(pad), fg: colors.textMuted },
      { text: "◉", fg: colors.accent },
      { text: bridgeCells.join(""), fg: bridgeFg },
      { text: "◉", fg: colors.identity },
      { text: space(pad), fg: colors.textMuted },
    ]),
    arc: trimTrailing([
      { text: space(pad + 1), fg: colors.success },
      { text: arcCells.join(""), fg: colors.success },
    ]),
    caption:
      label.length > 0
        ? [{ text: space(lead), fg: colors.success }, { text: label, fg: colors.success }]
        : [],
  }
}

function renderDissolving(
  width: number,
  pad: number,
  elapsed: number,
  motion: boolean,
): SceneGrid {
  const L = trackWidth(width, pad)
  const pos = timelineAt(DISSOLVE_PHASES, motion ? elapsed : Number.MAX_SAFE_INTEGER)

  // Fray: the arc lifts away first — the shared structure goes before the nodes.
  const arcLen = L + 1
  const arcOrder = centerOut(arcLen)
  const arcKeep = Math.round((1 - easeInQuad(pos.name === "fray" ? pos.progress : 1)) * arcLen)
  const arcCells = new Array<string>(arcLen).fill(" ")
  for (let i = 0; i < Math.min(arcKeep, arcLen); i++) {
    const idx = arcOrder[i]!
    arcCells[idx] = idx === 0 ? "\\" : idx === arcLen - 1 ? "/" : "_"
  }

  // Break: dashes fall away center-outward into dust (`·`) and then silence.
  const breakProgress = pos.done ? 1 : pos.name === "break" ? pos.progress : 0
  const breakRadius = easeInQuad(breakProgress) * (L / 2 + 1)
  const mid = (L - 1) / 2
  let bridgeCells = ""
  for (let i = 0; i < L; i++) {
    if (breakRadius <= 0) {
      bridgeCells += "─"
      continue
    }
    const d = Math.abs(i - mid)
    if (d < breakRadius) bridgeCells += " "
    else if (d < breakRadius + 1) bridgeCells += "·"
    else bridgeCells += "─"
  }

  // After the break, honest retry pantomime ONLY because the real link IS
  // retrying: `reconnecting` keeps attempting. Short reaches grow inward from
  // both nodes, retreat, rest. Reduced motion shows the broken bridge and
  // lets the words carry the meaning.
  const afterMs = elapsed - pos.total
  // The two nodes ALWAYS keep their distance — even resting between retry
  // pulses — because autonomy survives the link.
  const t = afterMs >= 0 ? afterMs % RECONNECT_CYCLE_MS : 0
  const attempt = pos.done && motion && t < 1200 ? Math.sin((t / 1200) * Math.PI) : 0
  const reach = Math.round(attempt * (L / 3))
  const inner = Math.max(0, L - reach * 2)
  const body: Span[] = !pos.done
    ? [{ text: bridgeCells, fg: colors.danger }]
    : reach > 0
      ? [
          { text: "─".repeat(reach), fg: colors.warning },
          { text: space(inner), fg: colors.textMuted },
          { text: "─".repeat(reach), fg: colors.warning },
        ]
      : [{ text: space(L), fg: colors.textMuted }]

  const caption = pos.done ? "reconnecting" : "union dissolving"
  const dotTick = Math.floor(Math.max(0, afterMs) / 360)
  const dots = motion && pos.done ? ".".repeat((dotTick % 3) + 1) : ""

  return {
    bridge: trimTrailing([
      { text: space(pad), fg: colors.textMuted },
      { text: "◉", fg: colors.accent },
      ...body,
      { text: "◉", fg: colors.identity },
      { text: space(pad), fg: colors.textMuted },
    ]),
    arc: arcKeep > 0
      ? trimTrailing([
          { text: space(pad + 1), fg: colors.danger },
          { text: arcCells.join(""), fg: colors.danger },
        ])
      : [],
    caption: [{ text: `${caption}${dots}`, fg: pos.done ? colors.warning : colors.danger }],
  }
}

function phaseSignature(phase: UnionPhase): string {
  switch (phase.kind) {
    case "formed":
      return `formed:${phase.name ?? ""}`
    default:
      return `${phase.kind}:${phase.caption ?? ""}`
  }
}

/**
 * The scene block: three fixed rows (bridge / arc / caption) so surrounding
 * layout never jumps as phases change. Width-adaptive; clamped to sane bounds.
 */
export function UnionScene(props: { phase: UnionPhase; width: number }): ReactNode {
  const { phase, width } = props
  const w = Math.max(12, Math.min(Math.floor(width) || 12, 64))
  const pad = w >= 22 ? 2 : 1
  const motion = animsEnabled()

  // Wall-clock anchor per phase signature: re-entering a phase replays it,
  // ticking only forces repaints (the shared clock stays the sole heartbeat).
  const sig = phaseSignature(phase)
  const startedAtRef = useRef(Date.now())
  const lastSigRef = useRef(sig)
  if (lastSigRef.current !== sig) {
    lastSigRef.current = sig
    startedAtRef.current = Date.now()
  }
  const startedAt = startedAtRef.current

  const looping =
    phase.kind === "reaching" ||
    phase.kind === "acknowledging" ||
    // Reconnecting keeps genuinely retrying, so its scene keeps breathing.
    phase.kind === "dissolving"
  const oneShotTotal =
    phase.kind === "formed"
      ? BLOOM_PHASES.reduce((s, p) => s + p.ms, 0)
      : 0
  const elapsed = Date.now() - startedAt
  const needsRepaint = motion && (looping || (oneShotTotal > 0 && elapsed < oneShotTotal + 200))
  useTick(needsRepaint, 90)

  let grid: SceneGrid
  switch (phase.kind) {
    case "reaching":
      grid = renderReaching(w, pad, elapsed, motion, phase.caption)
      break
    case "acknowledging":
      grid = renderAcknowledging(w, pad, elapsed, motion, phase.caption)
      break
    case "formed":
      grid = renderFormed(w, pad, elapsed, motion)
      break
    case "dissolving":
      grid = renderDissolving(w, pad, elapsed, motion)
      break
    default:
      grid = renderApart(w, pad, phase.caption)
  }

  // Zero-width spans are skipped outright: an empty <text> node still takes
  // part in the row measure, and the row budget above assumes real cells only.
  const row = (spans: Span[]): Span[] => spans.filter((s) => s.text.length > 0)

  return (
    <box style={{ flexDirection: "column", width: w, height: 3 }}>
      <box style={{ flexDirection: "row", height: 1 }}>
        {row(grid.bridge).map((span, i) => (
          <text key={`b${i}`} fg={span.fg}>{span.text}</text>
        ))}
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        {row(grid.arc).map((span, i) => (
          <text key={`a${i}`} fg={span.fg}>{span.text}</text>
        ))}
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        {row(grid.caption).map((span, i) => (
          <text key={`c${i}`} fg={span.fg}>{span.text}</text>
        ))}
      </box>
    </box>
  )
}
