// The line that answers "what is happening right now".
//
// Four questions the interface could not answer while you were typing: am I
// findable, is anyone connected, am I in a room, is my microphone live. Each
// had a half-answer somewhere else and none of them were on screen.
import { describe, expect, test } from "bun:test"
import type { PeerInfo, RoomView } from "../src/core/contract"
import { fitSegments, statusSegments, type StatusInput } from "../src/ui/status-line"

const SELF = "A".repeat(64)
const THEM = "B".repeat(64)

const peer = (over: Partial<PeerInfo> = {}): PeerInfo => ({
  peerId: THEM,
  name: "roshan",
  status: "connected",
  ...over,
})

const base: StatusInput = {
  name: "zemo",
  publishedAs: null,
  peers: [],
  room: null,
  voiceParticipants: [],
  selfId: SELF,
  micMuted: false,
}

const text = (input: StatusInput) => statusSegments(input).map((s) => s.text).join(" · ")

describe("being findable", () => {
  test("says so when published, under which name", () => {
    expect(text({ ...base, publishedAs: "zemo" })).toContain("findable as zemo")
  })

  test("says so when not", () => {
    expect(text(base)).toContain("not published")
  })
})

describe("being connected", () => {
  test("a fresh node and a dropped peer are different states", () => {
    // "no one connected" vs "connecting…" — one is waiting on you, the other on
    // the network, and conflating them is how a stall looks like idleness.
    expect(text(base)).toContain("no one connected")
    expect(text({ ...base, peers: [peer({ status: "connecting" })] })).toContain("connecting…")
    expect(text({ ...base, peers: [peer({ status: "authenticating" })] })).toContain("connecting…")
  })

  test("one peer is named, with the transport carrying them", () => {
    const said = text({ ...base, peers: [peer()], routeOf: () => "udp" })
    expect(said).toContain("roshan connected over udp")
  })

  test("the transport is omitted when the build cannot tell", () => {
    expect(text({ ...base, peers: [peer()] })).toContain("roshan connected")
    expect(text({ ...base, peers: [peer()] })).not.toContain("over")
  })

  test("a renamed contact shows the name you gave them", () => {
    const said = text({ ...base, peers: [peer({ displayName: "Roshan (work)" })] })
    expect(said).toContain("Roshan (work) connected")
  })

  test("several are counted rather than listed", () => {
    const peers = [peer(), peer({ peerId: "C".repeat(64), name: "sam" })]
    expect(text({ ...base, peers })).toContain("2 connected")
  })

  test("peers that are not connected do not count as connected", () => {
    expect(text({ ...base, peers: [peer({ status: "offline" })] })).toContain("no one connected")
  })
})

describe("being in a room", () => {
  const room = { roomId: "r1", name: "zemo & roshan" } as unknown as RoomView

  test("names the room", () => {
    expect(text({ ...base, room })).toContain('in "zemo & roshan"')
  })

  test("says nothing about voice when nobody is in it", () => {
    expect(text({ ...base, room })).not.toContain("voice")
  })

  test("someone else in voice is an invitation to join", () => {
    const said = text({ ...base, room, voiceParticipants: [THEM] })
    expect(said).toContain("/call to join")
  })

  test("being in voice alone says so, rather than implying company", () => {
    expect(text({ ...base, room, voiceParticipants: [SELF] })).toContain("voice: live, alone")
  })

  test("being in voice with others counts the others, not yourself", () => {
    const said = text({ ...base, room, voiceParticipants: [SELF, THEM] })
    expect(said).toContain("voice: live with 1")
  })

  test("muted wins the slot, because it is the fact people forget", () => {
    const said = text({ ...base, room, voiceParticipants: [SELF, THEM], micMuted: true })
    expect(said).toContain("MUTED")
    expect(said).not.toContain("live with")
  })
})

describe("narrow terminals", () => {
  const full: StatusInput = {
    ...base,
    publishedAs: "zemo",
    peers: [peer()],
    routeOf: () => "udp",
    room: { roomId: "r1", name: "zemo & roshan" } as unknown as RoomView,
    voiceParticipants: [SELF, THEM],
  }

  test("segments drop from the right, never overflow", () => {
    for (const width of [10, 20, 40, 60, 80, 120]) {
      const kept = fitSegments(statusSegments(full), width)
      const rendered = kept.map((s) => s.text).join(" · ")
      expect(rendered.length).toBeLessThanOrEqual(Math.max(width, 10))
    }
  })

  test("your own name survives the narrowest window", () => {
    // Losing every segment would leave a blank row that says nothing at all.
    const kept = fitSegments(statusSegments(full), 6)
    expect(kept.length).toBeGreaterThan(0)
  })

  test("a wide terminal keeps everything", () => {
    const all = statusSegments(full)
    expect(fitSegments(all, 200)).toHaveLength(all.length)
  })
})
