// Worker A owns this file: implements ConversationStore + PeerRegistryStore per .workers/worker-a.md
import type { ChatMessage, ConversationStore, PeerInfo, PeerRegistryStore } from "../contract.ts"
import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

const CONVERSATIONS_DIR = "data/local/conversations"
const REGISTRY_FILE = "data/local/peers.json"

/** In-process serialization so concurrent upserts never race the same file. */
const writeLocks = new Map<string, Promise<unknown>>()

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => writeJsonAtomicOnce(filePath, value))
  writeLocks.set(filePath, current)
  try {
    await current
  } finally {
    if (writeLocks.get(filePath) === current) writeLocks.delete(filePath)
  }
}

async function writeJsonAtomicOnce(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomicOnce(filePath, JSON.stringify(value, null, 2) + "\n")
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const previous = writeLocks.get(filePath) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(() => writeTextAtomicOnce(filePath, text))
  writeLocks.set(filePath, current)
  try {
    await current
  } finally {
    if (writeLocks.get(filePath) === current) writeLocks.delete(filePath)
  }
}

async function writeTextAtomicOnce(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  // Unique temp name: concurrent writers to the same target must not steal
  // each other's tmp file.
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`
  await writeFile(tmp, text, "utf8")
  // Windows: rename over a just-replaced destination can transiently fail
  // with EPERM/ENOENT — retry briefly before giving up.
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, filePath)
      return
    } catch (err) {
      lastError = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") throw err
      await Bun.sleep(10 * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * Append-only JSON-per-peer conversation files under data/local/conversations/<peerId>.json.
 * Each line is one ChatMessage (spec §19).
 */
export class FileConversationStore implements ConversationStore {
  constructor(private readonly dir: string = CONVERSATIONS_DIR) {}

  private fileFor(peerId: string): string {
    return join(this.dir, `${peerId}.json`)
  }

  async append(peerId: string, message: ChatMessage): Promise<void> {
    const file = this.fileFor(peerId)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(message) + "\n", "utf8")
  }

  async loadAll(peerId: string): Promise<ChatMessage[]> {
    let raw: string
    try {
      raw = await readFile(this.fileFor(peerId), "utf8")
    } catch {
      return []
    }
    const messages: ChatMessage[] = []
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        messages.push(JSON.parse(line) as ChatMessage)
      } catch {
        // Skip malformed lines; conversation files are append-only logs.
      }
    }
    return messages
  }

  /**
   * Retention prune (v2, vision §12): drop messages strictly older than cutoffMs
   * and rewrite the log. Local copy only — this says nothing about the peer's data.
   */
  async deleteBefore(peerId: string, cutoffMs: number): Promise<number> {
    const messages = await this.loadAll(peerId)
    const kept = messages.filter((message) => message.sentAt >= cutoffMs)
    if (kept.length === messages.length) return 0
    // Keep the append-only JSONL shape loadAll() reads.
    await writeTextAtomic(
      this.fileFor(peerId),
      kept.map((message) => JSON.stringify(message) + "\n").join(""),
    )
    return messages.length - kept.length
  }
}

/** Peer registry at data/local/peers.json — the list of known peers. */
export class FilePeerRegistryStore implements PeerRegistryStore {
  private readonly file: string

  constructor(private readonly filePath: string = REGISTRY_FILE) {
    this.file = filePath
  }

  async upsert(peer: PeerInfo): Promise<void> {
    const peers = await this.list()
    const index = peers.findIndex((p) => p.peerId === peer.peerId)
    if (index >= 0) peers[index] = { ...peers[index], ...peer }
    else peers.push({ ...peer })
    await writeJsonAtomic(this.filePath, peers)
  }

  async list(): Promise<PeerInfo[]> {
    try {
      const raw = await readFile(this.file, "utf8")
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PeerInfo[]) : []
    } catch {
      return []
    }
  }
}

const ATTESTATIONS_FILE = "data/local/attestations.json"

/**
 * Remembered peer verifier (v1 handshake, TOFU): nodeId -> the verifier token the
 * peer presented at first meeting. Later handshakes must prove control of the
 * REMEMBERED token, which pins continuity of control of that nodeId.
 */
export interface AttestationRecord {
  readonly nodeId: string
  readonly verifier: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
}

/** Storage port for handshake attestations (implemented by FileAttestationStore). */
export interface AttestationStore {
  get(nodeId: string): Promise<AttestationRecord | null>
  put(record: AttestationRecord): Promise<void>
}

/**
 * Verifier records at <dataDir>/attestations.json, JSON object keyed by nodeId.
 * Wire me next to the other stores in node-app.ts (supervisor-owned):
 *   new FileAttestationStore(join(dataDir, "attestations.json"))
 */
export class FileAttestationStore implements AttestationStore {
  constructor(private readonly filePath: string = ATTESTATIONS_FILE) {}

  async get(nodeId: string): Promise<AttestationRecord | null> {
    const all = await this.readAll()
    return all[nodeId] ?? null
  }

  async put(record: AttestationRecord): Promise<void> {
    const all = await this.readAll()
    all[record.nodeId] = record
    await writeJsonAtomic(this.filePath, all)
  }

  private async readAll(): Promise<Record<string, AttestationRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"))
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, AttestationRecord>)
        : {}
    } catch {
      return {}
    }
  }
}


// ---------- v2 encrypted-transport identity bindings ----------

export interface StaticKeyRecord {
  readonly nodeId: string
  /** Hex X25519 public key the peer presented at first meeting. */
  readonly staticKey: string
  readonly firstSeenAt: number
  readonly lastSeenAt: number
}

/**
 * TOFU continuity for Noise static keys (v2): nodeId -> public key first seen.
 * A known nodeId presenting a DIFFERENT static key is an impostor or a
 * key-rotation attempt; either way it must be surfaced as a mismatch.
 */
export interface StaticKeyStore {
  get(nodeId: string): Promise<StaticKeyRecord | null>
  put(record: StaticKeyRecord): Promise<void>
}

/** Bindings at <dataDir>/identities.json, JSON object keyed by nodeId. */
export class FileStaticKeyStore implements StaticKeyStore {
  constructor(private readonly filePath: string) {}

  async get(nodeId: string): Promise<StaticKeyRecord | null> {
    return (await this.readAll())[nodeId] ?? null
  }

  async put(record: StaticKeyRecord): Promise<void> {
    const all = await this.readAll()
    all[record.nodeId] = record
    await writeJsonAtomic(this.filePath, all)
  }

  private async readAll(): Promise<Record<string, StaticKeyRecord>> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"))
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, StaticKeyRecord>)
        : {}
    } catch {
      return {}
    }
  }
}
