// Sealed contact details.
//
// The property that matters: the rendezvous service relays this blob and must
// not be able to read it. Everything here is aimed at that claim.
import { describe, expect, test } from "bun:test"
import { open, seal, sealingKeyFromSignPub } from "../src/core/rendezvous/seal"
import { deriveSigningKey } from "../src/core/rendezvous/framing"

const RECIPIENT_SEED = "bb".repeat(32)
const OTHER_SEED = "cc".repeat(32)

const recipient = deriveSigningKey(RECIPIENT_SEED)
const other = deriveSigningKey(OTHER_SEED)

const SECRET = JSON.stringify({ candidates: [{ kind: "direct-tcp", host: "203.0.113.9", port: 42001 }] })

describe("sealed contact", () => {
  test("the recipient can open it", () => {
    const sealed = seal(SECRET, recipient.signPub)
    expect(open(sealed, RECIPIENT_SEED, recipient.signPub)).toBe(SECRET)
  })

  test("nobody else can, even holding the ciphertext", () => {
    const sealed = seal(SECRET, recipient.signPub)
    // This is the rendezvous service's position exactly: it has the blob and
    // the recipient's public key, and neither helps.
    expect(open(sealed, OTHER_SEED, other.signPub)).toBe(null)
  })

  test("the address does not appear in the ciphertext", () => {
    const sealed = seal(SECRET, recipient.signPub)
    const asText = Buffer.from(sealed, "hex").toString("latin1")
    expect(asText).not.toContain("203.0.113.9")
    expect(sealed).not.toContain("42001")
  })

  test("a tampered blob does not open", () => {
    const sealed = seal(SECRET, recipient.signPub)
    // Flip one byte in the ciphertext body, past the ephemeral key.
    const bytes = Buffer.from(sealed, "hex")
    bytes[40] = bytes[40]! ^ 0x01
    expect(open(bytes.toString("hex"), RECIPIENT_SEED, recipient.signPub)).toBe(null)
  })

  test("a swapped ephemeral key does not open", () => {
    const a = Buffer.from(seal(SECRET, recipient.signPub), "hex")
    const b = Buffer.from(seal(SECRET, recipient.signPub), "hex")
    // Take one seal's ephemeral key and another's ciphertext.
    const spliced = Buffer.concat([a.subarray(0, 32), b.subarray(32)])
    expect(open(spliced.toString("hex"), RECIPIENT_SEED, recipient.signPub)).toBe(null)
  })

  test("every seal of the same text differs", () => {
    // A fresh ephemeral key each time is what makes the fixed nonce safe.
    const seals = new Set([0, 1, 2, 3, 4].map(() => seal(SECRET, recipient.signPub)))
    expect(seals.size).toBe(5)
  })

  test("truncated and empty input return null rather than throwing", () => {
    expect(open("", RECIPIENT_SEED, recipient.signPub)).toBe(null)
    expect(open("aabb", RECIPIENT_SEED, recipient.signPub)).toBe(null)
    expect(open("00".repeat(40), RECIPIENT_SEED, recipient.signPub)).toBe(null)
  })

  test("the sealing key is derived from the published signing key", () => {
    // No second key to distribute; the one search already returns is enough.
    expect(sealingKeyFromSignPub(recipient.signPub).length).toBe(32)
  })
})
