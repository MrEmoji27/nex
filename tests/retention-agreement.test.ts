// Retention-agreement protocol: pure machine semantics + two-node flows over
// the encrypted transport (propose / ack / reject / announce).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PeerRetentionState } from "../src/core/contract.ts"
import {
  acceptRemoteProposal,
  onLocalPolicyChange,
  onRemoteAnswer,
  onRemotePropose,
  onRemoteState,
  rejectRemoteProposal,
} from "../src/core/retention-agreement"
import {
  effectiveRetention,
  retentionLooseness,
  tighterRetention,
} from "../src/core/contract"
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

// ---------- ordering helpers ----------

describe("policy ordering", () => {
  test("looseness ranks 24h < 7d < forever", () => {
    expect(retentionLooseness("24h")).toBeLessThan(retentionLooseness("7d"))
    expect(retentionLooseness("7d")).toBeLessThan(retentionLooseness("forever"))
  })

  test("tighter picks the sooner-expiring policy", () => {
    expect(tighterRetention("24h", "forever")).toBe("24h")
    expect(tighterRetention("forever", "7d")).toBe("7d")
    expect(tighterRetention("7d", "7d")).toBe("7d")
  })

  test("effective is min(mine, theirs); mine alone when theirs unknown", () => {
    expect(effectiveRetention("7d", "24h")).toBe("24h")
    expect(effectiveRetention("24h", "forever")).toBe("24h")
    expect(effectiveRetention("forever", undefined)).toBe("forever")
  })
})

// ---------- machine transitions ----------

describe("agreement machine", () => {
  test("tightening announces without consent flow", () => {
    const out = onLocalPolicyChange(undefined, "forever", "24h")
    expect(out.next.pendingOut).toBeUndefined()
    expect(out.reply?.action).toBe("state")
    expect(out.reply?.policy).toBe("24h")
  })

  test("raising marks pendingOut and proposes", () => {
    const out = onLocalPolicyChange(undefined, "24h", "forever")
    expect(out.next.pendingOut).toBe("forever")
    expect(out.reply?.action).toBe("propose")
    expect(out.notice).toContain("waiting")
  })

  test("remote announcement satisfying our pending raise clears it", () => {
    const raised = onLocalPolicyChange(undefined, "24h", "7d").next
    const settled = onRemoteState(raised, "7d")
    expect(settled.next.pendingOut).toBeUndefined()
    expect(settled.next.theirs).toBe("7d")
  })

  test("proposal within our own policy auto-acks and converges", () => {
    const out = onRemotePropose(undefined, "7d", "24h")
    expect(out.reply?.action).toBe("ack")
    expect(out.next.theirs).toBe("24h")
    expect(out.next.agreedAt).toBeGreaterThan(0)
    expect(out.next.pendingIn).toBeUndefined()
  })

  test("proposal beyond our policy parks as pendingIn without replying", () => {
    const out = onRemotePropose(undefined, "24h", "forever")
    expect(out.reply).toBeUndefined()
    expect(out.next.pendingIn).toBe("forever")
  })

  test("accept converges: theirs set, pending cleared, ack sent", () => {
    const parked = onRemotePropose(undefined, "24h", "7d").next
    const out = acceptRemoteProposal(parked)
    expect(out.reply?.action).toBe("ack")
    expect(out.reply?.policy).toBe("7d")
    expect(out.next.theirs).toBe("7d")
    expect(out.next.pendingIn).toBeUndefined()
    expect(out.next.lastAction).toBe("ack")
  })

  test("reject keeps ours authoritative and records disagreement", () => {
    const parked = onRemotePropose({ theirs: "24h" }, "24h", "forever").next
    const out = rejectRemoteProposal(parked)
    expect(out.reply?.action).toBe("reject")
    expect(out.next.theirs).toBe("24h")
    expect(out.next.pendingIn).toBeUndefined()
    expect(out.next.lastAction).toBe("reject")
  })

  test("remote answers resolve our pendingOut either way", () => {
    const raised = onLocalPolicyChange(undefined, "24h", "forever").next
    const acked = onRemoteAnswer(raised, "ack", "forever")
    expect(acked.next.pendingOut).toBeUndefined()
    expect(acked.next.lastAction).toBe("ack")
    const rejected = onRemoteAnswer({ ...raised }, "reject", "forever")
    expect(rejected.next.pendingOut).toBeUndefined()
    expect(rejected.next.lastAction).toBe("reject")
  })
})

// ---------- two-node integration over real TCP ----------

const dataDirs: string[] = []
const nodes: NexAppImpl[] = []

async function startNode(name: string): Promise<{ app: NexAppImpl; port: number }> {
  const dir = await mkdtemp(join(tmpdir(), "nex-retain-"))
  dataDirs.push(dir)
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
    settings: undefined,
    retentionStore: new FileRetentionStore(join(dir, "agreements.json")),
    transport,
  })
  await app.start()
  nodes.push(app)
  if (!transport.port) throw new Error("no bound port")
  return { app, port: transport.port }
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(40)
  }
  throw new Error("condition not met in time")
}

function agreementOf(app: NexAppImpl, peerId: string): PeerRetentionState | null {
  return app.getRetentionAgreement(peerId)
}

afterEach(async () => {
  for (const app of nodes.splice(0)) await app.shutdown().catch(() => {})
})

afterAll(async () => {
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

describe("retention agreements between two live nodes", () => {
  test("raise within peer policy auto-acks; both sides converge", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    // A loosens forever->7d? No: default forever -> 7d is TIGHTENING (announce).
    await a.app.setRetention("7d")
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.theirs === "7d")

    // Now A raises 7d -> forever: B (still forever) meets it, auto-acks.
    await a.app.setRetention("forever")
    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.lastAction === "ack")
    const aSide = agreementOf(a.app, b.app.identity.nodeId)
    expect(aSide?.pendingOut).toBeUndefined()

    // B learned A's standing policy via the propose/state ops.
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.theirs === "forever")
  })

  test("raise beyond peer policy waits; rejection keeps disagreement visible", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    // B tightens to 24h; A learns theirs=24h via announcement.
    await b.app.setRetention("24h")
    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.theirs === "24h")

    // B loosens to 7d: a raise, but A(forever) meets it -> auto-ack by A.
    await b.app.setRetention("7d")
    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.theirs === "7d")

    // Real explicit-reject scenario: park a proposal on B that exceeds B's own policy.
    // Drive the wire directly through A's transport-level propose by tightening then raising:
    await a.app.setRetention("24h") // A tightens (announce)
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.theirs === "24h")
    await a.app.setRetention("forever") // A raises: B(7d) cannot auto-ack forever -> pendingIn on B
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.pendingIn === "forever")

    // Before answering, B's view of A stays 24h (announcement truth).
    expect(agreementOf(b.app, a.app.identity.nodeId)?.theirs).toBe("24h")

    // B rejects.
    await b.app.respondRetentionProposal(a.app.identity.nodeId, false)
    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.lastAction === "reject")
    const bSide = agreementOf(b.app, a.app.identity.nodeId)
    expect(bSide?.pendingIn).toBeUndefined()
    expect(bSide?.lastAction).toBe("reject")
    expect(bSide?.theirs).toBe("24h")
  })

  test("acceptance converges the shared window on both sides", async () => {
    const a = await startNode("alpha")
    const b = await startNode("bravo")
    await a.app.connectTo(`127.0.0.1:${b.port}`)

    await b.app.setRetention("24h")
    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.theirs === "24h")
    await a.app.setRetention("24h") // align down first (pure announce)
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.theirs === "24h")

    // A raises to 7d; B accepts explicitly.
    await a.app.setRetention("7d")
    await waitFor(() => agreementOf(b.app, a.app.identity.nodeId)?.pendingIn === "7d")
    await b.app.respondRetentionProposal(a.app.identity.nodeId, true)

    await waitFor(() => agreementOf(a.app, b.app.identity.nodeId)?.lastAction === "ack")
    expect(agreementOf(a.app, b.app.identity.nodeId)?.agreedAt).toBeGreaterThan(0)
    const bSide = agreementOf(b.app, a.app.identity.nodeId)
    expect(bSide?.theirs).toBe("7d")
    expect(bSide?.lastAction).toBe("ack")
  })
})
