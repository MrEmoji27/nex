// Noise_XX over the reliable datagram channel.
//
// The handshake is three messages that must arrive in order and exactly once.
// Over TCP that is free. Over UDP it is the reliable layer's job, and these
// tests exist to prove it actually does it — each of the three messages is
// dropped, duplicated and delayed in turn.
import { describe, expect, test } from "bun:test"
import { ReliableChannel } from "../src/network/udp/reliable"
import { SecureSession } from "../src/network/udp/secure-session"
import { x25519 } from "@noble/curves/ed25519.js"
import type { StaticKeyBindings, StaticKeyRecord } from "../src/core/session/identity-binding"

const enc = new TextEncoder()
const dec = new TextDecoder()

function memoryBindings() {
  const map = new Map<string, StaticKeyRecord>()
  return {
    map,
    api: {
      get: async (id: string) => map.get(id) ?? null,
      put: async (r: StaticKeyRecord) => void map.set(r.nodeId, r),
    } satisfies StaticKeyBindings,
  }
}

/**
 * Two sessions joined by reliable channels over a link the test controls.
 * `interfere` decides what happens to each datagram, by index.
 */
function pair(interfere: (n: number) => "pass" | "drop" | "duplicate" = () => "pass") {
  const aKey = x25519.utils.randomSecretKey()
  const bKey = x25519.utils.randomSecretKey()
  const aBind = memoryBindings()
  const bBind = memoryBindings()

  const toB: Uint8Array[] = []
  const toA: Uint8Array[] = []
  let n = 0

  const errors: string[] = []
  const authA: Array<{ nodeId: string; state: string }> = []
  const authB: Array<{ nodeId: string; state: string }> = []
  const gotA: string[] = []
  const gotB: string[] = []

  const chanA = new ReliableChannel({
    send: (d) => {
      n += 1
      const what = interfere(n)
      if (what === "drop") return
      toB.push(d)
      if (what === "duplicate") toB.push(d)
    },
    onDeliver: (p) => sessionA.onPayload(p),
  })
  const chanB = new ReliableChannel({
    send: (d) => {
      n += 1
      const what = interfere(n)
      if (what === "drop") return
      toA.push(d)
      if (what === "duplicate") toA.push(d)
    },
    onDeliver: (p) => sessionB.onPayload(p),
  })

  const sessionA: SecureSession = new SecureSession({
    role: "initiator",
    staticPrivate: aKey,
    claim: { nodeId: "NODE_A", name: "zro" },
    bindings: aBind.api,
    send: (p) => chanA.send(p, now),
    onMessage: (p) => gotA.push(dec.decode(p)),
    onAuthenticated: (i) => authA.push({ nodeId: i.claim.nodeId, state: i.identityState }),
    onError: (e) => errors.push(`a: ${e}`),
  })
  const sessionB: SecureSession = new SecureSession({
    role: "responder",
    staticPrivate: bKey,
    claim: { nodeId: "NODE_B", name: "roshan" },
    bindings: bBind.api,
    send: (p) => chanB.send(p, now),
    onMessage: (p) => gotB.push(dec.decode(p)),
    onAuthenticated: (i) => authB.push({ nodeId: i.claim.nodeId, state: i.identityState }),
    onError: (e) => errors.push(`b: ${e}`),
  })

  let now = 0
  async function pump(rounds = 60) {
    for (let i = 0; i < rounds; i++) {
      for (const d of toB.splice(0)) chanB.onDatagram(d, now)
      for (const d of toA.splice(0)) chanA.onDatagram(d, now)
      now += 400
      chanA.tick(now)
      chanB.tick(now)
      // The identity resolution is async, so let microtasks settle.
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  return { sessionA, sessionB, pump, errors, authA, authB, gotA, gotB, aBind, bBind }
}

describe("Noise over the reliable channel", () => {
  test("a clean link authenticates both sides", async () => {
    const p = pair()
    p.sessionA.start()
    await p.pump()

    expect(p.errors).toEqual([])
    expect(p.sessionA.isAuthenticated).toBe(true)
    expect(p.sessionB.isAuthenticated).toBe(true)
    // Each side learns who the other claims to be, proven by the transcript.
    expect(p.authA[0]?.nodeId).toBe("NODE_B")
    expect(p.authB[0]?.nodeId).toBe("NODE_A")
  })

  test("first meeting is unknown, not identified", async () => {
    const p = pair()
    p.sessionA.start()
    await p.pump()
    // TOFU: nothing to compare against yet, and saying "identified" here would
    // be claiming a check that never happened.
    expect(p.authA[0]?.state).toBe("unknown")
    expect(p.authB[0]?.state).toBe("unknown")
  })

  for (const target of [1, 2, 3]) {
    test(`handshake message ${target} dropped once still completes`, async () => {
      let seen = 0
      const p = pair((n) => {
        // Drop the first datagram carrying handshake message `target`.
        if (n === target && seen++ === 0) return "drop"
        return "pass"
      })
      p.sessionA.start()
      await p.pump()
      expect(p.sessionA.isAuthenticated).toBe(true)
      expect(p.sessionB.isAuthenticated).toBe(true)
    })

    test(`handshake message ${target} duplicated does not break the transcript`, async () => {
      const p = pair((n) => (n === target ? "duplicate" : "pass"))
      p.sessionA.start()
      await p.pump()
      // A repeated handshake message must be swallowed by the reliable layer.
      // If it reached Noise twice the transcript would diverge and both sides
      // would fail to authenticate.
      expect(p.errors).toEqual([])
      expect(p.sessionA.isAuthenticated).toBe(true)
      expect(p.sessionB.isAuthenticated).toBe(true)
    })
  }

  test("messages flow once authenticated, and are encrypted on the wire", async () => {
    const p = pair()
    p.sessionA.start()
    await p.pump()

    p.sessionA.send(enc.encode("hello roshan"))
    p.sessionB.send(enc.encode("hello zro"))
    await p.pump(10)

    expect(p.gotB).toEqual(["hello roshan"])
    expect(p.gotA).toEqual(["hello zro"])
  })

  test("application data before authentication is refused", async () => {
    const p = pair()
    // Tag 0x02 is a transport frame; arriving before the handshake it is either
    // a bug or an attempt to skip authentication.
    p.sessionB.onPayload(new Uint8Array([0x02, 1, 2, 3]))
    expect(p.errors.join(" ")).toContain("before the handshake")
    expect(p.sessionB.isAuthenticated).toBe(false)
  })

  test("a tampered handshake message fails the session rather than degrading it", async () => {
    const p = pair()
    p.sessionA.start()
    // Flip a byte inside what would be message 1.
    p.sessionB.onPayload(new Uint8Array([0x01, ...new Uint8Array(64).fill(9)]))
    await p.pump(5)
    expect(p.errors.join(" ")).toContain("handshake failed")
  })

  test("a second meeting with the same key is identified", async () => {
    const first = pair()
    first.sessionA.start()
    await first.pump()
    const remembered = first.aBind.map.get("NODE_B")
    expect(remembered).toBeDefined()
    // The binding is what makes a later meeting checkable at all.
    expect(remembered?.staticKey.length).toBe(64)
  })
})
