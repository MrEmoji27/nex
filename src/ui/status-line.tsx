// One line that is always true.
//
// Four questions a person asks constantly and the interface could not answer:
// am I findable, is anyone connected, am I in a room, is the microphone live.
// Each had a different half-answer somewhere else — `/net`, the rendezvous
// status command, a peer pane, a voice strip that only appeared once a room
// existed — and none of them were on screen while you were typing.
//
// The segments drop from the right as the terminal narrows, so the leftmost
// facts (who you are, who you are talking to) survive on a small window.

import type { PeerInfo, RoomView } from "../core/contract.ts"
import { colors } from "./theme"

export type Tone = "good" | "warn" | "idle"

export interface Segment {
  text: string
  tone: Tone
}

export interface StatusInput {
  name: string
  /** Handle presence is published under, or null when not findable. */
  publishedAs: string | null
  peers: readonly PeerInfo[]
  /** Which transport carries a peer, when the build can tell. */
  routeOf?: (peerId: string) => "tcp" | "udp" | null
  room: RoomView | null
  /** Node ids currently in the room's voice channel. */
  voiceParticipants: readonly string[]
  selfId: string
  micMuted: boolean
}

/**
 * Build the segments, widest first.
 *
 * Deliberately returns data rather than a string: the tone of each part is what
 * makes "connected" readable at a glance, and a caller that only wanted text
 * would have to parse it back out.
 */
export function statusSegments(input: StatusInput): Segment[] {
  const segments: Segment[] = []

  segments.push({ text: input.name, tone: "idle" })

  segments.push(
    input.publishedAs
      ? { text: `findable as ${input.publishedAs}`, tone: "good" }
      : { text: "not published", tone: "idle" },
  )

  const connected = input.peers.filter((p) => p.status === "connected")
  if (connected.length === 0) {
    // Named separately from "0 connected" because the two states differ: one is
    // a fresh node, the other is a peer that dropped.
    const busy = input.peers.some((p) => p.status === "connecting" || p.status === "authenticating")
    segments.push({ text: busy ? "connecting…" : "no one connected", tone: busy ? "warn" : "idle" })
  } else if (connected.length === 1) {
    const peer = connected[0]!
    const route = input.routeOf?.(peer.peerId)
    segments.push({
      text: `${peer.displayName ?? peer.name} connected${route ? ` over ${route}` : ""}`,
      tone: "good",
    })
  } else {
    segments.push({ text: `${connected.length} connected`, tone: "good" })
  }

  if (input.room) {
    segments.push({ text: `in "${input.room.name}"`, tone: "good" })

    const inVoice = input.voiceParticipants.includes(input.selfId)
    const others = input.voiceParticipants.filter((id) => id !== input.selfId).length
    if (inVoice) {
      segments.push({
        // Muted is a fact people forget and then talk into nothing, so it wins
        // the slot over the participant count.
        text: input.micMuted ? "voice: MUTED" : others > 0 ? `voice: live with ${others}` : "voice: live, alone",
        tone: input.micMuted ? "warn" : "good",
      })
    } else if (input.voiceParticipants.length > 0) {
      segments.push({ text: `voice: ${input.voiceParticipants.length} talking — /call to join`, tone: "warn" })
    }
  }

  return segments
}

/** Render segments into `width`, dropping from the right until they fit. */
export function fitSegments(segments: readonly Segment[], width: number): Segment[] {
  const sep = 3 // " · "
  const kept: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const cost = (kept.length === 0 ? 0 : sep) + segment.text.length
    if (used + cost > width) break
    kept.push(segment)
    used += cost
  }
  // The name alone is worth more than an empty line, even truncated.
  if (kept.length === 0 && segments.length > 0) {
    return [{ ...segments[0]!, text: segments[0]!.text.slice(0, Math.max(1, width)) }]
  }
  return kept
}

const TONE_COLOR: Record<Tone, string> = {
  good: colors.success,
  warn: colors.warning,
  idle: colors.textMuted,
}

export function StatusLine(props: StatusInput & { width: number }) {
  const { width, ...input } = props
  const segments = fitSegments(statusSegments(input), Math.max(8, width - 2))

  return (
    <box style={{ width, height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}>
      {segments.map((segment, i) => (
        <box key={i} style={{ flexDirection: "row" }}>
          {i > 0 ? <text fg={colors.dim}>{" · "}</text> : null}
          <text fg={TONE_COLOR[segment.tone]}>{segment.text}</text>
        </box>
      ))}
    </box>
  )
}
