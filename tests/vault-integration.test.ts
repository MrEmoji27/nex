// End-to-end storage tiers: device-key default, passphrase protective tier,
// explicit plaintext opt-out — plus legacy-directory migration and fail-closed.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readdir, readFile, rm } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeAppResult } from "../src/main/node-app"
import { createNodeApp } from "../src/main/node-app"
import { generateIdentity, FileIdentityStore } from "../src/core/identity"
import {
  FileConversationStore,
  FilePeerRegistryStore,
} from "../src/core/state/persistence"

const dirs: string[] = []
const apps: NodeAppResult[] = []

function newDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const entry of apps.splice(0)) await entry.app.shutdown().catch(() => {})
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

async function readAllBytes(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else chunks.push(await readFile(full))
    }
  }
  await walk(dir)
  return Buffer.concat(chunks)
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(25)
  }
  throw new Error("waitFor timed out")
}

describe("storage tiers", () => {
  test("default boot = DEVICE KEY vault (no typing), files encrypted on disk", async () => {
    const dir = newDir("nex-tier-std-")
    const node = await createNodeApp({ dataDir: dir, name: "standard", port: 42_741 })
    apps.push(node)

    expect(node.storageSecurity).toBe("device-key")
    expect(node.app.getStorageSecurity()).toBe("device-key")

    const files = await readdir(dir)
    expect(files).toContain("vault.key")
    expect(files).toContain("identity.vault")
    expect(files).not.toContain("identity.json")
    expect((await readAllBytes(dir)).includes(Buffer.from('"seedHex"'))).toBe(false)
  })

  test("passphrase tier wraps the same vault and fails closed on wrong key", async () => {
    const dir = newDir("nex-tier-pass-")
    const PASS = "rosh-and-cku-secret"

    const first = await createNodeApp({
      dataDir: dir,
      name: "vaulted",
      port: 42_742,
      passphrase: PASS,
      warnings: false,
    })
    apps.push(first)
    expect(first.storageSecurity).toBe("passphrase")
    expect(first.app.getStorageSecurity()).toBe("passphrase")

    const remote = await createNodeApp({
      dataDir: newDir("nex-tier-peer-"),
      name: "cku",
      port: 42_743,
      warnings: false,
    })
    apps.push(remote)
    await first.app.connectTo(`127.0.0.1:${remote.port}`)
    await first.app.sendMessage(remote.app.identity.nodeId, "vaulted hello")
    await waitFor(async () =>
      (await remote.app.listPeers()).some((p) => p.peerId === first.app.identity.nodeId),
    )
    await first.app.shutdown()

    const rawAll = await readAllBytes(dir)
    expect(rawAll.includes(Buffer.from("vaulted hello"))).toBe(false)
    expect(rawAll.includes(Buffer.from('"seedHex"'))).toBe(false)

    // Correct passphrase restores everything.
    const second = await createNodeApp({
      dataDir: dir,
      name: "vaulted",
      port: 42_742,
      passphrase: PASS,
      warnings: false,
    })
    apps.push(second)
    expect(second.app.identity.name).toBe("vaulted")
    const peers = await second.app.listPeers()
    const history = await second.app.conversation(peers[0]!.peerId)
    expect(history.some((m) => m.content === "vaulted hello")).toBe(true)
    await second.app.shutdown()

    let failed: unknown = null
    try {
      await createNodeApp({ dataDir: dir, name: "vaulted", port: 42_742, passphrase: "not-it" })
    } catch (err) {
      failed = err
    }
    expect((failed as Error)?.message).toMatch(/passphrase|vault/i)
  })

  test("--plaintext opts out entirely and says so", async () => {
    const dir = newDir("nex-tier-plain-")
    const node = await createNodeApp({
      dataDir: dir,
      name: "plain",
      port: 42_744,
      plaintext: true,
      warnings: false,
    })
    apps.push(node)
    expect(node.storageSecurity).toBe("none")
    const files = await readdir(dir)
    expect(files).toContain("identity.json")
    expect(files).not.toContain("vault.key")
    // Plaintext is actually plaintext here — that is what opting out means.
    expect((await readFile(join(dir, "identity.json"), "utf8")).includes('"seedHex"')).toBe(true)
  })

  test("legacy plaintext directory auto-migrates into the standard vault", async () => {
    const dir = newDir("nex-tier-legacy-")
    // Write a pre-alpha.3 style directory by hand.
    const legacyStore = new FileIdentityStore(join(dir, "identity.json"))
    const generated = generateIdentity()
    await legacyStore.save({ ...generated.identity, name: "old-timer" }, generated.secret)
    const peerId = "B".repeat(64)
    await new FilePeerRegistryStore(join(dir, "peers.json")).upsert({
      peerId,
      name: "cku",
      status: "offline",
    })
    await new FileConversationStore(join(dir, "conversations")).append(peerId, {
      id: "m1",
      direction: "in",
      content: "from the plain era",
      sentAt: Date.now(),
      state: "sent",
    })

    const migrated = await createNodeApp({ dataDir: dir, name: "old-timer", port: 42_745 })
    apps.push(migrated)
    expect(migrated.storageSecurity).toBe("device-key")
    expect(migrated.app.identity.name).toBe("old-timer")

    const peers = await migrated.app.listPeers()
    expect(peers.some((p) => p.name === "cku")).toBe(true)
    const history = await migrated.app.conversation(peerId)
    expect(history.some((m) => m.content === "from the plain era")).toBe(true)

    // Verified migration removed the plaintext originals.
    const files = await readdir(dir)
    expect(files).not.toContain("identity.json")
    expect(files).not.toContain("peers.json")
    expect((await readdir(join(dir, "conversations"))).filter((f) => f.endsWith(".json"))).toEqual([])
  })

  test("headless-ready parity across all three tiers", async () => {
    const a = await createNodeApp({ dataDir: newDir("nex-tier-a-"), port: 42_746, warnings: false })
    apps.push(a)
    const b = await createNodeApp({
      dataDir: newDir("nex-tier-b-"),
      port: 42_747,
      passphrase: "x",
      warnings: false,
    })
    apps.push(b)
    const c = await createNodeApp({
      dataDir: newDir("nex-tier-c-"),
      port: 42_748,
      plaintext: true,
      warnings: false,
    })
    apps.push(c)
    expect([a.storageSecurity, b.storageSecurity, c.storageSecurity]).toEqual([
      "device-key",
      "passphrase",
      "none",
    ])
  })
})
