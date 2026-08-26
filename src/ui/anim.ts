// Pure character-grid animation vocabulary: easings, timelines, sprite
// selection, seek bars, and text reveal. NO timers, NO React, NO theme access
// — everything here is deterministic math over numbers and strings, so scenes
// stay predictable and the shared clock in use-tick.ts remains the only
// heartbeat in the app.
//
// Terminal constraints honored throughout: every helper emits plain cell
// strings; nothing assumes more than one character per cell.

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t)
}

export type Easing = (t: number) => number

export const linear: Easing = (t) => clamp01(t)

export const easeInQuad: Easing = (t) => {
  const u = clamp01(t)
  return u * u
}

export const easeOutQuad: Easing = (t) => {
  const u = 1 - clamp01(t)
  return 1 - u * u
}

export const easeInOutQuad: Easing = (t) => {
  const u = clamp01(t)
  return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)
}

export const easeOutCubic: Easing = (t) => {
  const u = 1 - clamp01(t)
  return 1 - u * u * u
}

// ---------- timelines ----------

/** One named stretch of a timeline. */
export interface Phase {
  readonly name: string
  readonly ms: number
}

export interface PhasePosition {
  index: number
  name: string
  /** 0..1 raw progress WITHIN the current phase (ease it at the call site). */
  progress: number
  /** Wall-clock ms elapsed overall, clamped to the total. */
  elapsed: number
  total: number
  done: boolean
}

/**
 * Locate `elapsedMs` on a timeline of sequential phases. Past the end, the
 * last position is reported with done=true so callers settle statically.
 */
export function timelineAt(phases: readonly Phase[], elapsedMs: number): PhasePosition {
  const total = phases.reduce((sum, p) => sum + p.ms, 0)
  const elapsed = Math.max(0, Math.min(elapsedMs, total))
  let acc = 0
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!
    if (elapsed < acc + phase.ms || i === phases.length - 1) {
      return {
        index: i,
        name: phase.name,
        progress: phase.ms <= 0 ? 1 : clamp01((elapsed - acc) / phase.ms),
        elapsed,
        total,
        done: elapsed >= total,
      }
    }
    acc += phase.ms
  }
  // Unreachable with a non-empty phase list.
  return { index: 0, name: "", progress: 1, elapsed, total, done: true }
}

// ---------- sprites ----------

/**
 * Pick a sprite frame. `tick` may be any integer frame counter; out-of-range
 * indices wrap. Ping-pong traverses forward then backward so loops never jump.
 */
export function spriteFrame(frames: readonly string[], tick: number, pingPong = false): string {
  if (frames.length === 0) return ""
  if (frames.length === 1) return frames[0]!
  let idx = tick % frames.length
  if (idx < 0) idx += frames.length
  if (pingPong) {
    const span = frames.length * 2 - 2
    const t = ((tick % span) + span) % span
    idx = t < frames.length ? t : span - t
  }
  return frames[idx]!
}

// ---------- progress ----------

/**
 * Indeterminate "seek" bar: a fixed-width window drifts along a track by
 * ping-pong `tick`. Honest by construction — it shows activity, never claims
 * completion percentage (a direct link has no meaningful percent).
 */
export function seekBar(
  cells: number,
  tick: number,
  windowCells = 4,
  fill = "▓",
  track = "░",
): string {
  if (cells <= 0) return ""
  const win = Math.max(1, Math.min(windowCells, cells))
  const span = (cells - win) * 2 || 1
  const t = ((tick % span) + span) % span
  const start = t < cells - win ? t : span - t
  let out = ""
  for (let i = 0; i < cells; i++) out += i >= start && i < start + win ? fill : track
  return out
}

// ---------- text ----------

/** First `progress` fraction of `text`, rounded — a character-count reveal. */
export function revealText(text: string, progress: number): string {
  const count = Math.round(clamp01(progress) * text.length)
  return text.slice(0, count)
}
