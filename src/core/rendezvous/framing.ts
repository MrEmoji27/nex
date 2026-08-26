// Rendezvous signing: length-prefixed framing + the derived Ed25519 key.
//
// Wire contract doc/RENDEZVOUS_WIRE_V1.md §1. Two rules matter more than the rest:
//
//   1. Signing input is LENGTH-PREFIXED, never canonical JSON. Go and TypeScript
//      disagree about string escaping, number formatting, and key ordering in
//      ways that stay invisible until someone exploits them. Length prefixes make
//      the framing unambiguous without either side agreeing about JSON at all.
//   2. The signing key is DERIVED from the identity seed, so no new key material
//      lands on disk and restoring identity.json also restores this identity.
//
// The Noise audit's lesson (V3 §15) applies here: passing against the other Nex
// implementation proves nothing. tests/rendezvous-vectors.test.ts checks these
// primitives against the published RFC 8032 vectors instead.
import { ed25519 } from "@noble/curves/ed25519.js"
import { hexToBytes } from "../identity"

/** Domain separators — one per signed object. Never reuse across operations. */
export const DOMAIN = {
  publicDescriptor: "nex-rendezvous/public-descriptor-v1",
  contactDescriptor: "nex-rendezvous/contact-descriptor-v1",
  register: "nex-rendezvous/register-v1",
  refresh: "nex-rendezvous/refresh-v1",
  unregister: "nex-rendezvous/unregister-v1",
  search: "nex-rendezvous/search-v1",
  introductionRequest: "nex-rendezvous/introduction-request-v1",
  introductionRespond: "nex-rendezvous/introduction-respond-v1",
  control: "nex-rendezvous/control-v1",
} as const

/** Key-derivation label. Bumping this rotates every node's rendezvous key. */
const SIGN_KEY_LABEL = "nex-rendezvous-sign-v1"

const encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/**
 * Builds a signing input incrementally. Fields are appended in a fixed order
 * defined per-operation by the wire contract; there is no separator byte because
 * every field carries its own big-endian uint32 length.
 */
export class SigningInput {
  private readonly parts: Uint8Array[] = []
  private length = 0

  constructor(domain: string) {
    // The domain separator is raw, NOT length-prefixed: it is a constant per
    // operation, so it cannot be confused with attacker-chosen field content.
    this.push(encoder.encode(domain))
  }

  private push(bytes: Uint8Array): void {
    this.parts.push(bytes)
    this.length += bytes.length
  }

  private static u32be(n: number): Uint8Array {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n, false)
    return b
  }

  /** LP(s): uint32be(byteLength) || utf8(s). */
  str(value: string): this {
    const bytes = encoder.encode(value)
    this.push(SigningInput.u32be(bytes.length))
    this.push(bytes)
    return this
  }

  /** LPn(n): the integer's decimal representation, length-prefixed as a string. */
  int(value: number): this {
    if (!Number.isInteger(value)) throw new Error(`signing input requires an integer, got ${value}`)
    return this.str(String(value))
  }

  /** Booleans sign as the literal strings "true"/"false". */
  bool(value: boolean): this {
    return this.str(value ? "true" : "false")
  }

  /** LParr(a): uint32be(count) then each element length-prefixed, in order. */
  arr(values: readonly string[]): this {
    this.push(SigningInput.u32be(values.length))
    for (const v of values) this.str(v)
    return this
  }

  /**
   * LPcand(a): uint32be(count) then each candidate's three fields, in order.
   *
   * Candidates get their own form rather than being flattened into a delimited
   * string. An earlier draft signed "kind|host|port", which let a `|` inside a
   * host produce the same bytes as a different candidate list — signature
   * malleability, and exactly the delimiter ambiguity this whole framing exists
   * to avoid. Length prefixes all the way down; no delimiter to abuse.
   */
  candidates(values: readonly { kind: string; host: string; port: number }[]): this {
    this.push(SigningInput.u32be(values.length))
    for (const c of values) this.str(c.kind).str(c.host).int(c.port)
    return this
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }

  hex(): string {
    return bytesToHex(this.bytes())
  }
}

/** The node's rendezvous signing key. Derived, never stored, never transmitted. */
export interface RendezvousSigningKey {
  /** Ed25519 seed (RFC 8032 private key), 32 bytes. */
  readonly privSeed: Uint8Array
  /** Ed25519 public key as lowercase hex (64 chars) — the wire's `signPub`. */
  readonly signPub: string
}

/**
 * edSeed = HMAC-SHA256(key = identity seed bytes, msg = "nex-rendezvous-sign-v1")
 *
 * HMAC-as-KDF, matching the shape deriveVerifier() already uses. No new
 * primitive, and nothing extra to persist or migrate.
 */
export function deriveSigningKey(seedHex: string): RendezvousSigningKey {
  const hasher = new Bun.CryptoHasher("sha256", hexToBytes(seedHex))
  hasher.update(SIGN_KEY_LABEL)
  const privSeed = new Uint8Array(hasher.digest())
  return { privSeed, signPub: bytesToHex(ed25519.getPublicKey(privSeed)) }
}

/** Sign a built input; returns the 64-byte signature as lowercase hex. */
export function sign(input: SigningInput, key: RendezvousSigningKey): string {
  return bytesToHex(ed25519.sign(input.bytes(), key.privSeed))
}

/**
 * Verify a signature. Returns false rather than throwing on malformed hex or a
 * bad point — a peer-supplied signature failing to parse is an ordinary
 * rejection, not an exceptional condition, and must not crash a request handler.
 */
export function verify(input: SigningInput, sigHex: string, signPubHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false
  if (!/^[0-9a-f]{64}$/.test(signPubHex)) return false
  try {
    return ed25519.verify(hexToBytes(sigHex), input.bytes(), hexToBytes(signPubHex))
  } catch {
    return false
  }
}
