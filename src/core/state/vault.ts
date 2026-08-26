// Local vault crypto (vision §13 data-at-rest).
//
// Envelope format (per protected file):
//   NEXVAULT1\n | nonce[12] | ChaCha20-Poly1305 ciphertext+tag
// The logical file name is bound as associated data, so moving a ciphertext
// blob between files (identity.vault -> peers.vault) fails authentication.
//
// Key file (<dataDir>/vault.key):
//   passphrase set : NEXVAULTKEY1\n | salt[16] | nonce[12] | DEK wrapped under
//                    an Argon2id(passphrase, salt) key encryption key
//   no passphrase  : NEXPLAINKEY1\n | raw DEK
//
// Honest modes: wrapped = at-rest encryption ON. Plain-key mode exists so the
// app runs friction-free before the user opts in; it protects nothing beyond
// file boundaries and MUST be labeled "NOT ENCRYPTED" in the UI.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { argon2id } from "@noble/hashes/argon2.js"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const VAULT_MAGIC = new TextEncoder().encode("NEXVAULT1\n")
const KEY_MAGIC_WRAPPED = new TextEncoder().encode("NEXVAULTKEY1\n")
const KEY_MAGIC_PLAIN = new TextEncoder().encode("NEXPLAINKEY1\n")

const NONCE_LEN = 12
const SALT_LEN = 16
const DEK_LEN = 32
const TAG_LEN = 16

/** OWASP-recommended interactive Argon2id parameters (~19 MiB, t=2). */
const ARGON2_PARAMS = { t: 2, m: 19456, p: 1, dkLen: DEK_LEN }

export type VaultErrorCode = "wrong-passphrase" | "corrupt"

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** Associated data binds a blob to its logical file name. */
function aadFor(logicalName: string): Uint8Array {
  return new TextEncoder().encode(`nex-vault:${logicalName}`)
}

export function deriveKek(passphrase: string, salt: Uint8Array): Uint8Array {
  return argon2id(new TextEncoder().encode(passphrase), salt, ARGON2_PARAMS)
}

export interface VaultCrypto {
  /**
   * True when the DEK is wrapped by a passphrase (user must type it at boot).
   * False means the key sits on this device (standard tier): data is encrypted
   * at rest, but full-disk access defeats it — UI must say DEVICE KEY.
   */
  readonly secure: boolean
  encryptBlob(logicalName: string, plaintext: Uint8Array): Uint8Array
  decryptBlob(logicalName: string, blob: Uint8Array): Uint8Array
}

/** The extensive warning shown when a passphrase-wrapped vault is FIRST created. */
export const PASSPHRASE_CREATED_WARNING = `
========================================================================
  NEX VAULT ENABLED — READ THIS CAREFULLY
------------------------------------------------------------------------
  Your identity, contacts, trust records and message history are now
  encrypted with YOUR passphrase.

  * IF YOU LOSE THE PASSPHRASE, THE DATA IS GONE FOREVER.
  * There is NO recovery, NO reset, NO backdoor, and nobody — not the
    developer, not support — can unlock it for you.
  * Encrypted backups are unreadable without it too.
  * Write it down. Store it somewhere safe. Tell nobody.

  Continuing past this point means you understand and accept this.
========================================================================
`

/** The short reminder printed on every boot of a passphrase-protected vault. */
export const PASSPHRASE_BOOT_REMINDER =
  "vault: PASSPHRASE ENCRYPTED — lose the passphrase and this data is unrecoverable"

async function loadKeyFile(keyPath: string, passphrase: string | undefined): Promise<{ dek: Uint8Array; secure: boolean }> {
  const raw = await readFile(keyPath)

  const startsWith = (magic: Uint8Array) =>
    raw.length >= magic.length && Buffer.from(raw.subarray(0, magic.length)).equals(Buffer.from(magic))

  // ---- passphrase-wrapped ----
  if (startsWith(KEY_MAGIC_WRAPPED)) {
    if (!passphrase) {
      throw new VaultError(
        "wrong-passphrase",
        "vault is encrypted — start nex with --passphrase (or set NEX_PASSPHRASE)",
      )
    }
    const body = raw.subarray(KEY_MAGIC_WRAPPED.length)
    const expected = SALT_LEN + NONCE_LEN + DEK_LEN + TAG_LEN
    if (body.length !== expected) throw new VaultError("corrupt", "key file truncated")
    const salt = body.subarray(0, SALT_LEN)
    const nonce = body.subarray(SALT_LEN, SALT_LEN + NONCE_LEN)
    const wrappedDek = body.subarray(SALT_LEN + NONCE_LEN)
    let dek: Uint8Array
    try {
      dek = open(deriveKek(passphrase, salt), aadFor("vault-key"), nonce, wrappedDek)
    } catch {
      throw new VaultError("wrong-passphrase", "passphrase did not unlock the vault")
    }
    return { dek, secure: true }
  }

  // ---- plain-key ----
  if (startsWith(KEY_MAGIC_PLAIN)) {
    const body = raw.subarray(KEY_MAGIC_PLAIN.length)
    if (body.length !== DEK_LEN) throw new VaultError("corrupt", "key file truncated")
    return { dek: body.slice(), secure: false }
  }

  throw new VaultError("corrupt", "unrecognized key file")

  function open(key: Uint8Array, aad: Uint8Array, nonce: Uint8Array, ct: Uint8Array): Uint8Array {
    return chacha20poly1305(key, nonce, aad).decrypt(ct)
  }
}

async function writeKeyFileWrapped(keyPath: string, passphrase: string, dek: Uint8Array): Promise<void> {
  const salt = randomBytes(SALT_LEN)
  const nonce = randomBytes(NONCE_LEN)
  const wrapped = chacha20poly1305(deriveKek(passphrase, salt), nonce, aadFor("vault-key")).encrypt(dek)
  await mkdir(dirname(keyPath), { recursive: true })
  await writeFile(keyPath, concat(KEY_MAGIC_WRAPPED, salt, nonce, wrapped))
}

async function writeKeyFilePlain(keyPath: string, dek: Uint8Array): Promise<void> {
  await mkdir(dirname(keyPath), { recursive: true })
  await writeFile(keyPath, concat(KEY_MAGIC_PLAIN, dek))
}

/**
 * Open (or create) the vault key for a data directory.
 * - missing key + passphrase      -> new wrapped key (encryption ON)
 * - missing key + no passphrase   -> new device-key (standard tier, no typing)
 * - existing wrapped + passphrase -> unlock (wrong passphrase throws)
 * - existing plain + passphrase   -> UPGRADE: re-wrap existing DEK in place
 */
export async function openVaultKey(
  keyPath: string,
  passphrase?: string,
): Promise<{ crypto: VaultCrypto; created: boolean }> {
  let loaded: { dek: Uint8Array; secure: boolean }
  let created = false
  try {
    loaded = await loadKeyFile(keyPath, passphrase)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      const dek = randomBytes(DEK_LEN)
      if (passphrase) {
        await writeKeyFileWrapped(keyPath, passphrase, dek)
        loaded = { dek, secure: true }
      } else {
        await writeKeyFilePlain(keyPath, dek)
        loaded = { dek, secure: false }
      }
      created = true
    } else {
      throw err
    }
  }

  // Upgrade path: plain key + caller supplied a passphrase -> wrap in place.
  if (!loaded.secure && passphrase) {
    await writeKeyFileWrapped(keyPath, passphrase, loaded.dek)
    loaded = { dek: loaded.dek, secure: true }
  }

  const dek = loaded.dek
  return {
    created,
    crypto: {
      secure: loaded.secure,
      encryptBlob(logicalName: string, plaintext: Uint8Array): Uint8Array {
        const nonce = randomBytes(NONCE_LEN)
        const ct = chacha20poly1305(dek, nonce, aadFor(logicalName)).encrypt(plaintext)
        return concat(VAULT_MAGIC, nonce, ct)
      },
      decryptBlob(logicalName: string, blob: Uint8Array): Uint8Array {
        const head = VAULT_MAGIC.length
        if (
          blob.length <= head + NONCE_LEN ||
          !Buffer.from(blob.subarray(0, head)).equals(Buffer.from(VAULT_MAGIC))
        ) {
          throw new VaultError("corrupt", "not a nex vault blob")
        }
        const nonce = blob.subarray(head, head + NONCE_LEN)
        const ciphertext = blob.subarray(head + NONCE_LEN)
        try {
          return chacha20poly1305(dek, nonce, aadFor(logicalName)).decrypt(ciphertext)
        } catch {
          throw new VaultError("corrupt", `blob failed authentication: ${logicalName}`)
        }
      },
    },
  }
}
