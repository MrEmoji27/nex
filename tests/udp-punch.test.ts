// Hole punching, tested as two peers behind simulated routers.
//
// The behaviour that matters is not "a packet arrives" — it is that packets
// arriving BEFORE the local mapping exists are dropped, and that both sides
// sending anyway is what creates the mapping. A test that delivered everything
// would pass without exercising the mechanism at all.
import { describe, expect, test } from "bun:test"
import { HolePuncher, type Endpoint } from "../src/network/udp/punch"

const A: Endpoint = { host: "203.0.113.1", port: 4001 }
const B: Endpoint = { host: "198.51.100.2", port: 4002 }

/**
 * A router that only forwards inbound packets from somewhere it has already
 * sent to — which is exactly what makes punching necessary.
 */
class Nat {
  private opened = new Set<string>()
  private inbox: Array<{ data: Uint8Array; from: Endpoint }> = []

  recordOutbound(to: Endpoint): void {
    this.opened.add(`${to.host}:${to.port}`)
  }
  deliver(data: Uint8Array, from: Endpoint): boolean {
    if (!this.opened.has(`${from.host}:${from.port}`)) return false
    this.inbox.push({ data, from })
    return true
  }
  drain(): Array<{ data: Uint8Array; from: Endpoint }> {
    return this.inbox.splice(0)
  }
}

describe("hole punching", () => {
  test("both sides sending opens a path neither could open alone", () => {
    const natA = new Nat()
    const natB = new Nat()
    let openedAt: Endpoint | null = null
    let dropped = 0

    const a = new HolePuncher({
      candidates: [B],
      send: (d, to) => {
        natA.recordOutbound(to)
        if (!natB.deliver(d, A)) dropped += 1
      },
      onOpen: (e) => (openedAt = e),
      onFail: () => {},
    })
    const b = new HolePuncher({
      candidates: [A],
      send: (d, to) => {
        natB.recordOutbound(to)
        natA.deliver(d, B)
      },
      onOpen: () => {},
      onFail: () => {},
    })

    let now = 0
    for (let i = 0; i < 10 && !a.isSettled; i++) {
      a.tick(now)
      b.tick(now)
      for (const p of natB.drain()) b.onDatagram(p.data, p.from)
      for (const p of natA.drain()) a.onDatagram(p.data, p.from)
      now += 130
    }

    expect(a.isSettled).toBe(true)
    expect(openedAt as Endpoint | null).toEqual(B)
    // The first packet was dropped: B's router had no mapping for A yet. That
    // dropped packet is what opened A's own side.
    expect(dropped).toBeGreaterThan(0)
  })

  test("gives up rather than hanging when nothing gets through", () => {
    let reason = ""
    const p = new HolePuncher({
      candidates: [B],
      send: () => {}, // both sides symmetric; nothing is ever delivered
      onOpen: () => {},
      onFail: (r) => (reason = r),
    })
    let now = 0
    for (let i = 0; i < 200 && !p.isSettled; i++) {
      p.tick(now)
      now += 120
    }
    expect(p.isSettled).toBe(true)
    expect(reason).toContain("symmetric NAT")
  })

  test("every candidate is tried each round, not one after another", () => {
    const tried: string[] = []
    const p = new HolePuncher({
      candidates: [A, B, { host: "192.168.1.5", port: 42001 }],
      send: (_d, to) => tried.push(`${to.host}:${to.port}`),
      onOpen: () => {},
      onFail: () => {},
    })
    p.tick(0)
    // A peer publishes a local and a public address and which one works is not
    // knowable in advance; sequencing them would spend the budget on the wrong
    // one first.
    expect(new Set(tried).size).toBe(3)
  })

  test("unrelated traffic does not count as an open path", () => {
    let opened = false
    const p = new HolePuncher({
      candidates: [B],
      send: () => {},
      onOpen: () => (opened = true),
      onFail: () => {},
    })
    p.onDatagram(new Uint8Array([1, 0, 0, 0, 0]), B) // FRAME_DATA, not a punch
    p.onDatagram(new Uint8Array(0), B)
    expect(opened).toBe(false)
    expect(p.isSettled).toBe(false)
  })

  test("does not fire faster than the interval", () => {
    let fires = 0
    const p = new HolePuncher({
      candidates: [B],
      send: () => (fires += 1),
      onOpen: () => {},
      onFail: () => {},
    })
    // A router that rate-limits would treat a tight loop as a flood.
    p.tick(0)
    p.tick(1)
    p.tick(2)
    expect(fires).toBe(1)
  })
})
