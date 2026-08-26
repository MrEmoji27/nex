// Worker A owns this file: Bun tests for TCP transport + app wiring per .workers/worker-a.md
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppEvent, PeerInfo } from "../src/core/contract.ts"
import { FileIdentityStore, generateIdentity, sha256HexUpper, hexToBytes } from "../src/core/identity"
import { FileConversationStore, FilePeerRegistryStore, FileAttestationStore } from "../src/core/state/persistence"
import { NexAppImpl } from "../src/core/app"
import { TcpTransport } from "../src/network/tcp/tcp-transport"

const dataDirs: string[] = []
const nodes: NexAppImpl[] = []
const afterEachCleanup: Array<() => unknown> = []

function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nex-test-")).then((dir) => {
    dataDirs.push(dir)
    return dir
  })
}

interface TestNode {
  app: NexAppImpl
  transport: TcpTransport
  port: number
  /** Data dir backing this node (identity/attestations/registry files). */
  dir: string
}

/** Start a node with its own temp data dir and a stable display name. */
async function startNode(name: string, port?: number): Promise<TestNode> {
  const dir = await makeDataDir()
  const identityStore = new FileIdentityStore(join(dir, "identity.json"))
  // Pre-seed so the test controls the displayed name (exercises the load path).
  const existing = await identityStore.load()
  let secret = await identityStore.loadSecret()
  if (!existing || !secret) {
    const generated = generateIdentity()
    await identityStore.save({ ...generated.identity, name }, generated.secret)
    secret = generated.secret
  }
  const transport = new TcpTransport({
    seedHex: secret!.seedHex,
    attestations: new FileAttestationStore(join(dir, "attestations.json")),
  })
  const app = new NexAppImpl({
    identityStore,
    conversations: new FileConversationStore(join(dir, "conversations")),
    registry: new FilePeerRegistryStore(join(dir, "peers.json")),
    transport,
    port,
  })
  await app.start()
  nodes.push(app)
  const bound = transport.port
  if (!bound) throw new Error("transport did not report a bound port")
  return { app, transport, port: bound, dir }
}

afterEach(async () => {
  for (const app of nodes.splice(0)) {
    await app.shutdown().catch(() => {})
  }
  for (const cleanup of afterEachCleanup.splice(0)) {
    await cleanup()
  }
})

afterAll(async () => {
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

describe("TcpTransport handshake", () => {
  test("dial resolves with identified peer; listener sees connected status", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")

    const statusesB: PeerInfo[] = []
    b.app.emit((event) => {
      if (event.type === "peerChanged") statusesB.push(event.peer)
    })

    const peer = await a.app.connectTo(`127.0.0.1:${b.port}`)

    expect(peer.peerId).toBe(b.app.identity.nodeId)
    expect(peer.name).toBe("bravo")
    expect(peer.status).toBe("connected")

    await waitFor(() =>
      statusesB.some((p) => p.peerId === a.app.identity.nodeId && p.status === "connected"),
    )
    const seenFromB = statusesB.find((p) => p.peerId === a.app.identity.nodeId)
    expect(seenFromB?.name).toBe("alpha")
  })

  test("transport falls back through ports when default is taken", async () => {
    const a = await startNode("first")
    const b = await startNode("second")
    expect(b.port).toBeGreaterThan(a.port)
  })
})

describe("TcpTransport messaging", () => {
  test("messages flow both directions", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    const inboundAtB: Array<{ peerId: string; content: string }> = []
    b.transport.onMessage((peerId, content) => inboundAtB.push({ peerId, content }))
    const inboundAtA: Array<{ peerId: string; content: string }> = []
    a.transport.onMessage((peerId, content) => inboundAtA.push({ peerId, content }))

    const sentA = await a.app.sendMessage(b.app.identity.nodeId, "hello from alpha")
    expect(sentA.state).toBe("sent")

    await waitFor(() => inboundAtB.length >= 1)
    expect(inboundAtB[0]?.content).toBe("hello from alpha")
    expect(inboundAtB[0]?.peerId).toBe(a.app.identity.nodeId)

    const sentB = await b.app.sendMessage(a.app.identity.nodeId, "hello from bravo")
    expect(sentB.state).toBe("sent")
    await waitFor(() => inboundAtA.length >= 1)
    expect(inboundAtA[0]?.content).toBe("hello from bravo")
    expect(inboundAtA[0]?.peerId).toBe(b.app.identity.nodeId)
  })

  test("outbound message to unknown peer fails cleanly", async () => {
    const a = await startNode("alpha")
    const message = await a.app.sendMessage("no-such-peer", "ghost message")
    expect(message.state).toBe("failed")
  })

  test("ping/pong resolves a real round-trip measurement", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    const rtt = await a.transport.measureLatency(b.app.identity.nodeId)
    expect(rtt).not.toBeNull()
    expect(rtt as number).toBeGreaterThanOrEqual(0)
  })

  test("measureLatency resolves null for unconnected peers", async () => {
    const a = await startNode("alpha")
    expect(await a.transport.measureLatency("no-such-peer")).toBeNull()
  })
})

describe("trust and latency events", () => {
  test("app.pingPeer measures rtt and emits a latency event", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    const events: AppEvent[] = []
    a.app.emit((event) => events.push(event))

    const rtt = await a.app.pingPeer(b.app.identity.nodeId)
    expect(rtt).not.toBeNull()
    expect(rtt as number).toBeGreaterThanOrEqual(0)
    expect(
      events.some((e) => e.type === "latency" && e.peerId === b.app.identity.nodeId),
    ).toBe(true)
    expect(
      events.some((e) => e.type === "peerChanged" && e.peer.latencyMs != null),
    ).toBe(true)
  })

  test("setTrust rejects unknown peers", async () => {
    const a = await startNode("alpha")
    expect(a.app.setTrust("no-such-peer", true)).rejects.toThrow()
  })

  test("trust decision persists across app restart", async () => {
    const dir = await makeDataDir()
    const wire = async (): Promise<{ app: NexAppImpl; transport: TcpTransport }> => {
      const identityStore = new FileIdentityStore(join(dir, "identity.json"))
      let secret = await identityStore.loadSecret()
      if (!secret) {
        const generated = generateIdentity()
        await identityStore.save(generated.identity, generated.secret)
        secret = generated.secret
      }
      const transport = new TcpTransport({
        seedHex: secret!.seedHex,
        attestations: new FileAttestationStore(join(dir, "attestations.json")),
      })
      const app = new NexAppImpl({
        identityStore,
        conversations: new FileConversationStore(join(dir, "conversations")),
        registry: new FilePeerRegistryStore(join(dir, "peers.json")),
        transport,
      })
      await app.start()
      nodes.push(app)
      return { app, transport }
    }

    const first = await wire()
    const remote = await startNode("remote")
    await remote.app.connectTo(`127.0.0.1:${first.transport.port}`)
    await waitFor(async () => (await first.app.listPeers()).length > 0)
    await first.app.setTrust(remote.app.identity.nodeId, false)

    const second = await wire()
    const known = (await second.app.listPeers()).find(
      (p) => p.peerId === remote.app.identity.nodeId,
    )
    expect(known?.trusted).toBe(false)
  })
})

describe("persistence across restart", () => {
  test("new app instance sees old conversation, registry, same identity", async () => {
    const dir = await makeDataDir()
    const identityPath = join(dir, "identity.json")

    const buildApp = async (): Promise<{ app: NexAppImpl; transport: TcpTransport }> => {
      const identityStore = new FileIdentityStore(identityPath)
      let secret = await identityStore.loadSecret()
      if (!secret) {
        const generated = generateIdentity()
        await identityStore.save(generated.identity, generated.secret)
        secret = generated.secret
      }
      const transport = new TcpTransport({
        seedHex: secret!.seedHex,
        attestations: new FileAttestationStore(join(dir, "attestations.json")),
      })
      const app = new NexAppImpl({
        identityStore,
        conversations: new FileConversationStore(join(dir, "conversations")),
        registry: new FilePeerRegistryStore(join(dir, "peers.json")),
        transport,
      })
      await app.start()
      nodes.push(app)
      return { app, transport }
    }

    const first = await buildApp()
    const nodeId = first.app.identity.nodeId

    const remote = await startNode("remote")
    await remote.app.connectTo(`127.0.0.1:${first.transport.port}`)
    await remote.app.sendMessage(nodeId, "survive the restart")
    await waitFor(async () => (await first.app.conversation(remote.app.identity.nodeId)).length >= 1)

    await first.app.shutdown()

    const second = await buildApp()
    expect(second.app.identity.nodeId).toBe(nodeId)

    const restored = await second.app.conversation(remote.app.identity.nodeId)
    expect(restored.length).toBe(1)
    expect(restored[0]?.content).toBe("survive the restart")
    expect(restored[0]?.direction).toBe("in")

    const peers = await second.app.listPeers()
    const known = peers.find((p) => p.peerId === remote.app.identity.nodeId)
    expect(known?.name).toBe("remote")
  })

  test("conversation survives restart even without reconnect", async () => {
    const dir = await makeDataDir()
    const conversations = new FileConversationStore(join(dir, "conversations"))
    const nodeId = "a".repeat(64)
    await conversations.append(nodeId, {
      id: "m1",
      direction: "in",
      content: "old message",
      sentAt: 1,
      state: "sent",
    })
    const reloaded = new FileConversationStore(join(dir, "conversations"))
    const messages = await reloaded.loadAll(nodeId)
    expect(messages.length).toBe(1)
    expect(messages[0]?.content).toBe("old message")
  })
})

describe("identity persistence", () => {
  test("generateIdentity derives nodeId as SHA-256 of the seed — secret never in fingerprint", () => {
    const { identity, secret } = generateIdentity()
    expect(identity.nodeId).toMatch(/^[0-9A-F]{64}$/)
    expect(secret.seedHex).toMatch(/^[0-9a-f]{64}$/)
    expect(identity.nodeId).not.toBe(secret.seedHex.toUpperCase())
    expect(identity.nodeId).toBe(sha256HexUpper(hexToBytes(secret.seedHex)))
  })

  test("two generated identities never collide", () => {
    const a = generateIdentity()
    const b = generateIdentity()
    expect(a.identity.nodeId).not.toBe(b.identity.nodeId)
  })

  test("FileIdentityStore round-trips through disk", async () => {
    const dir = await makeDataDir()
    const path = join(dir, "identity.json")
    const writer = new FileIdentityStore(path)
    const generated = generateIdentity()
    await writer.save(generated.identity, generated.secret)

    const reader = new FileIdentityStore(path)
    expect(await reader.load()).toEqual(generated.identity)

    // Missing file -> null, not throw.
    expect(await new FileIdentityStore(join(dir, "missing.json")).load()).toBeNull()
  })
})

// ---------- v1: identity, handshake continuity, reconnect ----------

describe("handshake identity states", () => {
  test("first meeting marks unknown (TOFU); repeat meeting marks identified", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    const addr = `127.0.0.1:${b.port}`

    const first = await a.app.connectTo(addr)
    expect(first.identityState).toBe("unknown")

    await a.app.disconnect(b.app.identity.nodeId)
    const second = await a.app.connectTo(addr)
    expect(second.peerId).toBe(b.app.identity.nodeId)
    expect(second.identityState).toBe("identified")
  })

  test("responder side also reaches identified on repeat meeting", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    // B's view of A flips unknown -> identified once A's proof verifies again.
    await waitFor(async () => {
      const seen = (await b.app.listPeers()).find((p) => p.peerId === a.app.identity.nodeId)
      return seen?.status === "connected" && seen?.identityState === "unknown"
    })
    await b.app.disconnect(a.app.identity.nodeId)
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    await waitFor(async () => {
      const seen = (await b.app.listPeers()).find((p) => p.peerId === a.app.identity.nodeId)
      return seen?.status === "connected" && seen?.identityState === "identified"
    })
  })

  test("wrong-seed impostor claiming a known nodeId -> mismatch, dropped, record kept", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    await a.app.disconnect(b.app.identity.nodeId)

    const events: AppEvent[] = []
    a.app.emit((event) => {
      if (event.type === "peerChanged") events.push(event)
    })

    // Wrong seed, claims bravo's nodeId: verifier continuity check must fail.
    const impostor = new TcpTransport({ seedHex: "ab".repeat(32) })
    await impostor.start({
      port: 42_090,
      identity: { nodeId: b.app.identity.nodeId, name: "fake-bravo", createdAt: Date.now() },
    })
    afterEachCleanup.push(() => void impostor.stop().catch(() => {}))

    await expect(impostor.dial(`127.0.0.1:${a.port}`)).rejects.toThrow()

    await waitFor(() =>
      events.some(
        (e) => e.type === "peerChanged" && e.peer.peerId === b.app.identity.nodeId && e.peer.identityState === "mismatch",
      ),
    )

    // Continuity record survives the failed meeting (per brief: keep the record).
    const record = await new FileAttestationStore(join(a.dir, "attestations.json")).get(
      b.app.identity.nodeId,
    )
    expect(record).not.toBeNull()
    expect(record?.verifier).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("legacy identity migration", () => {
  test("seed-as-nodeId identity migrates: new fingerprint, renamed conversation, cleaned registry", async () => {
    const dir = await makeDataDir()
    const seedHex = "ef".repeat(32)
    const legacyNodeId = seedHex.toUpperCase()
    const newNodeId = sha256HexUpper(hexToBytes(seedHex))
    expect(newNodeId).not.toBe(legacyNodeId)

    await mkdir(join(dir, "conversations"), { recursive: true })
    await writeFile(
      join(dir, "identity.json"),
      JSON.stringify({
        identity: { nodeId: legacyNodeId, name: "legacy-node", createdAt: 1_000 },
        secret: { seedHex },
      }, null, 2) + "\n",
      "utf8",
    )
    await writeFile(
      join(dir, "conversations", `${legacyNodeId}.json`),
      JSON.stringify({ id: "m1", direction: "in", content: "pre-migration", sentAt: 1, state: "sent" }) + "\n",
      "utf8",
    )
    await writeFile(
      join(dir, "peers.json"),
      JSON.stringify([
        { peerId: "F".repeat(64), name: "other", status: "offline" },
        { peerId: legacyNodeId, name: "self-echo", status: "offline" },
      ]) + "\n",
      "utf8",
    )

    const store = new FileIdentityStore(join(dir, "identity.json"))
    const loaded = await store.load()
    expect(loaded?.nodeId).toBe(newNodeId)
    expect(loaded?.name).toBe("legacy-node")

    // Conversation history follows the new fingerprint.
    const conversations = new FileConversationStore(join(dir, "conversations"))
    expect(await conversations.loadAll(newNodeId)).toHaveLength(1)
    let legacyGone = true
    try {
      await readFile(join(dir, "conversations", `${legacyNodeId}.json`), "utf8")
      legacyGone = false
    } catch {
      // Expected: renamed away.
    }
    expect(legacyGone).toBe(true)

    // Registry: our own stale entry removed, remote entries untouched.
    const peers = JSON.parse(await readFile(join(dir, "peers.json"), "utf8")) as PeerInfo[]
    expect(peers.some((p) => p.peerId === legacyNodeId)).toBe(false)
    expect(peers.some((p) => p.peerId === "F".repeat(64))).toBe(true)

    // Idempotent: reloading no longer detects legacy shape.
    const again = await new FileIdentityStore(join(dir, "identity.json")).load()
    expect(again?.nodeId).toBe(newNodeId)
  })

  test("current-shape identities pass through unmigrated", async () => {
    const dir = await makeDataDir()
    const path = join(dir, "identity.json")
    const generated = generateIdentity()
    const store = new FileIdentityStore(path)
    await store.save(generated.identity, generated.secret)
    const loaded = await store.load()
    expect(loaded).toEqual(generated.identity)
  })
})

describe("auto-reconnect", () => {
  test("server drop -> reconnecting -> restart -> connected again", async () => {
    const PORT = 42_777
    const bDir = await makeDataDir()

    const wireBravo = async (): Promise<TestNode> => {
      const identityStore = new FileIdentityStore(join(bDir, "identity.json"))
      let secret = await identityStore.loadSecret()
      if (!secret) {
        const generated = generateIdentity()
        await identityStore.save({ ...generated.identity, name: "bravo" }, generated.secret)
        secret = generated.secret
      }
      const transport = new TcpTransport({
        seedHex: secret!.seedHex,
        attestations: new FileAttestationStore(join(bDir, "attestations.json")),
      })
      const app = new NexAppImpl({
        identityStore,
        conversations: new FileConversationStore(join(bDir, "conversations")),
        registry: new FilePeerRegistryStore(join(bDir, "peers.json")),
        transport,
        port: PORT,
      })
      await app.start()
      nodes.push(app)
      return { app, transport, port: transport.port!, dir: bDir }
    }

    const a = await startNode("alpha")
    const b = await wireBravo()
    expect(b.port).toBe(PORT)

    const events: PeerInfo[] = []
    a.app.emit((event) => {
      if (event.type === "peerChanged") events.push(event.peer)
    })

    await a.app.connectTo(`127.0.0.1:${PORT}`)
    await b.app.shutdown()

    await waitFor(() => events.some((p) => p.status === "reconnecting"))
    expect(a.transport.pendingReconnectCount).toBe(1)
    expect(a.transport.reconnectingPeerIds).toContain(b.app.identity.nodeId)

    const revived = await wireBravo()
    expect(revived.port).toBe(PORT)

    await waitFor(() => {
      const latest = [...events]
        .reverse()
        .find((p) => p.peerId === b.app.identity.nodeId)
      return latest?.status === "connected"
    })
    await waitFor(() => a.transport.pendingReconnectCount === 0)

    // Re-handshake after reconnect proves identity again.
    await waitFor(async () => {
      const peer = (await a.app.listPeers()).find((p) => p.peerId === b.app.identity.nodeId)
      return peer?.identityState === "identified"
    })
  })

  test("drop() cancels the reconnect loop and leaves no timers", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    const addr = `127.0.0.1:${b.port}`
    await a.app.connectTo(addr)
    await b.app.shutdown()

    await waitFor(() => a.transport.pendingReconnectCount === 1)
    await a.app.disconnect(b.app.identity.nodeId)
    expect(a.transport.pendingReconnectCount).toBe(0)

    const peer = (await a.app.listPeers()).find((p) => p.peerId === b.app.identity.nodeId)
    expect(peer?.status).toBe("offline")
  })

  test("shutdown cancels all reconnect timers (no leaks)", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    await b.app.shutdown()
    await waitFor(() => a.transport.pendingReconnectCount === 1)

    await a.app.shutdown()
    expect(a.transport.pendingReconnectCount).toBe(0)
    expect(a.transport.reconnectingPeerIds).toHaveLength(0)
  })

  test("intentional drop never schedules a reconnect", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    await a.app.disconnect(b.app.identity.nodeId)
    expect(a.transport.pendingReconnectCount).toBe(0)
    await Bun.sleep(50)
    expect(a.transport.pendingReconnectCount).toBe(0)
  })
})

describe("v1 contact fields persist", () => {
  test("setVerified + renameContact survive an app restart", async () => {
    const dir = await makeDataDir()
    const wire = async (): Promise<{ app: NexAppImpl; transport: TcpTransport }> => {
      const identityStore = new FileIdentityStore(join(dir, "identity.json"))
      let secret = await identityStore.loadSecret()
      if (!secret) {
        const generated = generateIdentity()
        await identityStore.save(generated.identity, generated.secret)
        secret = generated.secret
      }
      const transport = new TcpTransport({
        seedHex: secret!.seedHex,
        attestations: new FileAttestationStore(join(dir, "attestations.json")),
      })
      const app = new NexAppImpl({
        identityStore,
        conversations: new FileConversationStore(join(dir, "conversations")),
        registry: new FilePeerRegistryStore(join(dir, "peers.json")),
        transport,
      })
      await app.start()
      nodes.push(app)
      return { app, transport }
    }

    const first = await wire()
    const remote = await startNode("remote")
    await remote.app.connectTo(`127.0.0.1:${first.transport.port!}`)
    await waitFor(async () => (await first.app.listPeers()).length > 0)

    await first.app.setVerified(remote.app.identity.nodeId, true)
    await first.app.renameContact(remote.app.identity.nodeId, "Zro")
    await first.app.shutdown()

    const second = await wire()
    const known = (await second.app.listPeers()).find((p) => p.peerId === remote.app.identity.nodeId)
    expect(known?.verified).toBe(true)
    expect(known?.trusted).toBe(true)
    expect(known?.displayName).toBe("Zro")
  })

  test("mock dial reports identified scripted peers (UI contract)", async () => {
    const { createMockApp } = await import("../src/network/mock-transport")
    const app = await createMockApp()
    const peers = await app.listPeers()
    const echo = peers.find((p) => p.name === "echo")
    expect(echo?.identityState).toBe("identified")
    await app.shutdown()
  })
})

// ---------- helpers ----------

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(25)
  }
  throw new Error("waitFor timed out")
}
