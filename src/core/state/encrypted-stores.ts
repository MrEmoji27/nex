// Encrypted variants of the persistence ports, backed by vault envelopes.
// Same interfaces as the plaintext stores in persistence.ts / identity.ts —
// node-app picks plain vs vault based on whether the user set a passphrase.
import type {
  ChatMessage,
  ConversationStore,
  IdentitySecret,
  IdentityStore,
  NodeIdentity,
  PeerInfo,
  PeerRegistryStore,
  PeerRetentionState,
  RetentionStore,
  Settings,
  SettingsStore,
} from "../contract.ts"
import { isLegacyIdentity } from "../identity"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { FileConversationStore } from "./persistence"
import type { StaticKeyRecord, StaticKeyStore } from "./persistence"
import type { VaultCrypto } from "./vault"

/** In-process serialization so concurrent rewrites never race one file. */
const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  locks.set(key, current)
  try {
    return await current
  } finally {
    if (locks.get(key) === current) locks.delete(key)
  }
}

async function readJsonAt<T>(vault: VaultCrypto, root: string, logicalName: string): Promise<T | null> {
  let raw: Uint8Array
  try {
    raw = await readFile(join(root, logicalName))
  } catch {
    return null
  }
  try {
    return JSON.parse(new TextDecoder().decode(vault.decryptBlob(logicalName, raw))) as T
  } catch {
    return null
  }
}

async function writeJson(vault: VaultCrypto, root: string, logicalName: string, value: unknown): Promise<void> {
  await withLock(logicalName, async () => {
    const target = join(root, logicalName)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${crypto.randomUUID()}.tmp`
    const blob = vault.encryptBlob(logicalName, new TextEncoder().encode(JSON.stringify(value)))
    await writeFile(tmp, blob)
    // Windows-safe replace with brief retry.
    let lastError: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, target)
        return
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") throw err
        await Bun.sleep(10 * (attempt + 1))
      }
    }
    throw lastError
  })
}

// ---------- identity ----------

interface IdentityFile {
  identity: NodeIdentity
  secret: IdentitySecret
}

/**
 * Identity + secrets inside identity.vault. Legacy seed-as-nodeId migration is
 * intentionally NOT supported here: migrate an ancient directory to current
 * plaintext first, then enable the vault.
 */
export class VaultIdentityStore implements IdentityStore {
  private readonly logical = "identity.vault"

  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  async load(): Promise<NodeIdentity | null> {
    const file = await this.readFile()
    if (!file || isLegacyIdentity(file.identity, file.secret)) return null
    return file.identity
  }

  async loadSecret(): Promise<IdentitySecret | null> {
    return (await this.readFile())?.secret ?? null
  }

  async save(identity: NodeIdentity, secret: IdentitySecret): Promise<void> {
    await writeJson(this.vault, this.root, this.logical, { identity, secret } satisfies IdentityFile)
  }

  private async readFile(): Promise<IdentityFile | null> {
    const parsed = await readJsonAt<Partial<IdentityFile>>(this.vault, this.root, this.logical)
    if (!parsed?.identity?.nodeId || !parsed.secret?.seedHex) return null
    return parsed as IdentityFile
  }
}

// ---------- conversations ----------

/**
 * Whole-file model inside the vault: each append decrypts, appends, re-encrypts.
 * Fine at human chat scale; retention pruning shares the same rewrite path.
 */
export class VaultConversationStore implements ConversationStore {
  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  private logicalFor(peerId: string): string {
    return `conversations/${peerId}.vault`
  }

  async append(peerId: string, message: ChatMessage): Promise<void> {
    const messages = await this.loadAll(peerId)
    messages.push(message)
    await writeJson(this.vault, this.root, this.logicalFor(peerId), messages)
  }

  async loadAll(peerId: string): Promise<ChatMessage[]> {
    const value = await readJsonAt<ChatMessage[]>(this.vault, this.root, this.logicalFor(peerId))
    return Array.isArray(value) ? value : []
  }

  async deleteBefore(peerId: string, cutoffMs: number): Promise<number> {
    const messages = await this.loadAll(peerId)
    const kept = messages.filter((m) => m.sentAt >= cutoffMs)
    if (kept.length === messages.length) return 0
    await writeJson(this.vault, this.root, this.logicalFor(peerId), kept)
    return messages.length - kept.length
  }
}

// ---------- registry + static-key bindings ----------

export class VaultPeerRegistryStore implements PeerRegistryStore {
  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  async upsert(peer: PeerInfo): Promise<void> {
    const peers = await this.list()
    const index = peers.findIndex((p) => p.peerId === peer.peerId)
    if (index >= 0) peers[index] = { ...peers[index], ...peer }
    else peers.push({ ...peer })
    await writeJson(this.vault, this.root, "peers.vault", peers)
  }

  async list(): Promise<PeerInfo[]> {
    const value = await readJsonAt<PeerInfo[]>(this.vault, this.root, "peers.vault")
    return Array.isArray(value) ? value : []
  }
}

export class VaultStaticKeyStore implements StaticKeyStore {
  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  async get(nodeId: string): Promise<StaticKeyRecord | null> {
    const all = await this.readAll()
    return all[nodeId] ?? null
  }

  async put(record: StaticKeyRecord): Promise<void> {
    const all = await this.readAll()
    all[record.nodeId] = record
    await writeJson(this.vault, this.root, "identities.vault", all)
  }

  async readAllRecords(): Promise<Record<string, StaticKeyRecord>> {
    return this.readAll()
  }

  private async readAll(): Promise<Record<string, StaticKeyRecord>> {
    const value = await readJsonAt<Record<string, StaticKeyRecord>>(this.vault, this.root, "identities.vault")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  }
}

// ---------- settings + retention agreements ----------

/** Settings inside the vault — read-state metadata must not leak activity. */
export class VaultSettingsStore implements SettingsStore {
  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  private static readonly logical = "settings.vault"

  async load(): Promise<Settings> {
    const value = await readJsonAt<Partial<Settings>>(this.vault, this.root, VaultSettingsStore.logical)
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    return value as Settings
  }

  async save(settings: Settings): Promise<void> {
    await writeJson(this.vault, this.root, VaultSettingsStore.logical, settings)
  }
}

/** Per-peer retention-agreement protocol state inside the vault. */
export class VaultRetentionStore implements RetentionStore {
  constructor(
    private readonly vault: VaultCrypto,
    private readonly root: string,
  ) {}

  private static readonly logical = "agreements.vault"

  async load(): Promise<Record<string, PeerRetentionState>> {
    const value = await readJsonAt<Record<string, PeerRetentionState>>(
      this.vault,
      this.root,
      VaultRetentionStore.logical,
    )
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  }

  async save(all: Record<string, PeerRetentionState>): Promise<void> {
    await writeJson(this.vault, this.root, VaultRetentionStore.logical, all)
  }
}

// ---------- one-time plaintext -> vault migration ----------

/**
 * Carry an existing plaintext directory INTO the vault (vision §14 spirit:
 * nothing lost when the user opts into encryption later). Copies identity,
 * registry, static-key bindings, and every conversation, verifies each write
 * by reading it back, then removes the plaintext original so no secret copy
 * remains on disk. Idempotent: files without plaintext counterparts are skipped.
 */
export async function migratePlaintextIntoVault(
  vault: VaultCrypto,
  root: string,
  stores: {
    identity: VaultIdentityStore
    conversations: VaultConversationStore
    registry: VaultPeerRegistryStore
    bindings: VaultStaticKeyStore
  },
  extras?: {
    /** Absolute path of a legacy plaintext settings.json to carry in + remove. */
    settings?: string
    /** Absolute path of a legacy plaintext agreements.json to carry in + remove. */
    agreements?: string
    /** Vault settings store receiving the carried-in preferences. */
    intoSettings?: SettingsStore
    /** Vault retention store receiving the carried-in agreement state. */
    intoAgreements?: RetentionStore
  },
): Promise<{ migratedFiles: number }> {
  let migratedFiles = 0

  // ---- identity ----
  const plainIdentityPath = join(root, "identity.json")
  const hasVaultIdentity = await exists(join(root, "identity.vault"))
  try {
    const raw = await readFile(plainIdentityPath)
    if (!hasVaultIdentity) {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<{
        identity: NodeIdentity
        secret: IdentitySecret
      }>
      if (parsed.identity?.nodeId && parsed.secret?.seedHex) {
        await stores.identity.save(parsed.identity, parsed.secret)
        // Verify read-back before destroying the plaintext original.
        const secret = await stores.identity.loadSecret()
        if (secret?.seedHex !== parsed.secret.seedHex) throw new Error("vault verification failed (identity)")
        await rm(plainIdentityPath)
        migratedFiles++
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
  }

  // ---- registry ----
  const plainPeersPath = join(root, "peers.json")
  try {
    const raw = await readFile(plainPeersPath)
    const peers = JSON.parse(new TextDecoder().decode(raw)) as PeerInfo[]
    if (Array.isArray(peers) && peers.length > 0) {
      const knownBefore = new Set((await stores.registry.list()).map((p) => p.peerId))
      for (const peer of peers) {
        if (!peer?.peerId || knownBefore.has(peer.peerId)) continue
        await stores.registry.upsert(peer)
        migratedFiles++
      }
      const knownAfter = await stores.registry.list()
      if (!peers.every((p) => !p?.peerId || knownAfter.some((k) => k.peerId === p.peerId))) {
        throw new Error("vault verification failed (registry)")
      }
      await rm(plainPeersPath)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
  }

  // ---- static-key bindings ----
  const plainBindingsPath = join(root, "identities.json")
  try {
    const raw = await readFile(plainBindingsPath)
    const records = JSON.parse(new TextDecoder().decode(raw)) as Record<string, StaticKeyRecord>
    if (records && typeof records === "object" && !Array.isArray(records)) {
      for (const record of Object.values(records)) {
        if (!record?.nodeId) continue
        if (!(await stores.bindings.get(record.nodeId))) {
          await stores.bindings.put({
            nodeId: record.nodeId,
            staticKey: record.staticKey,
            firstSeenAt: record.firstSeenAt,
            lastSeenAt: record.lastSeenAt,
          })
          migratedFiles++
        }
      }
      await rm(plainBindingsPath)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
  }

  // ---- conversations ----
  const plainConversationsDir = join(root, "conversations")
  let names: string[] = []
  try {
    names = await readdir(plainConversationsDir)
  } catch {
    names = []
  }
  const plainSource = new FileConversationStore(plainConversationsDir)
  for (const name of names) {
    // Plaintext logs use <peerId>.json (JSONL inside); accept .jsonl too.
    const match = /^(.+)\.(?:json|jsonl)$/.exec(name)
    if (!match) continue
    const peerId = match[1]!
    if (!/^[0-9A-Fa-f-]{6,}$/.test(peerId)) continue
    const messages = await plainSource.loadAll(peerId)
    if (messages.length === 0 && (await exists(join(plainConversationsDir, name)))) {
      // Unreadable/empty source: leave the original untouched.
      continue
    }
    for (const message of messages) await stores.conversations.append(peerId, message)
    const copied = await stores.conversations.loadAll(peerId)
    if (copied.length < messages.length) throw new Error(`vault verification failed (${name})`)
    await rm(join(plainConversationsDir, name))
    migratedFiles++
  }

  // ---- legacy plaintext settings / agreements (metadata must not outlive the move) ----
  if (extras?.settings && (await exists(extras.settings))) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await readFile(extras.settings))) as Partial<Settings>
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && extras.intoSettings) {
        await extras.intoSettings.save({ ...parsed })
        migratedFiles++
      }
      await rm(extras.settings)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    }
  }
  if (extras?.agreements && (await exists(extras.agreements))) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(await readFile(extras.agreements))) as Record<
        string,
        PeerRetentionState
      >
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && extras.intoAgreements) {
        await extras.intoAgreements.save(parsed)
        migratedFiles++
      }
      await rm(extras.agreements)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err
    }
  }

  return { migratedFiles }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
