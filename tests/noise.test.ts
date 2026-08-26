// Unit tests for the Noise_XX state machine (spec conformance + failure modes).
import { describe, expect, test } from "bun:test"
import { CipherState, NoiseHandshake, generateKeypair } from "../src/network/noise/noise"

const PROLOGUE = "nex-tcp-v3"
const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

interface RawExchange {
  init: NoiseHandshake
  resp: NoiseHandshake
  m1: Uint8Array
  m2: Uint8Array
  m3: Uint8Array
  iStaticPub: Uint8Array
  rStaticPub: Uint8Array
}

function rawExchange(): RawExchange {
  const iStatic = generateKeypair()
  const rStatic = generateKeypair()
  const init = new NoiseHandshake("initiator", iStatic.secretKey, PROLOGUE)
  const resp = new NoiseHandshake("responder", rStatic.secretKey, PROLOGUE)

  const m1 = init.start()
  resp.setNextPayload(enc("r-payload"))
  const m2 = resp.feed(m1)!
  init.setNextPayload(enc("i-payload"))
  const m3 = init.feed(m2)!
  resp.feed(m3)
  return { init, resp, m1, m2, m3, iStaticPub: iStatic.publicKey, rStaticPub: rStatic.publicKey }
}

function makePair() {
  return rawExchange()
}

describe("Noise_XX happy path", () => {
  test("handshake completes; payloads and static keys arrive intact", () => {
    const { init, resp, iStaticPub, rStaticPub } = makePair()

    expect(init.complete).toBe(true)
    expect(resp.complete).toBe(true)
    expect(dec(init.result.remotePayload)).toBe("r-payload")
    expect(dec(resp.result.remotePayload)).toBe("i-payload")
    expect(Buffer.from(init.result.remoteStaticKey).equals(Buffer.from(rStaticPub))).toBe(true)
    expect(Buffer.from(resp.result.remoteStaticKey).equals(Buffer.from(iStaticPub))).toBe(true)
  })

  test("both sides derive identical handshake hash (channel binding)", () => {
    const { init, resp } = makePair()
    expect(Buffer.from(init.result.handshakeHash).equals(Buffer.from(resp.result.handshakeHash))).toBe(true)
  })

  test("transport messages decrypt both directions; counters advance independently", () => {
    const { init, resp } = makePair()
    for (let i = 0; i < 5; i++) {
      const ct = init.result.send.encryptWithAd(new Uint8Array(0), enc(`msg-${i}`))
      expect(dec(resp.result.receive.decryptWithAd(new Uint8Array(0), ct))).toBe(`msg-${i}`)
    }
    const reply = resp.result.send.encryptWithAd(new Uint8Array(0), enc("reply"))
    expect(dec(init.result.receive.decryptWithAd(new Uint8Array(0), reply))).toBe("reply")
  })

  test("associated data is authenticated", () => {
    const { init, resp } = makePair()
    const ct = init.result.send.encryptWithAd(enc("ad-ok"), enc("secret"))
    expect(() => resp.result.receive.decryptWithAd(enc("ad-bad"), ct)).toThrow()
    // Failed receive did NOT advance the counter: same frame still opens.
    expect(dec(resp.result.receive.decryptWithAd(enc("ad-ok"), ct))).toBe("secret")
  })
})

describe("Noise_XX failure modes", () => {
  test("tampered msg2 encrypted-static section -> initiator throws", () => {
    const iStatic = generateKeypair().secretKey
    const rStatic = generateKeypair().secretKey
    const init = new NoiseHandshake("initiator", iStatic, PROLOGUE)
    const resp = new NoiseHandshake("responder", rStatic, PROLOGUE)
    const m2 = resp.feed(init.start())!
    const tampered = m2.slice()
    tampered[35]! ^= 0xff // inside the encrypted static key block
    expect(() => init.feed(tampered)).toThrow()
  })

  test("truncated msg3 -> responder throws", () => {
    const ex = rawExchange()
    // Fresh responder sees m1 -> m2, then a cut-off m3.
    const iStatic = generateKeypair().secretKey
    const freshInit = new NoiseHandshake("initiator", iStatic, PROLOGUE)
    void freshInit.start()
    void ex
    const resp = new NoiseHandshake("responder", generateKeypair().secretKey, PROLOGUE)
    const m2 = resp.feed(ex.m1)!
    void m2
    const cut = ex.m3.slice(0, ex.m3.length - 5)
    expect(() => resp.feed(cut)).toThrow()
  })

  test("msg3 payload tampering -> responder throws", () => {
    const ex = rawExchange()
    const resp = new NoiseHandshake("responder", generateKeypair().secretKey, PROLOGUE)
    resp.feed(ex.m1)
    const tampered = ex.m3.slice()
    tampered[tampered.length - 1]! ^= 0x01 // flip bit in payload tag region
    expect(() => resp.feed(tampered)).toThrow()
  })

  test("wrong prologue -> handshake fails", () => {
    const init = new NoiseHandshake("initiator", generateKeypair().secretKey, PROLOGUE)
    const resp = new NoiseHandshake("responder", generateKeypair().secretKey, "other-prologue")
    const m2 = resp.feed(init.start())!
    expect(() => init.feed(m2)).toThrow()
  })

  test("replayed ciphertext frame is rejected (nonce mismatch)", () => {
    const { init, resp } = makePair()
    const ct = init.result.send.encryptWithAd(new Uint8Array(0), enc("once"))
    resp.result.receive.decryptWithAd(new Uint8Array(0), ct)
    expect(() => resp.result.receive.decryptWithAd(new Uint8Array(0), ct)).toThrow()
  })

  test("bit-flipped transport frame is rejected", () => {
    const { init, resp } = makePair()
    const ct = init.result.send.encryptWithAd(new Uint8Array(0), enc("payload"))
    ct[ct.length - 1]! ^= 0x01
    expect(() => resp.result.receive.decryptWithAd(new Uint8Array(0), ct)).toThrow()
  })

  test("strict counter: replays rejected, stream advances exactly once", () => {
    const { init, resp } = makePair()
    const recv = resp.result.receive
    const c1 = init.result.send.encryptWithAd(new Uint8Array(0), enc("first"))
    const c2 = init.result.send.encryptWithAd(new Uint8Array(0), enc("second"))

    expect(dec(recv.decryptWithAd(new Uint8Array(0), c1))).toBe("first")
    // Frame #1 again -> already-consumed nonce -> rejected.
    expect(() => recv.decryptWithAd(new Uint8Array(0), c1)).toThrow()
    // Stream continues strictly forward.
    expect(dec(recv.decryptWithAd(new Uint8Array(0), c2))).toBe("second")
  })
})

describe("CipherState without key", () => {
  test("pre-key state passes plaintext through (spec InitializeKey(empty))", () => {
    const cs = new CipherState()
    cs.initializeKey(null)
    const pt = enc("plain")
    expect(cs.encryptWithAd(new Uint8Array(0), pt)).toEqual(pt)
    expect(cs.decryptWithAd(new Uint8Array(0), pt)).toEqual(pt)
  })
})
