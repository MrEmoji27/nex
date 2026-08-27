// The UDP transport end to end, on real sockets.
//
// Everything below this level has its own tests with a simulated network. This
// one binds two actual UDP sockets and makes them punch, handshake, authenticate
// and talk — because the layers were each correct on their own long before they
// were correct together, and the ordering rule (nothing starts before the path
// opens) is a property of the wiring, not of any one layer.
import { afterEach, describe, expect, test } from "bun:test"
import { x25519 } from "@noble/curves/ed25519.js"
import type { NodeIdentity } from "../src/core/contract"
import type { StaticKeyRecord } from "../src/core/session/identity-binding"
import { formatUdpAddress, parseUdpAddress, UdpTransport, MAX_OP_PLAINTEXT } from "../src/network/udp/udp-transport"

const LOCAL = "127.0.0.1"

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function nodeIdFor(seed: string): string {
  return seed.repeat(64).slice(0, 64).toUpperCase()
}

function memoryBindings() {
  const map = new Map<string, StaticKeyRecord>()
  return {
    map,
    api: {
      get: async (id: string) => map.get(id) ?? null,
      put: async (r: StaticKeyRecord) => void map.set(r.nodeId, r),
    },
  }
}

interface Node {
  transport: UdpTransport
  identity: NodeIdentity
  port: number
  events: string[]
  messages: Array<{ from: string; content: string }>
  errors: string[]
}

const running: UdpTransport[] = []

async function makeNode(name: string, seedChar: string): Promise<Node> {
  const identity: NodeIdentity = { nodeId: nodeIdFor(seedChar), name, createdAt: Date.now() }
  const events: string[] = []
  const messages: Array<{ from: string; content: string }> = []
  const errors: string[] = []
  const transport = new UdpTransport({
    identityPrivHex: hex(x25519.utils.randomSecretKey()),
    bindings: memoryBindings().api,
    log: (event) => events.push(event),
  })
  transport.onMessage((from, content) => messages.push({ from, content }))
  transport.onError((_scope, message) => errors.push(message))
  const port = await transport.start({ port: 0, identity })
  running.push(transport)
  return { transport, identity, port, events, messages, errors }
}

/** Both sides punch at once, which is what a rendezvous introduction arranges. */
function union(a: Node, b: Node, expectedByB = a.identity.nodeId) {
  const accepted = b.transport.expect(expectedByB, [{ host: LOCAL, port: a.port }])
  const dialed = a.transport.dial(formatUdpAddress(b.identity.nodeId, [{ host: LOCAL, port: b.port }]))
  return { accepted, dialed }
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out waiting for a condition")
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
})

describe("addressing", () => {
  test("a candidate list survives a round trip", () => {
    const id = nodeIdFor("a")
    const address = formatUdpAddress(id, [
      { host: "203.0.113.7", port: 51820 },
      { host: "192.168.1.9", port: 42001 },
    ])
    const parsed = parseUdpAddress(address)
    expect(parsed?.nodeId).toBe(id)
    expect(parsed?.candidates).toEqual([
      { host: "203.0.113.7", port: 51820 },
      { host: "192.168.1.9", port: 42001 },
    ])
  })

  test("an address without a nodeId is refused", () => {
    // The nodeId is what the Noise claim gets checked against. An address
    // without one would connect to whoever answers, which is the whole thing
    // this transport must not do.
    expect(parseUdpAddress("nex-udp://203.0.113.7:51820")).toBe(null)
    expect(parseUdpAddress("nex-udp://not-a-node-id@203.0.113.7:51820")).toBe(null)
    expect(parseUdpAddress("203.0.113.7:51820")).toBe(null)
  })

  test("a TCP address is not mistaken for a UDP one", () => {
    expect(parseUdpAddress("192.168.1.9:42001")).toBe(null)
  })
})

describe("two nodes forming a union over real sockets", () => {
  test("punch, handshake, authenticate, then chat both ways", async () => {
    const zro = await makeNode("zro", "a")
    const roshan = await makeNode("roshan", "b")

    const { accepted, dialed } = union(zro, roshan)
    const [fromZro, fromRoshan] = await Promise.all([dialed, accepted])

    expect(fromZro.peerId).toBe(roshan.identity.nodeId)
    expect(fromZro.status).toBe("connected")
    expect(fromZro.name).toBe("roshan")
    // First meeting: nothing to compare against yet, and the transport says so
    // rather than implying a verification it did not perform.
    expect(fromZro.identityState).toBe("unknown")
    expect(fromRoshan.peerId).toBe(zro.identity.nodeId)
    expect(fromRoshan.name).toBe("zro")

    await zro.transport.send(roshan.identity.nodeId, "hello from zro")
    await waitFor(() => roshan.messages.length > 0)
    expect(roshan.messages[0]).toEqual({ from: zro.identity.nodeId, content: "hello from zro" })

    await roshan.transport.send(zro.identity.nodeId, "hello back")
    await waitFor(() => zro.messages.length > 0)
    expect(zro.messages[0]).toEqual({ from: roshan.identity.nodeId, content: "hello back" })
  }, 20_000)

  test("the diagnostics report the path in order", async () => {
    const zro = await makeNode("zro", "c")
    const roshan = await makeNode("roshan", "d")
    const { accepted, dialed } = union(zro, roshan)
    await Promise.all([dialed, accepted])

    const order = zro.events.filter((e) => e !== "udp_bound")
    expect(order).toEqual([
      "candidate_selected",
      "punch_start",
      "path_established",
      "reliable_ready",
      "noise_start",
      "noise_authenticated",
      "identity_result",
      "union_formed",
    ])
  }, 20_000)

  test("control ops and latency ride the same session", async () => {
    const zro = await makeNode("zro", "e")
    const roshan = await makeNode("roshan", "f")
    const controls: unknown[] = []
    roshan.transport.onControl((_peer, control) => controls.push(control))

    const { accepted, dialed } = union(zro, roshan)
    await Promise.all([dialed, accepted])

    await zro.transport.sendControl(roshan.identity.nodeId, {
      kind: "retention",
      action: "propose",
      policy: { mode: "keep", days: 7 },
      ts: Date.now(),
    } as never)
    await waitFor(() => controls.length > 0)

    const rtt = await zro.transport.measureLatency(roshan.identity.nodeId)
    expect(rtt).not.toBe(null)
    expect(rtt!).toBeGreaterThanOrEqual(0)
    expect(rtt!).toBeLessThan(2000)
  }, 20_000)

  test("voice frames arrive with their metadata intact", async () => {
    const zro = await makeNode("zro", "1")
    const roshan = await makeNode("roshan", "2")
    const frames: Array<{ seq: number; bytes: number }> = []
    roshan.transport.onVoiceFrame((_from, meta, payload) => frames.push({ seq: meta.seq, bytes: payload.length }))

    const { accepted, dialed } = union(zro, roshan)
    await Promise.all([dialed, accepted])

    zro.transport.sendVoiceFrame(
      roshan.identity.nodeId,
      { roomId: "r1", fromPeerId: zro.identity.nodeId, seq: 7 },
      new Uint8Array(80).fill(9),
    )
    await waitFor(() => frames.length > 0)
    expect(frames[0]).toEqual({ seq: 7, bytes: 80 })
  }, 20_000)
})

describe("who answered", () => {
  test("a peer that is not the expected nodeId is refused, loudly", async () => {
    const zro = await makeNode("zro", "3")
    const roshan = await makeNode("roshan", "4")
    const stranger = nodeIdFor("9")

    // zro asks for `stranger` at an address where roshan is listening. Roshan
    // completes a perfectly valid handshake — and is still the wrong person.
    // Both sides fail here, so both rejections are caught as they are created:
    // an unattached one takes the whole test runner down with it.
    const accepted = roshan.transport.expect(zro.identity.nodeId, [{ host: LOCAL, port: zro.port }]).catch(() => null)
    const dialed = zro.transport.dial(formatUdpAddress(stranger, [{ host: LOCAL, port: roshan.port }]))

    await expect(dialed).rejects.toThrow(/DISCOVERY MISMATCH/)
    await accepted
  }, 20_000)

  test("a second identity at a known nodeId is a mismatch, and the binding is kept", async () => {
    const shared = memoryBindings()
    const zroId: NodeIdentity = { nodeId: nodeIdFor("5"), name: "zro", createdAt: Date.now() }
    const roshanId: NodeIdentity = { nodeId: nodeIdFor("6"), name: "roshan", createdAt: Date.now() }

    const zro = new UdpTransport({ identityPrivHex: hex(x25519.utils.randomSecretKey()), bindings: shared.api })
    const zroPort = await zro.start({ port: 0, identity: zroId })
    running.push(zro)

    const first = new UdpTransport({ identityPrivHex: hex(x25519.utils.randomSecretKey()), bindings: memoryBindings().api })
    const firstPort = await first.start({ port: 0, identity: roshanId })
    running.push(first)

    const acceptedFirst = first.expect(zroId.nodeId, [{ host: LOCAL, port: zroPort }]).catch(() => null)
    await Promise.all([
      zro.dial(formatUdpAddress(roshanId.nodeId, [{ host: LOCAL, port: firstPort }])),
      acceptedFirst,
    ])
    const remembered = shared.map.get(roshanId.nodeId)!.staticKey
    expect(remembered).toBeTruthy()
    await zro.drop(roshanId.nodeId)
    await first.stop()

    // Same nodeId, different key. This is the substitution TOFU exists for.
    const impostor = new UdpTransport({
      identityPrivHex: hex(x25519.utils.randomSecretKey()),
      bindings: memoryBindings().api,
    })
    const impostorPort = await impostor.start({ port: 0, identity: roshanId })
    running.push(impostor)

    const acceptedImpostor = impostor.expect(zroId.nodeId, [{ host: LOCAL, port: zroPort }]).catch(() => null)
    let refusal = ""
    try {
      await zro.dial(formatUdpAddress(roshanId.nodeId, [{ host: LOCAL, port: impostorPort }]))
    } catch (err) {
      refusal = (err as Error).message
    }
    expect(refusal).toMatch(/identity mismatch/)
    await acceptedImpostor
    // The impostor must not have been able to overwrite the record by showing
    // up loudly — the original binding is still what we remember.
    expect(shared.map.get(roshanId.nodeId)!.staticKey).toBe(remembered)
  }, 30_000)
})

describe("limits", () => {
  test("a message too large for one datagram fails instead of being cut in half", async () => {
    const zro = await makeNode("zro", "7")
    const roshan = await makeNode("roshan", "8")
    const { accepted, dialed } = union(zro, roshan)
    await Promise.all([dialed, accepted])

    // There is no fragmentation under this by decision: a fragmented datagram
    // is lost whole when any fragment is. So the limit is real and it is loud.
    await expect(zro.transport.send(roshan.identity.nodeId, "x".repeat(MAX_OP_PLAINTEXT))).rejects.toThrow(
      /message too large/,
    )
    await zro.transport.send(roshan.identity.nodeId, "x".repeat(MAX_OP_PLAINTEXT - 1))
    await waitFor(() => roshan.messages.length > 0)
  }, 20_000)

  test("sending before a union exists is refused", async () => {
    const zro = await makeNode("zro", "0")
    await expect(zro.transport.send(nodeIdFor("f"), "hello")).rejects.toThrow(/not connected/)
  })

  test("without an identity key nothing is dialled at all", async () => {
    const blind = new UdpTransport({})
    await blind.start({ port: 0, identity: { nodeId: nodeIdFor("d"), name: "blind", createdAt: Date.now() } })
    running.push(blind)
    await expect(blind.dial(formatUdpAddress(nodeIdFor("e"), [{ host: LOCAL, port: 1 }]))).rejects.toThrow(
      /no transport identity key/,
    )
  })
})
