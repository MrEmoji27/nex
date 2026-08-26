// Shared animation infrastructure for the TUI.
//
// ONE clock registry drives every frame-based effect in the app (dream vision
// §17/§18, V3 §18: one motion language). Components never own setInterval
// timers — they subscribe through useTick and the registry guarantees:
//
//   - zero subscribers  =>  zero timers (a truly idle app animates nothing)
//   - one timer per distinct frame rate, shared by every consumer of that rate
//   - NEX_NO_ANIM=1 / NEX_NO_MOTION=1 / NO_MOTION=1 make every hook inert so
//     callers fall back to static equivalents that carry the same information
//   - MotionScope suspends everything beneath it while a modal covers the
//     panes; the modal opts its own surface back in — covered surfaces stop
//     repainting entirely instead of burning CPU on invisible animation.
import { createContext, createElement, useContext, useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"

/** Global kill switch for motion (reduced-motion analog for terminals). */
export function animsEnabled(): boolean {
  return (
    process.env.NEX_NO_ANIM !== "1" &&
    process.env.NEX_NO_MOTION !== "1" &&
    process.env.NO_MOTION !== "1"
  )
}

// ---------- shared animation clock ----------

type ClockSubscriber = () => void

const subscribersByRate = new Map<number, Set<ClockSubscriber>>()
const timersByRate = new Map<number, Timer>()
let suspensionDepth = 0

function hasSubscribers(rate: number): boolean {
  const set = subscribersByRate.get(rate)
  return !!set && set.size > 0
}

/** Timers exist exactly while someone listens AND motion may run. */
function syncClock(): void {
  const mayRun = suspensionDepth === 0 && animsEnabled()
  for (const rate of [...subscribersByRate.keys()]) {
    const wanted = mayRun && hasSubscribers(rate)
    const existing = timersByRate.get(rate)
    if (wanted && !existing) {
      const timer = setInterval(() => {
        const subs = subscribersByRate.get(rate)
        if (!subs) return
        for (const sub of [...subs]) sub()
      }, rate)
      // An animation frame must never hold the process open.
      timer.unref?.()
      timersByRate.set(rate, timer)
    } else if (!wanted && existing) {
      clearInterval(existing)
      timersByRate.delete(rate)
    }
  }
}

function subscribeClock(rate: number, sub: ClockSubscriber): () => void {
  let set = subscribersByRate.get(rate)
  if (!set) {
    set = new Set()
    subscribersByRate.set(rate, set)
  }
  set.add(sub)
  syncClock()
  return () => {
    set.delete(sub)
    if (set.size === 0) subscribersByRate.delete(rate)
    syncClock()
  }
}

/**
 * Declarative motion scope. While `suspended`, every hook beneath stops
 * ticking (timers are torn down, not left busy); nested scopes reference-count
 * correctly. The shell suspends while a modal covers the panes; a modal wraps
 * itself in `<MotionScope suspended={false}>` to keep its own surface alive.
 */
const MotionSuspendedContext = createContext(false)

export function MotionScope(props: { suspended: boolean; children: ReactNode }) {
  const suspended = props.suspended
  useEffect(() => {
    if (!suspended) return
    suspensionDepth += 1
    syncClock()
    return () => {
      suspensionDepth = Math.max(0, suspensionDepth - 1)
      syncClock()
    }
  }, [suspended])
  // createElement keeps this module JSX-free (plain .ts) for every importer.
  return createElement(
    MotionSuspendedContext.Provider,
    { value: suspended },
    props.children,
  )
}

/**
 * Re-renders on an interval while active. All Nex motion is frame-based
 * (glyph swaps) through this hook so timing stays on the shared clock.
 * Inert when inactive, under any reduced-motion env var, or inside a
 * suspended MotionScope — callers fall back to their static states.
 */
export function useTick(active: boolean, intervalMs = 280): number {
  const covered = useContext(MotionSuspendedContext)
  const run = active && !covered && animsEnabled()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!run) return
    return subscribeClock(intervalMs, () => setTick((v) => v + 1))
  }, [run, intervalMs])
  return tick
}

/**
 * True for `durationMs` whenever `value` changes (first render never counts).
 * The shared primitive behind lifecycle flashes: link up/down, identity
 * settle, count blips. `opts.paused` freezes repainting (covered surfaces);
 * the window still expires by wall time. Inert under reduced-motion env vars.
 */
export function useChangeFlash<T>(
  value: T,
  durationMs: number,
  opts?: { paused?: boolean },
): boolean {
  const prevRef = useRef<{ v: T } | null>(null)
  const [until, setUntil] = useState(0)

  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { v: value }
    if (!animsEnabled()) return
    if (prev && !Object.is(prev.v, value)) {
      setUntil(Date.now() + durationMs)
    }
  }, [value, durationMs])

  const active = !(opts?.paused ?? false) && Date.now() < until
  // Drives repaints while the window is open; inert otherwise.
  useTick(active, Math.min(120, Math.max(60, Math.floor(durationMs / 5))))
  return active
}

/** Half-pie spinner frames (terminal-safe, even widths). */
export const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!
}

/** Trailing dots for progress lines: ".", "..", "...". */
export function dotsFrame(tick: number): string {
  return ".".repeat((tick % 3) + 1)
}
