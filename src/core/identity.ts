// Identity store: implements the contract's IdentityStore.
//
// v1 fingerprints: nodeId = uppercase-hex SHA-256(seedBytes) — the fingerprint no
// longer contains the secret seed (legacy identities stored seed-as-nodeId).
// Hashing uses Bun.CryptoHasher (sync, platform-provided; no custom crypto).
import type { IdentityStore, IdentitySecret, NodeIdentity, PeerInfo } from "./contract.ts"
import { x25519 } from "@noble/curves/ed25519.js"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

const IDENTITY_FILE = "data/local/identity.json"

interface IdentityFile {
  identity: NodeIdentity
  secret: IdentitySecret
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Uppercase-hex SHA-256 over raw bytes. */
export function sha256HexUpper(data: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(data)
  return hasher.digest("hex").toUpperCase()
}

/**
 * v2 verifier token derived from the secret seed (never transmitted as-is).
 * Domain separator bumped at the nex rename: both peers must run v2; older
 * pairings re-establish TOFU continuity once after upgrading.
 * V_own = hex(HMAC-SHA256(key: seedBytes, msg: "nex-attest-v1:" + nodeId))
 */
export function deriveVerifier(seedHex: string, nodeId: string): string {
  const hasher = new Bun.CryptoHasher("sha256", hexToBytes(seedHex))
  hasher.update(`nex-attest-v1:${nodeId}`)
  return hasher.digest("hex")
}

/** HMAC-SHA256(key: keyHex, msg: messageHex), lowercase hex out. */
export function hmacHex(keyHex: string, messageHex: string): string {
  const hasher = new Bun.CryptoHasher("sha256", hexToBytes(keyHex))
  hasher.update(messageHex)
  return hasher.digest("hex")
}

// ---------- v2 encrypted transport identity key ----------

/**
 * Long-term X25519 static key for the Noise-encrypted transport, stored beside
 * the seed in identity.json. Generated once per node; the public half is what
 * TOFU continuity pins (see identities.json).
 */
export interface NoiseStaticKey {
  privHex: string
  pubHex: string
}

export function generateNoiseStaticKey(): NoiseStaticKey {
  const kp = x25519.keygen()
  return { privHex: toHex(kp.secretKey), pubHex: toHex(kp.publicKey) }
}

export function noisePublicKeyFromPrivate(privHex: string): string {
  return toHex(x25519.getPublicKey(hexToBytes(privHex)))
}

/**
 * Ensure a secret carries an X25519 static key; generates and persists one when
 * missing (pre-v2 identity files). Returns the (possibly updated) secret.
 */
export async function ensureNoiseStaticKey(
  store: { save(identity: NodeIdentity, secret: IdentitySecret): Promise<void> },
  identity: NodeIdentity,
  secret: IdentitySecret,
): Promise<IdentitySecret> {
  if (secret.identityPrivHex && secret.identityPrivHex.length === 64) return secret
  const key = generateNoiseStaticKey()
  const updated: IdentitySecret = { ...secret, identityPrivHex: key.privHex }
  await store.save(identity, updated)
  return updated
}

/**
 * True when an identity file uses the legacy shape (nodeId === uppercase seedHex),
 * meaning the stored fingerprint contains the secret.
 */
export function isLegacyIdentity(identity: NodeIdentity, secret: IdentitySecret): boolean {
  return identity.nodeId.toUpperCase() === secret.seedHex.toUpperCase()
}

/**
 * Migrate a legacy identity to the v1 shape:
 * - recompute nodeId = SHA-256(seedBytes)
 * - rename conversations/<oldNodeId>.json -> <newNodeId>.json
 * - drop registry entries whose peerId equals OUR old nodeId (defensive; remote
 *   entries keep their old peerIds until those peers re-handshake — their real
 *   nodeIds are unknowable locally, so we cannot rewrite them here).
 * Returns null when the identity is already current.
 */
export async function migrateLegacyIdentity(
  dir: string,
  identityFile: IdentityFile,
): Promise<{ identity: NodeIdentity; secret: IdentitySecret } | null> {
  if (!isLegacyIdentity(identityFile.identity, identityFile.secret)) return null

  const oldNodeId = identityFile.identity.nodeId
  const newNodeId = sha256HexUpper(hexToBytes(identityFile.secret.seedHex))
  const migrated: IdentityFile = {
    identity: { ...identityFile.identity, nodeId: newNodeId },
    secret: identityFile.secret,
  }

  // Rewrite identity.json first; conversation rename failure must not lose it.
  await writeIdentityFile(join(dir, "identity.json"), migrated)

  try {
    await rename(
      join(dir, "conversations", `${oldNodeId}.json`),
      join(dir, "conversations", `${newNodeId}.json`),
    )
  } catch {
    // No legacy conversation file (ENOENT) or unmovable — history stays under the old name.
  }

  // Defensive: our own id should never appear as a remote peer entry.
  const peersPath = join(dir, "peers.json")
  try {
    const parsed: unknown = JSON.parse(await readFile(peersPath, "utf8"))
    if (Array.isArray(parsed)) {
      const filtered = parsed.filter((p) => (p as PeerInfo | null)?.peerId !== oldNodeId)
      if (filtered.length !== parsed.length) {
        await writeFile(peersPath, JSON.stringify(filtered, null, 2) + "\n", "utf8")
      }
    }
  } catch {
    // No registry file or unreadable — nothing to fix.
  }

  return { identity: migrated.identity, secret: migrated.secret }
}

async function writeIdentityFile(filePath: string, file: IdentityFile): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(file, null, 2) + "\n", "utf8")
}

/** Generate a fresh node identity from a crypto-random 32-byte seed (spec §17). */
export function generateIdentity(now = Date.now()): { identity: NodeIdentity; secret: IdentitySecret } {
  const seed = new Uint8Array(32)
  crypto.getRandomValues(seed)
  const seedHex = toHex(seed)
  const identity: NodeIdentity = {
    nodeId: sha256HexUpper(seed),
    name: `node-${seedHex.slice(0, 6)}`,
    createdAt: now,
  }
  return { identity, secret: { seedHex } }
}

/**
 * Persistent node identity stored at <dataDir>/identity.json.
 * First run generates and saves; later runs load — survives restarts (spec §5).
 * Loading transparently migrates the legacy seed-as-nodeId shape (v1 migration).
 */
export class FileIdentityStore implements IdentityStore {
  constructor(private readonly filePath: string = IDENTITY_FILE) {}

  private get dataDir(): string {
    return dirname(this.filePath)
  }

  private async readFile(): Promise<IdentityFile | null> {
    try {
      const raw = await readFile(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as Partial<IdentityFile>
      if (!parsed.identity?.nodeId || !parsed.secret?.seedHex) return null
      return parsed as IdentityFile
    } catch {
      return null
    }
  }

  async load(): Promise<NodeIdentity | null> {
    const file = await this.readFile()
    if (!file) return null
    const migrated = await migrateLegacyIdentity(this.dataDir, file)
    return (migrated ?? file).identity
  }

  /** Load identity with legacy-shape migration applied to disk. */
  async loadMigrated(): Promise<IdentityFile | null> {
    const file = await this.readFile()
    if (!file) return null
    return (await migrateLegacyIdentity(this.dataDir, file)) ?? file
  }

  async loadSecret(): Promise<IdentitySecret | null> {
    return (await this.readFile())?.secret ?? null
  }

  async save(identity: NodeIdentity, secret: IdentitySecret): Promise<void> {
    await writeIdentityFile(this.filePath, { identity, secret })
  }
}
