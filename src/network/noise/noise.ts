// Noise_XX_25519_ChaChaPoly_SHA256 — minimal, spec-faithful implementation.
//
// Implements exactly the pieces the Nex transport needs, following the Noise
// Protocol Framework specification (rev 34): CipherState, SymmetricState,
// and the XX handshake pattern. Primitives come from the audited @noble/*
// libraries; nothing cryptographic here is invented — only the framework
// bookkeeping the spec prescribes.
//
// Conformance is PROVEN, not asserted: tests/noise.test.ts replays the
// official Noise test vector for this exact protocol name (cacophony suite)
// and compares every handshake message, transport message, and the final
// handshake hash byte-for-byte. Do not change the framework bookkeeping
// below without re-running it.
//
//   XX pattern:
//   -> e
//   <- e, ee, s, es     (+ encrypted responder payload)
//   -> s, se            (+ encrypted initiator payload)
//
// Handshake payloads bind nodeId <-> static key inside the authenticated
// transcript, so after msg3 each side knows "this static key belongs to this
// nodeId" and nobody could have altered that binding in transit.
import { x25519 } from "@noble/curves/ed25519.js"
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { hkdf } from "@noble/hashes/hkdf.js"

export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256"
export const KEYLEN = 32
const TAGLEN = 16
export const EPHEM_LEN = 32
/** Encrypted static public key: 32-byte key + 16-byte Poly1305 tag. */
export const ENC_STATIC_LEN = KEYLEN + TAGLEN
const MAX_NONCE = 2 ** 64 - 1

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function generateKeypair(): KeyPair {
  return x25519.keygen()
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

/** Noise spec HKDF: n outputs of KEYLEN derived from (chainingKey, ikm). */
function noiseHkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const okm = hkdf(sha256, ikm, chainingKey, new Uint8Array(0), KEYLEN * outputs)
  const result: Uint8Array[] = []
  for (let i = 0; i < outputs; i++) result.push(okm.slice(i * KEYLEN, (i + 1) * KEYLEN))
  return result
}

/** Nonce encoding per spec: 32 zero bits || little-endian uint64 counter. */
function noiseNonce(counter: number): Uint8Array {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), true)
  return nonce
}

export class CipherState {
  private key: Uint8Array | null = null
  private nonceCounter = 0

  initializeKey(key: Uint8Array | null): void {
    this.key = key ? key.slice() : null
    this.nonceCounter = 0
  }

  get hasKey(): boolean {
    return this.key !== null
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.key) return plaintext
    if (this.nonceCounter >= MAX_NONCE) throw new Error("noise: nonce exhausted")
    const cipher = chacha20poly1305(this.key, noiseNonce(this.nonceCounter), ad)
    this.nonceCounter++
    return cipher.encrypt(plaintext)
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.key) return ciphertext
    if (this.nonceCounter >= MAX_NONCE) throw new Error("noise: nonce exhausted")
    // Counter advances only on successful authentication (spec requirement).
    const plaintext = chacha20poly1305(this.key, noiseNonce(this.nonceCounter), ad).decrypt(ciphertext)
    this.nonceCounter++
    return plaintext
  }
}

class SymmetricState {
  chainingKey!: Uint8Array
  hashValue!: Uint8Array
  readonly cipherState = new CipherState()

  initialize(protocolName: string): void {
    const nameBytes = new TextEncoder().encode(protocolName)
    this.hashValue =
      nameBytes.length <= 32 ? concat(nameBytes, new Uint8Array(32 - nameBytes.length)) : sha256(nameBytes)
    this.chainingKey = this.hashValue.slice()
    this.cipherState.initializeKey(null)
  }

  /** Spec 5.2: ck, temp_k = HKDF(ck, ikm, 2) — DISTINCT outputs. */
  mixKey(ikm: Uint8Array): void {
    const [nextCk, tempK] = noiseHkdf(this.chainingKey, ikm, 2)
    this.chainingKey = nextCk!
    this.cipherState.initializeKey(tempK!)
  }

  mixHash(data: Uint8Array): void {
    this.hashValue = sha256(concat(this.hashValue, data))
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipherState.encryptWithAd(this.hashValue, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipherState.decryptWithAd(this.hashValue, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  split(): { c1: CipherState; c2: CipherState } {
    const [tempK1, tempK2] = noiseHkdf(this.chainingKey, new Uint8Array(0), 2)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(tempK1!)
    c2.initializeKey(tempK2!)
    return { c1, c2 }
  }

  getHandshakeHash(): Uint8Array {
    return this.hashValue.slice()
  }
}

function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey)
}

export interface HandshakeResult {
  /** Decrypted payload carried by the peer's final handshake message. */
  remotePayload: Uint8Array
  /** Traffic key for messages WE send. */
  send: CipherState
  /** Traffic key for messages the PEER sends. */
  receive: CipherState
  /** Peer long-term static public key — authenticity proven by the transcript. */
  remoteStaticKey: Uint8Array
  /** SHA-256 over the completed handshake transcript (channel binding). */
  handshakeHash: Uint8Array
}

/**
 * One side of a Noise_XX exchange.
 *
 *   initiator: const m1 = hs.start(); send(m1)
 *              hs.setNextPayload(initiatorPayload)
 *              const m3 = hs.feed(m2); send(m3)
 *              hs.result
 *   responder: const m2 = hs.feed(m1); send(m2)      // payload via setNextPayload BEFORE feed
 *              hs.setNextPayload(responderPayload)   // (payload rides m2)
 *              ...
 */
export class NoiseHandshake {
  private readonly ss = new SymmetricState()
  private readonly s: KeyPair
  private readonly e: KeyPair
  private re: Uint8Array | null = null
  private rs: Uint8Array | null = null
  private step = 0
  private resultValue: HandshakeResult | null = null
  private nextPayload: Uint8Array = new Uint8Array(0)
  private firstPayload: Uint8Array = new Uint8Array(0)

  /**
   * @param prologue mixed into the transcript before any message; both sides
   *   must agree or the handshake fails.
   * @param fixedEphemeral TEST ONLY — pins the ephemeral keypair so official
   *   Noise test vectors can be replayed. Production callers MUST omit it;
   *   a reused ephemeral destroys forward secrecy.
   */
  constructor(
    private readonly role: "initiator" | "responder",
    staticSecret: Uint8Array,
    prologue: string,
    fixedEphemeral?: Uint8Array,
  ) {
    if (staticSecret.length !== KEYLEN) throw new Error("noise: static key must be 32 bytes")
    if (fixedEphemeral && fixedEphemeral.length !== KEYLEN) throw new Error("noise: ephemeral must be 32 bytes")
    this.s = { secretKey: staticSecret.slice(), publicKey: x25519.getPublicKey(staticSecret) }
    this.e = fixedEphemeral
      ? { secretKey: fixedEphemeral.slice(), publicKey: x25519.getPublicKey(fixedEphemeral) }
      : generateKeypair()
    this.ss.initialize(NOISE_PROTOCOL_NAME)
    this.ss.mixHash(new TextEncoder().encode(prologue))
  }

  /** Payload the peer carried in msg1 (responder side). Empty for Nex traffic. */
  get remoteFirstPayload(): Uint8Array {
    return this.firstPayload.slice()
  }

  get result(): HandshakeResult {
    if (!this.resultValue) throw new Error("noise: handshake not complete")
    return this.resultValue
  }

  get complete(): boolean {
    return this.resultValue !== null
  }

  /** True while this side has not yet processed its first inbound message. */
  get awaitingFirstMessage(): boolean {
    return this.step === 0
  }

  /** Payload carried (encrypted) by our NEXT outgoing handshake message. */
  setNextPayload(payload: Uint8Array): void {
    if (this.step > 1) throw new Error("noise: too late to set payload")
    this.nextPayload = payload
  }

  /**
   * Process an incoming handshake message; returns the reply to send, or null
   * when the handshake just completed on THIS side. Throws on any tampering,
   * truncation, or authentication failure (caller must drop the connection).
   */
  feed(message: Uint8Array): Uint8Array | null {
    if (this.resultValue) throw new Error("noise: handshake already complete")
    if (this.role === "initiator") {
      if (this.step === 0) throw new Error("noise: initiator must call start() first")
      if (this.step === 1) return this.initiatorReadMessage2(message)
      throw new Error("noise: unexpected message")
    }
    if (this.step === 0) return this.responderHandleMessage1(message)
    if (this.step === 1) return this.responderHandleMessage3(message)
    throw new Error("noise: unexpected message")
  }

  /**
   * Message 1 (initiator only): "-> e" + payload.
   * No key exists yet, so EncryptAndHash passes the payload through in the
   * clear — but it still MixHashes it, which is why the call cannot be
   * skipped even when the payload is empty (spec 5.3).
   */
  start(): Uint8Array {
    if (this.role !== "initiator" || this.step !== 0) throw new Error("noise: unexpected start()")
    this.ss.mixHash(this.e.publicKey)
    const payload = this.ss.encryptAndHash(this.nextPayload)
    this.nextPayload = new Uint8Array(0)
    this.step = 1
    return concat(this.e.publicKey, payload)
  }

  // ---------- responder ----------

  /** msg1 "-> e": learn remote ephemeral, reply "<- e, ee, s, es" + payload. */
  private responderHandleMessage1(message: Uint8Array): Uint8Array {
    if (message.length < EPHEM_LEN) throw new Error("noise: bad msg1 length")
    this.re = message.slice(0, EPHEM_LEN)
    this.ss.mixHash(this.re)
    this.firstPayload = this.ss.decryptAndHash(message.slice(EPHEM_LEN))

    // <- e
    this.ss.mixHash(this.e.publicKey)
    // ee
    this.ss.mixKey(dh(this.e.secretKey, this.re))
    // s
    const sCiphertext = this.ss.encryptAndHash(this.s.publicKey)
    // es (responder computes DH(s, re))
    this.ss.mixKey(dh(this.s.secretKey, this.re))

    const payloadCiphertext = this.ss.encryptAndHash(this.nextPayload)
    this.nextPayload = new Uint8Array(0)
    this.step = 1
    return concat(this.e.publicKey, sCiphertext, payloadCiphertext)
  }

  /** msg3 "-> s, se" + payload: finish the handshake. */
  private responderHandleMessage3(message: Uint8Array): Uint8Array | null {
    if (message.length < ENC_STATIC_LEN) throw new Error("noise: bad msg3 length")
    const rs = this.ss.decryptAndHash(message.slice(0, ENC_STATIC_LEN))
    this.rs = rs
    // se (responder computes DH(e, rs))
    this.ss.mixKey(dh(this.e.secretKey, rs))
    const remotePayload = this.ss.decryptAndHash(message.slice(ENC_STATIC_LEN))

    const split = this.ss.split()
    this.resultValue = {
      remotePayload,
      // Spec Split(): c1 encrypts initiator->responder traffic.
      send: split.c2!,
      receive: split.c1!,
      remoteStaticKey: rs.slice(),
      handshakeHash: this.ss.getHandshakeHash(),
    }
    return null
  }

  // ---------- initiator ----------

  /** msg2 "<- e, ee, s, es": verify responder, build msg3 "-> s, se" + payload. */
  private initiatorReadMessage2(message: Uint8Array): Uint8Array {
    if (message.length < EPHEM_LEN + ENC_STATIC_LEN) throw new Error("noise: bad msg2 length")
    let offset = 0

    // e
    this.re = message.slice(offset, offset + EPHEM_LEN)
    offset += EPHEM_LEN
    this.ss.mixHash(this.re)
    // ee
    this.ss.mixKey(dh(this.e.secretKey, this.re))
    // s
    this.rs = this.ss.decryptAndHash(message.slice(offset, offset + ENC_STATIC_LEN))
    offset += ENC_STATIC_LEN
    // es (initiator receiving: DH(e, rs) per spec)
    this.ss.mixKey(dh(this.e.secretKey, this.rs))
    const remotePayload = this.ss.decryptAndHash(message.slice(offset))

    // -> s, se
    const sCiphertext = this.ss.encryptAndHash(this.s.publicKey)
    // se (initiator computes DH(s, re))
    this.ss.mixKey(dh(this.s.secretKey, this.re))
    const payloadCiphertext = this.ss.encryptAndHash(this.nextPayload)

    const split = this.ss.split()
    this.resultValue = {
      remotePayload,
      send: split.c1!,
      receive: split.c2!,
      remoteStaticKey: this.rs.slice(),
      handshakeHash: this.ss.getHandshakeHash(),
    }
    return concat(sCiphertext, payloadCiphertext)
  }
}
