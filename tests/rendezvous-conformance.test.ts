// Cross-implementation conformance: TypeScript against the frozen vectors.
//
// rendezvous/testdata/vectors.json is the source of truth, not this file and not the
// Go service. The vectors were produced by two implementations written
// independently against the contract and confirmed to agree byte for byte; both
// sides now assert against the recorded result, so a later divergence fails a
// test here rather than surfacing as an interop bug nobody can reproduce.
//
// If an assertion in this file fails, the implementation changed. Fix the code,
// not the vectors.
import { describe, expect, test } from "bun:test"
import vectors from "../rendezvous/testdata/vectors.json"
import { DOMAIN, SigningInput, deriveSigningKey, sign, verify } from "../src/core/rendezvous/framing"
import { normalizeHandle } from "../src/core/rendezvous/descriptor"

const key = deriveSigningKey(vectors.identitySeedHex)

function publicInput(): SigningInput {
  const d = vectors.publicDescriptor
  return new SigningInput(DOMAIN.publicDescriptor)
    .str(String(d.v))
    .str(d.handle)
    .str(d.nodeId)
    .str(d.signPub)
    .arr(d.capabilities)
    .int(d.issuedAt)
    .int(d.expiresAt)
    .bool(d.connectable)
}

function contactInput(candidates: ReadonlyArray<{ kind: string; host: string; port: number }>): SigningInput {
  const d = vectors.contactDescriptor
  return new SigningInput(DOMAIN.contactDescriptor)
    .str(String(d.v))
    .str(d.handle)
    .str(d.nodeId)
    .str(d.signPub)
    .str(d.noisePub)
    .arr(d.capabilities)
    .candidates(candidates)
    .int(d.issuedAt)
    .int(d.expiresAt)
}

describe("conformance with rendezvous/testdata/vectors.json", () => {
  test("the derived signing key matches the recorded signPub", () => {
    expect(key.signPub).toBe(vectors.signPub)
  })

  test("the derivation label has not drifted", () => {
    // A silent label change would rotate every node's rendezvous identity and
    // look exactly like a service-side outage.
    expect(vectors.signKeyDerivationLabel).toBe("nex-rendezvous-sign-v1")
  })

  test("public descriptor signing input matches", () => {
    expect(publicInput().hex()).toBe(vectors.publicDescriptor.signingInputHex)
  })

  test("public descriptor signature matches", () => {
    expect(sign(publicInput(), key)).toBe(vectors.publicDescriptor.signatureHex)
  })

  test("contact descriptor signing input matches, including '|' in kind and host", () => {
    expect(contactInput(vectors.contactDescriptor.candidates).hex()).toBe(
      vectors.contactDescriptor.signingInputHex,
    )
  })

  test("contact descriptor signature matches", () => {
    expect(sign(contactInput(vectors.contactDescriptor.candidates), key)).toBe(
      vectors.contactDescriptor.signatureHex,
    )
  })

  test("the recorded signatures verify under the recorded key", () => {
    expect(verify(publicInput(), vectors.publicDescriptor.signatureHex, vectors.signPub)).toBe(true)
    expect(
      verify(contactInput(vectors.contactDescriptor.candidates), vectors.contactDescriptor.signatureHex, vectors.signPub),
    ).toBe(true)
  })

  test("Amendment 1 regression: two candidate splits do NOT collide", () => {
    // Under the pre-amendment "kind|host|port" flattening these two arrays
    // produced identical signing input, which made candidate signing malleable.
    // LPcand gives every field its own length prefix, so they must differ.
    const a = contactInput(vectors.contactDescriptor.candidates).hex()
    const b = contactInput(vectors.contactDescriptorCollision.candidates).hex()
    expect(a).not.toBe(b)
    expect(b).toBe(vectors.contactDescriptorCollision.signingInputHex)
  })

  test("a signature over one candidate split does not verify over the other", () => {
    const signed = sign(contactInput(vectors.contactDescriptor.candidates), key)
    expect(verify(contactInput(vectors.contactDescriptorCollision.candidates), signed, vectors.signPub)).toBe(false)
  })
})

describe("handle normalization agrees with the Go service", () => {
  // Contract §2 step 1 says ASCII whitespace. JS .trim() also strips Unicode
  // whitespace, so this used to accept handles the Go service rejected —
  // found by an independent audit pass.
  const nonAsciiWhitespace = ["\u00A0", "\u2028", "\u2029", "\u3000", "\u200A"]

  for (const ws of nonAsciiWhitespace) {
    const code = `U+${ws.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    test(`${code} is not trimmed, so the handle is refused as Go refuses it`, () => {
      expect(normalizeHandle(`${ws}roshan`)).toBe(null)
      expect(normalizeHandle(`roshan${ws}`)).toBe(null)
    })
  }

  test("ASCII whitespace is still trimmed", () => {
    for (const ws of [" ", "\t", "\n", "\r", "\v", "\f"]) {
      expect(normalizeHandle(`${ws}roshan${ws}`)).toBe("roshan")
    }
  })

  test("the §2.1 vector table still holds", () => {
    expect(normalizeHandle("roshan")).toBe("roshan")
    expect(normalizeHandle("  Roshan  ")).toBe("roshan")
    expect(normalizeHandle("ROSHAN")).toBe("roshan")
    expect(normalizeHandle("zro-2")).toBe("zro-2")
    expect(normalizeHandle("ro")).toBe(null)
    expect(normalizeHandle("_roshan")).toBe(null)
    expect(normalizeHandle("roshan!")).toBe(null)
    expect(normalizeHandle("a".repeat(33))).toBe(null)
  })
})
