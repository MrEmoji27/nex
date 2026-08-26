// Identity pinning on the two "first contact" paths: nex:// invites and
// LAN/intro discovery.
//
// Both paths hand you an address AND the identity you are supposed to find
// there. The address is attacker-influenced (a beacon is unauthenticated UDP;
// an invite code can be edited in transit), so whoever actually answers must
// be checked against the promised fingerprint before anything else happens.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DiscoveredPeer } from "../src/core/contract.ts"
import { decodeInvite } from "../src/core/discovery"
import { FileIdentityStore, generateIdentity, ensureNoiseStaticKey } from "../src/core/identity"
import { FileConversationStore, FilePeerRegistryStore, FileStaticKeyStore } from "../src/core/state/persistence"
import { NexAppImpl, splitHostPort } from "../src/core/app"
import { EncryptedTcpTransport } from "../src/network/tcp/encrypted-tcp-transport"

const dataDirs: string[] = []
const nodes: NexAppImpl[] = []

interface TestNode {
  app: NexAppImpl
  port: number
}

async function startNode(name: string): Promise<TestNode> {
  const dir = await mkdtemp(join(tmpdir(), "nex-pin-test-"))
  dataDirs.push(dir)
  const identityStore = new FileIdentityStore(join(dir, "identity.json"))
  const generated = generateIdentity()
  await identityStore.save({ ...generated.identity, name }, generated.secret)
  const identity = { ...generated.identity, name }
  const secret = await ensureNoiseStaticKey(identityStore, identity, generated.secret)

  const transport = new EncryptedTcpTransport({
    identityPrivHex: secret.identityPrivHex!,
    bindings: new FileStaticKeyStore(join(dir, "identities.json")),
  })
  const app = new NexAppImpl({
    identityStore,
    conversations: new FileConversationStore(join(dir, "conversations")),
    registry: new FilePeerRegistryStore(join(dir, "peers.json")),
    transport,
  })
  await app.start()
  nodes.push(app)
  if (!transport.port) throw new Error("no bound port")
  return { app, port: transport.port }
}

afterEach(async () => {
  for (const app of nodes.splice(0)) await app.shutdown().catch(() => {})
})

afterAll(async () => {
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

/** Flip the fingerprint in a nex:// code, leaving the address intact. */
function repointFingerprint(code: string, fp: string): string {
  return code.replace(/\/fp=[A-Fa-f0-9]+/, `/fp=${fp}`)
}

describe("nex:// invite fingerprint pinning", () => {
  test("a good invite connects and applies the inviter's name", async () => {
    const inviter = await startNode("roshan")
    const guest = await startNode("zro")

    const code = await inviter.app.createInvite(`127.0.0.1:${inviter.port}`)
    const peer = await guest.app.redeemInvite(code)

    expect(peer.peerId).toBe(inviter.app.identity.nodeId)
    expect(peer.status).toBe("connected")
  })

  test("an invite pointing at the wrong identity is refused", async () => {
    const impostor = await startNode("mallory")
    const guest = await startNode("zro")

    // The code advertises roshan's fingerprint but the impostor's address —
    // exactly what an edited-in-transit invite looks like.
    const expectedFp = "A".repeat(64)
    const code = repointFingerprint(
      await impostor.app.createInvite(`127.0.0.1:${impostor.port}`),
      expectedFp,
    )

    await expect(guest.app.redeemInvite(code)).rejects.toThrow(/INVITE MISMATCH/)
  })

  test("REGRESSION: a refused invite never names the impostor after the inviter", async () => {
    const impostor = await startNode("mallory")
    const guest = await startNode("zro")

    // The invite claims to be from "roshan". Naming used to happen BEFORE the
    // fingerprint check, so the impostor was written into the registry as
    // "roshan" and survived the rejection as an offline contact.
    const code = repointFingerprint(
      `nex://roshan@127.0.0.1:${impostor.port}/fp=${"A".repeat(64)}`,
      "A".repeat(64),
    )

    await expect(guest.app.redeemInvite(code)).rejects.toThrow(/INVITE MISMATCH/)

    const contacts = await guest.app.listPeers()
    const mislabelled = contacts.filter((p) => p.displayName === "roshan")
    expect(mislabelled).toEqual([])

    // And whatever record remains must not be a live link.
    const impostorRecord = contacts.find((p) => p.peerId === impostor.app.identity.nodeId)
    expect(impostorRecord?.status ?? "offline").not.toBe("connected")
  })
})

describe("discovery fingerprint pinning", () => {
  /** Seed the seen-registry directly; a real beacon would land here too. */
  function planeBeacon(app: NexAppImpl, entry: Omit<DiscoveredPeer, "seenAt">): void {
    ;(app as unknown as { discovered: { observe(e: Omit<DiscoveredPeer, "seenAt">): unknown } }).discovered.observe(
      entry,
    )
  }

  test("connecting to a discovered peer that answers as itself succeeds", async () => {
    const neighbor = await startNode("roshan")
    const me = await startNode("zro")

    planeBeacon(me.app, {
      peerId: neighbor.app.identity.nodeId,
      name: "roshan",
      address: `127.0.0.1:${neighbor.port}`,
      source: "lan",
      fp: neighbor.app.identity.nodeId,
    })

    const peer = await me.app.connectDiscovered(neighbor.app.identity.nodeId)
    expect(peer.peerId).toBe(neighbor.app.identity.nodeId)
  })

  test("a spoofed beacon pointing at someone else's address is refused", async () => {
    const impostor = await startNode("mallory")
    const me = await startNode("zro")

    // Anyone on the LAN can broadcast "I am roshan, reach me here" while the
    // address actually resolves to them. The nodeId that answers gives it away.
    const claimedId = "B".repeat(64)
    planeBeacon(me.app, {
      peerId: claimedId,
      name: "roshan",
      address: `127.0.0.1:${impostor.port}`,
      source: "lan",
      fp: claimedId,
    })

    await expect(me.app.connectDiscovered(claimedId)).rejects.toThrow(/DISCOVERY MISMATCH/)
  })

  test("a bad introduction names the friend who vouched", async () => {
    const impostor = await startNode("mallory")
    const me = await startNode("zro")

    const claimedId = "C".repeat(64)
    planeBeacon(me.app, {
      peerId: claimedId,
      name: "roshan",
      address: `127.0.0.1:${impostor.port}`,
      source: "intro",
      viaPeerId: "D".repeat(64),
      viaName: "cku",
      fp: claimedId,
    })

    await expect(me.app.connectDiscovered(claimedId)).rejects.toThrow(/introduced by cku/)
  })
})

describe("invite address parsing", () => {
  test("splits host:port, leaves bare hosts and IPv6 literals alone", () => {
    expect(splitHostPort("100.64.0.2:42101", 42001)).toEqual({ host: "100.64.0.2", port: 42101 })
    expect(splitHostPort("nex.example", 42001)).toEqual({ host: "nex.example", port: 42001 })
    // A bare IPv6 literal ends in a numeric run after a colon; it is NOT a port.
    expect(splitHostPort("fe80::1", 42001)).toEqual({ host: "fe80::1", port: 42001 })
    expect(splitHostPort("[fe80::1]:42101", 42001)).toEqual({ host: "fe80::1", port: 42101 })
    expect(splitHostPort("[fe80::1]", 42001)).toEqual({ host: "fe80::1", port: 42001 })
    // Out-of-range ports fall back rather than producing an undialable code.
    expect(splitHostPort("host:99999", 42001)).toEqual({ host: "host:99999", port: 42001 })
  })

  test("REGRESSION: an explicit host:port does not double-append the port", async () => {
    const node = await startNode("roshan")
    const code = await node.app.createInvite(`127.0.0.1:${node.port}`)

    expect(code).not.toContain(`:${node.port}:${node.port}`)
    // The malformed form parsed with fp SILENTLY DROPPED, which disabled pinning.
    const parts = decodeInvite(code)
    expect(parts).not.toBeNull()
    expect(parts!.fp).toBe(node.app.identity.nodeId)
  })
})

describe("invite pin cannot be downgraded", () => {
  test("a code with the fingerprint stripped is refused, not silently unpinned", async () => {
    const impostor = await startNode("mallory")
    const guest = await startNode("zro")

    const stripped = `nex://roshan@127.0.0.1:${impostor.port}`
    await expect(guest.app.redeemInvite(stripped)).rejects.toThrow(/UNPINNED INVITE/)
  })

  test("a code with trailing junk is refused outright", async () => {
    const guest = await startNode("zro")
    await expect(guest.app.redeemInvite("nex://x@127.0.0.1:42101/fp=AABB/../evil")).rejects.toThrow(
      /invalid nex/,
    )
  })
})
