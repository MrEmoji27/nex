// Vault crypto unit tests: envelope roundtrip, failure modes, upgrade path.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveKek, openVaultKey, VaultError } from "../src/core/state/vault"

const dirs: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nex-vault-test-"))
  dirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

describe("vault key file", () => {
  test("fresh + passphrase -> wrapped key; unlock works; secure=true", async () => {
    const dir = await tmp()
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"), "correct horse battery")
    expect(vault.secure).toBe(true)

    const { crypto: reopened } = await openVaultKey(join(dir, "vault.key"), "correct horse battery")
    expect(reopened.secure).toBe(true)
    // Same DEK: blob from first handle opens with the second.
    const blob = vault.encryptBlob("identity", new TextEncoder().encode("secret"))
    expect(new TextDecoder().decode(reopened.decryptBlob("identity", blob))).toBe("secret")
  })

  test("wrong passphrase fails closed with wrong-passphrase code", async () => {
    const dir = await tmp()
    await openVaultKey(join(dir, "vault.key"), "right")
    try {
      await openVaultKey(join(dir, "vault.key"), "wrong")
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError)
      expect((err as VaultError).code).toBe("wrong-passphrase")
    }
  })

  test("missing passphrase on encrypted vault refuses with guidance", async () => {
    const dir = await tmp()
    await openVaultKey(join(dir, "vault.key"), "set-me")
    try {
      await openVaultKey(join(dir, "vault.key"))
      throw new Error("should have thrown")
    } catch (err) {
      expect((err as VaultError).code).toBe("wrong-passphrase")
      expect((err as Error).message).toMatch(/--passphrase/)
    }
  })

  test("plain mode is created without passphrase and upgrades in place later", async () => {
    const dir = await tmp()
    const keyPath = join(dir, "vault.key")
    const { crypto: plain } = await openVaultKey(keyPath)
    expect(plain.secure).toBe(false)
    const blob = plain.encryptBlob("peers", new TextEncoder().encode(`[{"name":"Cku"}]`))

    // Upgrade with a passphrase keeps the SAME dek: old blobs still decrypt.
    const { crypto: upgraded } = await openVaultKey(keyPath, "now-locked")
    expect(upgraded.secure).toBe(true)
    expect(new TextDecoder().decode(upgraded.decryptBlob("peers", blob))).toBe(`[{"name":"Cku"}]`)
    // And the file on disk no longer carries the plain magic.
    const raw = await readFile(keyPath)
    expect(raw.subarray(0, 12).toString()).toBe("NEXVAULTKEY1")
  })
})

describe("vault envelopes", () => {
  test("roundtrip preserves bytes; unique nonces per call", async () => {
    const dir = await tmp()
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"), "p")
    const data = new Uint8Array(1000).map((_, i) => i % 251)
    const a = vault.encryptBlob("conversations/x", data)
    const b = vault.encryptBlob("conversations/x", data)
    expect(Buffer.from(a)).not.toEqual(Buffer.from(b)) // fresh nonce
    expect(Buffer.from(vault.decryptBlob("conversations/x", a))).toEqual(Buffer.from(data))
  })

  test("bit-flipped ciphertext is rejected as corrupt", async () => {
    const dir = await tmp()
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"), "p")
    const blob = vault.encryptBlob("identity", new TextEncoder().encode("seed material"))
    blob[blob.length - 3]! ^= 0x10
    expect(() => vault.decryptBlob("identity", blob)).toThrow(VaultError)
  })

  test("blobs are name-bound: swapping between logical files fails", async () => {
    const dir = await tmp()
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"), "p")
    const identityBlob = vault.encryptBlob("identity", new TextEncoder().encode("i"))
    const peersBlob = vault.encryptBlob("peers", new TextEncoder().encode("p"))
    expect(() => vault.decryptBlob("peers", identityBlob)).toThrow(VaultError)
    expect(() => vault.decryptBlob("identity", peersBlob)).toThrow(VaultError)
  })

  test("non-vault garbage is rejected", async () => {
    const dir = await tmp()
    const { crypto: vault } = await openVaultKey(join(dir, "vault.key"), "p")
    const junk = new TextEncoder().encode(`[{"peerId":"cleartext"}]`)
    expect(() => vault.decryptBlob("identity", junk)).toThrow(VaultError)
  })

  test("argon2 params are interactive-cheap enough to derive twice per boot", () => {
    const salt = new Uint8Array(16).fill(9)
    expect(deriveKek("a", salt).length).toBe(32)
    expect(Buffer.from(deriveKek("a", salt)).equals(Buffer.from(deriveKek("b", salt)))).toBe(false)
  })
})
