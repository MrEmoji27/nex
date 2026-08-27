// The reliable channel, tested against a link that misbehaves on purpose.
//
// The point of this layer is that UDP drops, reorders and duplicates, and the
// layers above cannot cope with any of it. So the tests do those things
// deliberately and deterministically, rather than hoping a real network
// happens to.
import { describe, expect, test } from "bun:test"
import { MAX_PAYLOAD, ReliableChannel, decodeFrame, encodeFrame, FRAME_DATA } from "../src/network/udp/reliable"

const text = (s: string) => new TextEncoder().encode(s)
const read = (b: Uint8Array) => new TextDecoder().decode(b)

/**
 * Two channels joined by a link the test controls: it can drop, duplicate,
 * reorder and delay, and time only moves when the test says so.
 */
function link(opts: { drop?: (n: number) => boolean; reorder?: boolean } = {}) {
  const aIn: Uint8Array[] = []
  const bIn: Uint8Array[] = []
  const deliveredToA: string[] = []
  const deliveredToB: string[] = []
  let count = 0
  let now = 0

  const a = new ReliableChannel({
    send: (d) => {
      count += 1
      if (opts.drop?.(count)) return
      bIn.push(d)
    },
    onDeliver: (p) => deliveredToA.push(read(p)),
  })
  const b = new ReliableChannel({
    send: (d) => {
      count += 1
      if (opts.drop?.(count)) return
      aIn.push(d)
    },
    onDeliver: (p) => deliveredToB.push(read(p)),
  })

  function pump(rounds = 20) {
    for (let i = 0; i < rounds; i++) {
      const toB = bIn.splice(0)
      const toA = aIn.splice(0)
      if (opts.reorder) {
        toB.reverse()
        toA.reverse()
      }
      for (const d of toB) b.onDatagram(d, now)
      for (const d of toA) a.onDatagram(d, now)
      now += 500
      a.tick(now)
      b.tick(now)
    }
  }

  return { a, b, pump, deliveredToA, deliveredToB, at: () => now }
}

describe("reliable channel over datagrams", () => {
  test("delivers in order on a clean link", () => {
    const l = link()
    for (const s of ["one", "two", "three"]) l.a.send(text(s), 0)
    l.pump()
    expect(l.deliveredToB).toEqual(["one", "two", "three"])
  })

  test("recovers everything when a third of frames are dropped", () => {
    const l = link({ drop: (n) => n % 3 === 0 })
    const sent = ["a", "b", "c", "d", "e", "f"]
    for (const s of sent) l.a.send(text(s), 0)
    l.pump(40)
    expect(l.deliveredToB).toEqual(sent)
  })

  test("reordering does not reach the application", () => {
    const l = link({ reorder: true })
    const sent = ["1", "2", "3", "4", "5"]
    for (const s of sent) l.a.send(text(s), 0)
    l.pump(30)
    // Arrival order was reversed on the wire every round; delivery order is not.
    expect(l.deliveredToB).toEqual(sent)
  })

  test("a duplicated datagram is delivered once", () => {
    const seen: string[] = []
    const out: Uint8Array[] = []
    const rx = new ReliableChannel({ send: (d) => out.push(d), onDeliver: (p) => seen.push(read(p)) })
    const frame = encodeFrame(FRAME_DATA, 1, 0, text("only once"))
    rx.onDatagram(frame, 0)
    rx.onDatagram(frame, 0)
    rx.onDatagram(frame, 0)
    expect(seen).toEqual(["only once"])
  })

  test("a retransmit still gets acknowledged after the ack was lost", () => {
    // The receiver already delivered this, so silence would make the sender
    // retransmit forever. It must acknowledge again instead.
    const out: Uint8Array[] = []
    const rx = new ReliableChannel({ send: (d) => out.push(d), onDeliver: () => {} })
    rx.onDatagram(encodeFrame(FRAME_DATA, 1, 0, text("x")), 0)
    out.length = 0
    rx.onDatagram(encodeFrame(FRAME_DATA, 1, 0, text("x")), 0)
    expect(out.length).toBe(1)
    expect(decodeFrame(out[0]!)?.ack).toBe(1)
  })

  test("a channel whose peer never answers is declared dead, not hung", () => {
    let reason = ""
    const ch = new ReliableChannel({
      send: () => {}, // black hole
      onDeliver: () => {},
      onDead: (r) => (reason = r),
    })
    ch.send(text("hello"), 0)
    let now = 0
    for (let i = 0; i < 20; i++) {
      now += 5000
      ch.tick(now)
    }
    expect(ch.isDead).toBe(true)
    expect(reason).toContain("acknowledgement")
  })

  test("nothing is retransmitted once acknowledged", () => {
    const l = link()
    l.a.send(text("done"), 0)
    l.pump()
    expect(l.a.inFlight).toBe(0)
  })

  test("an oversized payload is refused rather than silently fragmented", () => {
    const ch = new ReliableChannel({ send: () => {}, onDeliver: () => {} })
    // A fragmented UDP datagram is lost whole when any fragment is, so this has
    // to be the caller's problem, loudly.
    expect(() => ch.send(new Uint8Array(MAX_PAYLOAD + 1), 0)).toThrow(/exceeds/)
  })

  test("a truncated or mislabelled datagram is ignored", () => {
    const seen: string[] = []
    const ch = new ReliableChannel({ send: () => {}, onDeliver: (p) => seen.push(read(p)) })
    ch.onDatagram(new Uint8Array(3), 0)
    ch.onDatagram(new Uint8Array(0), 0)
    // Header claims a longer payload than the datagram carries.
    const lying = encodeFrame(FRAME_DATA, 1, 0, text("hi")).subarray(0, 11)
    ch.onDatagram(lying, 0)
    expect(seen).toEqual([])
  })
})
