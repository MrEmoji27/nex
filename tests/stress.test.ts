// Stress + robustness pass. Not part of the default suite rhythm (slower):
//   bun test tests/stress.test.ts
// Hammers transport ordering/volume, frame limits, reconnect churn, a 3-node
// mesh, agreement-machine flapping, and vault robustness/performance.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeIdentity } from "../src/core/contract.ts"
import {
  FileIdentityStore,
  generateIdentity,
  generateNoiseStaticKey,
  ensureNoiseStaticKey,
} from "../src/core/identity"
import { FileConversationStore, FilePeerRegistryStore, FileStaticKeyStore } from "../src/core/state/persistence"
import { FileRetentionStore } from "../src/core/state/retention"
import { NexAppImpl } from "../src/core/app"
import { EncryptedTcpTransport } from "../src/network/tcp/encrypted-tcp-transport"
import { openVaultKey } from "../src/core/state/vault"
import { VaultConversationStore } from "../src/core/state/encrypted-stores"

const dirs: string[] = []
const nodes: NexAppImpl[] = []
let portSeq = 43100

function nextPort(): number {
  return ++portSeq
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `nex-stress-${prefix}-`))
  dirs.push(dir)
  return dir
}

async function makeNode(name: string): Promise<{ app: NexAppImpl; port: number; dir: string }> {
  const dir = await tempDir(name)
  const identityStore = new FileIdentityStore(join(dir, "identity.json"))
  let secret = await identityStore.loadSecret()
  let identity = await identityStore.load()
  if (!identity || !secret) {
    const generated = generateIdentity()
    await identityStore.save({ ...generated.identity, name }, generated.secret)
    identity = { ...generated.identity, name }
    secret = generated.secret
  }
  secret = await ensureNoiseStaticKey(identityStore, identity, secret)
  const transport = new EncryptedTcpTransport({
    identityPrivHex: secret.identityPrivHex!,
    bindings: new FileStaticKeyStore(join(dir, "identities.json")),
  })
  const app = new NexAppImpl({
    identityStore,
    conversations: new FileConversationStore(join(dir, "conversations")),
    registry: new FilePeerRegistryStore(join(dir, "peers.json")),
    retentionStore: new FileRetentionStore(join(dir, "agreements.json")),
    transport,
    port: nextPort(),
  })
  await app.start()
  nodes.push(app)
  if (!transport.port) throw new Error("no bound port")
  return { app, port: transport.port, dir }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms = 8000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(`timeout: ${what}`)
}

afterEach(async () => {
  for (const app of nodes.splice(0)) await app.shutdown().catch(() => {})
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

// ---------- transport volume & ordering ----------

describe("transport under load", () => {
  test("300 back-to-back messages arrive in order, both directions", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    const gotB: string[] = []
    const gotA: string[] = []

    // Drive raw transports for exact-order assertions without app-side reloads.
    // (apps stay connected underneath; we only listen)
    const ta = (a.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    const tb = (b.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    tb.onMessage((_id, content) => gotB.push(content))
    ta.onMessage((_id, content) => gotA.push(content))

    const N = 300
    for (let i = 0; i < N; i++) await ta.send(b.app.identity.nodeId, `a${i}`)
    for (let i = 0; i < N; i++) await tb.send(a.app.identity.nodeId, `b${i}`)

    await waitFor(() => gotB.length >= N && gotA.length >= N, 15000, "flood delivery")
    expect(gotB.length).toBe(N)
    expect(gotA.length).toBe(N)
    expect(gotB.every((c, i) => c === `a${i}`)).toBe(true)
    expect(gotA.every((c, i) => c === `b${i}`)).toBe(true)

    // Link still healthy afterwards.
    const rtt = await ta.measureLatency(b.app.identity.nodeId)
    expect(rtt).not.toBeNull()
  }, 30000)

  test("frame boundary: max-size message delivers byte-exact", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    const ta = (a.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    const tb = (b.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport

    // Wire budget: [len u16][op u8][payload][16B tag] must fit 65_535 total.
    const budget = 65_535 - 2 - 1 - 16
    const payload = "é" + "z".repeat(budget - 5) + "✓" // 2 + (budget-5) + 3 = budget
    expect(new TextEncoder().encode(payload).length).toBe(budget)

    const got: string[] = []
    tb.onMessage((_id, content) => got.push(content))
    await ta.send(b.app.identity.nodeId, payload)
    await waitFor(() => got.length > 0, 5000, "boundary delivery")
    expect(got[0]).toBe(payload)

    // One byte over the budget must fail BEFORE touching the cipher.
    expect(ta.send(b.app.identity.nodeId, "z".repeat(budget + 1))).rejects.toThrow(/too large/)
    const after: string[] = []
    tb.onMessage((_id, content) => after.push(content))
    await ta.send(b.app.identity.nodeId, "post-boundary")
    await waitFor(() => after.includes("post-boundary"), 5000, "link alive after rejection")
  })

  test("oversized frame fails the SEND only; link survives", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)
    const ta = (a.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport

    const huge = "x".repeat(70_000) // > u16 frame budget
    expect(ta.send(b.app.identity.nodeId, huge)).rejects.toThrow()

    // App-level path marks failed instead of throwing.
    const failed = await a.app.sendMessage(b.app.identity.nodeId, huge)
    expect(failed.state).toBe("failed")

    // Small traffic still flows on the same link.
    const got: string[] = []
    const tb = (b.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    tb.onMessage((_id, content) => got.push(content))
    await ta.send(b.app.identity.nodeId, "still alive")
    await waitFor(() => got.includes("still alive"), 5000, "post-oversize delivery")
  })

  test("reconnect churn x6 keeps identity continuity and delivery", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")

    for (let round = 0; round < 6; round++) {
      const peer = await a.app.connectTo(`127.0.0.1:${b.port}`)
      expect(peer.status).toBe("connected")
      if (round > 0) expect(peer.identityState).toBe("identified")
      const got: string[] = []
      const tb = (b.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
      tb.onMessage((_id, content) => got.push(content))
      const ta = (a.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
      await ta.send(b.app.identity.nodeId, `round-${round}`)
      await waitFor(() => got.includes(`round-${round}`), 5000, `round ${round} delivery`)
      await a.app.disconnect(b.app.identity.nodeId)
    }
  }, 30000)

  test("3-node star mesh: concurrent cross traffic", async () => {
    const hub = await makeNode("hub")
    const left = await makeNode("left")
    const right = await makeNode("right")
    await left.app.connectTo(`127.0.0.1:${hub.port}`)
    await right.app.connectTo(`127.0.0.1:${hub.port}`)

    const thub = (hub.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    const tleft = (left.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport
    const tright = (right.app as unknown as { options: { transport: EncryptedTcpTransport } }).options.transport

    const atHub: string[] = []
    thub.onMessage((peerId, content) => atHub.push(`${peerId.slice(0, 4)}:${content}`))

    const sends: Promise<void>[] = []
    for (let i = 0; i < 50; i++) {
      sends.push(tleft.send(hub.app.identity.nodeId, `L${i}`))
      sends.push(tright.send(hub.app.identity.nodeId, `R${i}`))
    }
    await Promise.allSettled(sends)
    await waitFor(() => atHub.length >= 100, 15000, "mesh flood")

    const fromLeft = atHub.filter((c) => c.startsWith("L") || c.split(":")[1]!.startsWith("L")).length
    expect(fromLeft).toBe(50)
    expect(atHub.filter((c) => c.endsWith(`R49`))).toHaveLength(1)
  }, 30000)
})

// ---------- agreement machine under stress ----------

describe("retention agreements under stress", () => {
  test("rapid policy flapping converges to last announced value", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    const sequence = ["24h", "7d", "24h", "7d", "forever", "24h", "forever"] as const
    for (const policy of sequence) {
      await a.app.setRetention(policy)
      await Bun.sleep(30)
    }
    await Bun.sleep(250)

    const bSide = b.app.getRetentionAgreement(a.app.identity.nodeId)
    expect(bSide?.theirs).toBe("forever")
    // No stray pendings anywhere.
    expect(bSide?.pendingIn).toBeUndefined()
    const aSide = a.app.getRetentionAgreement(b.app.identity.nodeId)
    expect(aSide?.pendingOut).toBeUndefined()

    // Persistence parity across restart is covered elsewhere; here assert store readable.
    expect(a.app.getSettings().retention).toBe("forever")
  })

  test("double answer rejects cleanly; unknown peer returns null", async () => {
    const a = await makeNode("alpha")
    const b = await makeNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    // Both sides align to 24h first so A's next move is a genuine RAISE.
    await b.app.setRetention("24h")
    await waitFor(() => a.app.getRetentionAgreement(b.app.identity.nodeId)?.theirs === "24h", 5000, "a learns 24h")
    await a.app.setRetention("24h")
    await waitFor(() => b.app.getRetentionAgreement(a.app.identity.nodeId)?.theirs === "24h", 5000, "b learns 24h")

    await a.app.setRetention("7d") // raise past B's 24h -> pendingIn on B
    await waitFor(() => b.app.getRetentionAgreement(a.app.identity.nodeId)?.pendingIn === "7d", 5000, "pending on b")

    await b.app.respondRetentionProposal(a.app.identity.nodeId, true)
    expect(b.app.respondRetentionProposal(a.app.identity.nodeId, true)).rejects.toThrow(/no pending/)
    expect(a.app.respondRetentionProposal(b.app.identity.nodeId, true)).rejects.toThrow(/no pending/)
    expect(a.app.getRetentionAgreement("nonexistent-peer")).toBeNull()
  })
})

// ---------- vault robustness ----------

describe("vault robustness", () => {
  test("corrupted envelope loads empty without crashing the store", async () => {
    const dir = await tempDir("vault-corrupt")
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"))
    const store = new VaultConversationStore(vault, dir)

    await store.append("PEER1", {
      id: "m1",
      direction: "in",
      content: "survive me",
      sentAt: Date.now(),
      state: "sent",
    })

    // Flip bytes in the envelope body -> AEAD must reject -> graceful empty.
    const logical = join(dir, "conversations/PEER1.vault")
    const raw = await readFile(logical)
    raw[raw.length - 5] = raw[raw.length - 5]! ^ 0xff
    await writeFile(logical, raw)

    const loaded = await store.loadAll("PEER1")
    expect(loaded).toEqual([])

    // Store remains writable after corruption.
    await store.append("PEER1", {
      id: "m2",
      direction: "out",
      content: "write after corrupt",
      sentAt: Date.now(),
      state: "sent",
    })
    expect(await store.loadAll("PEER1")).toHaveLength(1)
  })

  test("vault append/load performance at human-chat scale (informational)", async () => {
    const dir = await tempDir("vault-perf")
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"))
    const store = new VaultConversationStore(vault, dir)

    const N = 400
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      await store.append("PEERPERF", {
        id: `m${i}`,
        direction: i % 2 ? "out" : "in",
        content: `message body ${i} with some realistic length padding`,
        sentAt: Date.now(),
        state: "sent",
      })
    }
    const appendMs = performance.now() - t0

    const t1 = performance.now()
    const all = await store.loadAll("PEERPERF")
    const loadMs = performance.now() - t1

    expect(all).toHaveLength(N)
    console.log(`[perf] ${N} encrypted appends: ${appendMs.toFixed(0)}ms (${(appendMs / N).toFixed(2)}ms/msg), loadAll: ${loadMs.toFixed(0)}ms`)
  }, 30000)
})
