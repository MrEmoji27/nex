// v2 settings, retention, and read-state behavior.
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChatMessage, Settings } from "../src/core/contract.ts"
import { retentionCutoff } from "../src/core/contract"
import { FileIdentityStore, generateIdentity } from "../src/core/identity"
import { FileConversationStore, FilePeerRegistryStore, FileAttestationStore } from "../src/core/state/persistence"
import { FileSettingsStore } from "../src/core/state/settings"
import { NexAppImpl } from "../src/core/app"
import { TcpTransport } from "../src/network/tcp/tcp-transport"

const dataDirs: string[] = []
const nodes: NexAppImpl[] = []

function makeDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nex-settings-test-")).then((dir) => {
    dataDirs.push(dir)
    return dir
  })
}

afterEach(async () => {
  for (const app of nodes.splice(0)) {
    await app.shutdown().catch(() => {})
  }
})

afterAll(async () => {
  await Promise.all(dataDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

async function wireApp(dir: string): Promise<NexAppImpl> {
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
    settings: new FileSettingsStore(join(dir, "settings.json")),
    transport,
  })
  await app.start()
  nodes.push(app)
  return app
}

describe("retentionCutoff", () => {
  test("computes strict cutoffs for each policy", () => {
    const now = 1_700_000_000_000
    expect(retentionCutoff("forever", now)).toBeNull()
    expect(retentionCutoff("24h", now)).toBe(now - 24 * 60 * 60 * 1000)
    expect(retentionCutoff("7d", now)).toBe(now - 7 * 24 * 60 * 60 * 1000)
  })
})

/**
 * What a fresh install must look like. Spelled out rather than compared against
 * DEFAULT_SETTINGS so that changing a shipped default has to be a deliberate
 * edit here — rendezvous defaulting to ON would be a privacy regression the
 * test should catch, not absorb.
 */
const DEFAULTS: Settings = {
  theme: undefined,
  retention: "forever",
  discovery: true,
  rendezvous: { enabled: false },
}

describe("FileSettingsStore", () => {
  test("round-trips settings through disk", async () => {
    const dir = await makeDataDir()
    const store = new FileSettingsStore(join(dir, "settings.json"))
    // alpha.7 adds the discovery default, v3 adds rendezvous (opt-in, so off);
    // load() normalizes to DEFAULT_SETTINGS.
    expect(await store.load()).toEqual(DEFAULTS)

    await store.save({ theme: "nord", retention: "7d", lastReadAt: { abc: 123 }, discovery: false })
    const loaded = await new FileSettingsStore(join(dir, "settings.json")).load()
    expect(loaded.theme).toBe("nord")
    expect(loaded.retention).toBe("7d")
    expect(loaded.lastReadAt?.abc).toBe(123)
    expect(loaded.discovery).toBe(false)
  })

  test("missing or corrupt file falls back to defaults", async () => {
    const dir = await makeDataDir()
    const store = new FileSettingsStore(join(dir, "missing.json"))
    expect(await store.load()).toEqual(DEFAULTS)

    const bad = join(dir, "bad.json")
    await Bun.write(bad, "{not json")
    expect(await new FileSettingsStore(bad).load()).toEqual(DEFAULTS)
  })
})

describe("FileConversationStore.deleteBefore", () => {
  test("removes strictly-older messages and rewrites the log", async () => {
    const dir = await makeDataDir()
    const store = new FileConversationStore(join(dir, "conversations"))
    const peerId = "a".repeat(64)
    const message = (id: string, sentAt: number): ChatMessage => ({
      id,
      direction: "in",
      content: id,
      sentAt,
      state: "sent",
    })
    await store.append(peerId, message("old", 1_000))
    await store.append(peerId, message("edge", 5_000))
    await store.append(peerId, message("new", 9_000))

    // Strictly older than 5000 goes; the boundary message survives (>= cutoff).
    expect(await store.deleteBefore(peerId, 5_000)).toBe(1)
    const kept = await store.loadAll(peerId)
    expect(kept.map((m) => m.id)).toEqual(["edge", "new"])

    // Idempotent once nothing is expired.
    expect(await store.deleteBefore(peerId, 5_000)).toBe(0)
  })
})

describe("app-level retention + settings", () => {
  test("retention filters the loaded conversation view and prunes disk", async () => {
    const dir = await makeDataDir()
    const peerId = "b".repeat(64)
    // Register the peer first: setRetention prunes conversations of known peers.
    await new FilePeerRegistryStore(join(dir, "peers.json")).upsert({
      peerId,
      name: "old-friend",
      status: "offline",
    })
    const app = await wireApp(dir)
    const conversations = new FileConversationStore(join(dir, "conversations"))
    await conversations.append(peerId, {
      id: "ancient",
      direction: "in",
      content: "ancient",
      sentAt: Date.now() - 48 * 60 * 60 * 1000,
      state: "sent",
    })
    await conversations.append(peerId, {
      id: "fresh",
      direction: "in",
      content: "fresh",
      sentAt: Date.now(),
      state: "sent",
    })

    await app.setRetention("24h")
    let seen = await app.conversation(peerId)
    expect(seen.map((m) => m.id)).toEqual(["fresh"])

    // Pruning ran opportunistically: the ancient line is gone from disk too.
    const onDisk = await conversations.loadAll(peerId)
    expect(onDisk.map((m) => m.id)).toEqual(["fresh"])

    await app.setRetention("forever")
    seen = await app.conversation(peerId)
    expect(seen.map((m) => m.id)).toEqual(["fresh"])
  })

  test("theme, retention, and read state persist across an app restart", async () => {
    const dir = await makeDataDir()
    const first = await wireApp(dir)
    await first.setTheme("catppuccin-mocha")
    await first.setRetention("7d")
    await first.markConversationRead("c".repeat(64))

    const second = await wireApp(dir)
    const settings = second.getSettings()
    expect(settings.theme).toBe("catppuccin-mocha")
    expect(settings.retention).toBe("7d")
    expect(settings.lastReadAt?.["c".repeat(64)]).toBeGreaterThan(0)

    // Version stamping is idempotent and persisted.
    await second.markVersionSeen("2.0.0-alpha.1")
    await second.markVersionSeen("2.0.0-alpha.1")
    expect((await new FileSettingsStore(join(dir, "settings.json")).load()).lastSeenVersion).toBe(
      "2.0.0-alpha.1",
    )
  })

  test("setRetention emits settingsChanged events", async () => {
    const app = await wireApp(await makeDataDir())
    const events: string[] = []
    app.emit((event) => {
      if (event.type === "settingsChanged") events.push(event.settings.retention ?? "")
    })
    await app.setRetention("24h")
    expect(events).toEqual(["24h"])
  })
})
