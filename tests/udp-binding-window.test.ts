// Regression: frames arriving during the TOFU binding window must be queued.
//
// The TCP transport hit this first and fixed it (tests/binding-window.test.ts).
// The UDP session was written without the same guard and reintroduced it, and
// it was found the way these things are always found — on a real run against
// the deployed service, as an error nobody asked for:
//
//   [transport] 192.168.0.100:65092: transport message arrived before the
//   handshake completed
//
// The window is real and ordinary. A handshake completes synchronously; working
// out WHO the peer is does not, because it reads a store. The peer cannot see
// that gap: from their side the handshake is done, so they send.
//
// On UDP the consequence is worse than a lost message. The receive cipher
// advances a nonce per frame, so a frame that is never decrypted leaves the two
// counters permanently one apart and every later frame fails authentication.
// The link stays "connected" and carries nothing at all.
import { afterEach, describe, expect, test } from "bun:test"
import { x25519 } from "@noble/curves/ed25519.js"
import type { NodeIdentity } from "../src/core/contract"
import type { StaticKeyBindings, StaticKeyRecord } from "../src/core/session/identity-binding"
import { formatUdpAddress, UdpTransport } from "../src/network/udp/udp-transport"

const LOCAL = "127.0.0.1"
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const nodeIdFor = (c: string) => c.repeat(64).slice(0, 64).toUpperCase()

/** A store that stalls, which is what widens the window on a real machine. */
function slowBindings(delayMs: number): StaticKeyBindings {
  const map = new Map<string, StaticKeyRecord>()
  return {
    get: async (id: string) => {
      await Bun.sleep(delayMs)
      return map.get(id) ?? null
    },
    put: async (r: StaticKeyRecord) => {
      await Bun.sleep(delayMs)
      map.set(r.nodeId, r)
    },
  }
}

function fastBindings(): StaticKeyBindings {
  const map = new Map<string, StaticKeyRecord>()
  return {
    get: async (id: string) => map.get(id) ?? null,
    put: async (r: StaticKeyRecord) => void map.set(r.nodeId, r),
  }
}

const running: UdpTransport[] = []
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
})

async function node(name: string, seed: string, bindings: StaticKeyBindings) {
  const identity: NodeIdentity = { nodeId: nodeIdFor(seed), name, createdAt: Date.now() }
  const messages: string[] = []
  const errors: string[] = []
  const transport = new UdpTransport({ identityPrivHex: hex(x25519.utils.randomSecretKey()), bindings })
  transport.onMessage((_peer, content) => messages.push(content))
  transport.onError((_scope, message) => errors.push(message))
  const port = await transport.start({ port: 0, identity })
  running.push(transport)
  return { transport, identity, port, messages, errors }
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error("condition not met in time")
}

describe("the TOFU binding window", () => {
  test("messages sent the instant the handshake completes are not lost", async () => {
    // Roshan's store stalls for 300ms after the handshake, which is the window.
    const roshan = await node("roshan", "b", slowBindings(300))
    const zro = await node("zro", "a", fastBindings())

    const accepted = roshan.transport.expect(zro.identity.nodeId, [{ host: LOCAL, port: zro.port }])
    const peer = await zro.transport.dial(formatUdpAddress(roshan.identity.nodeId, [{ host: LOCAL, port: roshan.port }]))
    expect(peer.status).toBe("connected")

    // Zro is authenticated and sends at once. Roshan is still deciding who Zro
    // is, so these arrive inside the window.
    await zro.transport.send(roshan.identity.nodeId, "first")
    await zro.transport.send(roshan.identity.nodeId, "second")
    await accepted

    // All of them, in order. Before the fix "first" was discarded and "second"
    // then failed to authenticate, so nothing ever arrived again.
    await waitFor(() => roshan.messages.length >= 2)
    expect(roshan.messages).toEqual(["first", "second"])

    // And the session is still usable afterwards, which is the part a dropped
    // frame quietly destroys.
    await zro.transport.send(roshan.identity.nodeId, "third")
    await waitFor(() => roshan.messages.length >= 3)
    expect(roshan.messages).toEqual(["first", "second", "third"])
    expect(roshan.errors).toEqual([])
  }, 30_000)

  test("application data before any handshake is still refused", async () => {
    // The queue exists for one specific window: handshake complete, binding
    // pending. It must not become a way to be heard before the handshake.
    const roshan = await node("roshan", "d", fastBindings())
    const zro = await node("zro", "c", fastBindings())

    const accepted = roshan.transport.expect(zro.identity.nodeId, [{ host: LOCAL, port: zro.port }])
    await zro.transport.dial(formatUdpAddress(roshan.identity.nodeId, [{ host: LOCAL, port: roshan.port }]))
    await accepted

    // Sending is impossible before authentication — the transport refuses, and
    // that refusal is the guarantee, not a convenience.
    await expect(zro.transport.send(nodeIdFor("9"), "hello")).rejects.toThrow(/not connected/)
  }, 30_000)
})
