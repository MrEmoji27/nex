// Renaming yourself.
//
// The part worth testing is not that a string changed — it is that the change
// SURVIVES. A name held only in memory disappears on the next launch, and the
// user has no way to tell which name the peer actually saw. And the nodeId must
// not move: identity is the key, the name is a label on top of it, and a rename
// that rotated the key would silently break every existing trust relationship.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NexAppImpl } from "../src/core/app"
import { FileIdentityStore, generateIdentity, ensureNoiseStaticKey } from "../src/core/identity"
import { FileConversationStore, FilePeerRegistryStore } from "../src/core/state/persistence"
import { EncryptedTcpTransport } from "../src/network/tcp/encrypted-tcp-transport"

const dirs: string[] = []
const running: NexAppImpl[] = []

async function open(dir: string, name?: string) {
  const identityStore = new FileIdentityStore(join(dir, "identity.json"))
  let identity = await identityStore.load()
  let secret = await identityStore.loadSecret()
  if (!identity || !secret) {
    const generated = generateIdentity()
    identity = { ...generated.identity, name: name ?? generated.identity.name }
    await identityStore.save(identity, generated.secret)
    secret = generated.secret
  }
  secret = await ensureNoiseStaticKey(identityStore, identity, secret)
  const app = new NexAppImpl({
    identityStore,
    conversations: new FileConversationStore(join(dir, "conversations")),
    registry: new FilePeerRegistryStore(join(dir, "peers.json")),
    transport: new EncryptedTcpTransport({ identityPrivHex: secret.identityPrivHex! }),
    port: 0,
  })
  await app.start()
  running.push(app)
  return app
}

afterEach(async () => {
  for (const app of running.splice(0)) await app.shutdown().catch(() => {})
})
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
})

describe("setDisplayName", () => {
  test("the new name survives a restart, and the nodeId does not move", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nex-name-"))
    dirs.push(dir)

    const first = await open(dir, "installed")
    const nodeId = first.identity.nodeId
    expect(first.identity.name).toBe("installed")

    await first.setDisplayName("zro")
    expect(first.identity.name).toBe("zro")
    await first.shutdown()
    running.length = 0

    // The point of the test: reopen from disk.
    const second = await open(dir)
    expect(second.identity.name).toBe("zro")
    // Identity is the key. A rename that rotated it would quietly break every
    // peer that had already pinned this node.
    expect(second.identity.nodeId).toBe(nodeId)
  }, 20_000)

  test("it announces the change so the interface can follow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nex-name-"))
    dirs.push(dir)
    const app = await open(dir, "before")

    const seen: string[] = []
    app.emit((event) => {
      if (event.type === "identityLoaded") seen.push(event.identity.name)
    })
    await app.setDisplayName("after")
    expect(seen).toContain("after")
  }, 20_000)

  test("an empty or oversized name is refused, not silently accepted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nex-name-"))
    dirs.push(dir)
    const app = await open(dir, "keeper")

    await expect(app.setDisplayName("   ")).rejects.toThrow(/cannot be empty/)
    await expect(app.setDisplayName("x".repeat(33))).rejects.toThrow(/at most 32/)
    // A refused rename must leave the old name intact rather than half-applying.
    expect(app.identity.name).toBe("keeper")
  }, 20_000)

  test("renaming to the same name is a no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nex-name-"))
    dirs.push(dir)
    const app = await open(dir, "same")
    const seen: string[] = []
    app.emit((event) => {
      if (event.type === "identityLoaded") seen.push(event.identity.name)
    })
    await app.setDisplayName("same")
    expect(seen).toEqual([])
  }, 20_000)
})
