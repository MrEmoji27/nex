// Known-answer conformance test for Noise_XX_25519_ChaChaPoly_SHA256.
//
// The vector below is the official entry for this exact protocol name from the
// cacophony test-vector suite (github.com/mcginty/snow, tests/vectors/cacophony.txt),
// the same corpus every mainstream Noise implementation validates against.
//
// This is the test that makes the name on the wire honest. Nex's own handshake
// tests are self-consistent: they pass whether or not the framework bookkeeping
// matches the spec, because both sides run the same code. Only a foreign vector
// can catch a symmetric mistake — and an earlier revision of noise.ts had three
// (MixKey reusing one HKDF output for both ck and k, DH tokens calling
// MixKeyAndHash instead of MixKey, and msg1 skipping EncryptAndHash on an empty
// payload). Each was invisible in-house and fatal to interoperability.
import { describe, expect, test } from "bun:test"
import { NoiseHandshake } from "../src/network/noise/noise"

const VECTOR = {
  protocol_name: "Noise_XX_25519_ChaChaPoly_SHA256",
  init_prologue: "4a6f686e2047616c74",
  init_static: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  init_ephemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  resp_static: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  resp_ephemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  handshake_hash: "c8e5f64e846193be2a834104c2a009868d6c9f3bd3c186299888b488b2f1f58e",
  messages: [
    {
      payload: "4c756477696720766f6e204d69736573",
      ciphertext:
        "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573",
    },
    {
      payload: "4d757272617920526f746862617264",
      ciphertext:
        "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884381cbad1f276e038c48378ffce2b65285e08d6b68aaa3629a5a8639392490e5b9bd5269c2f1e4f488ed8831161f19b7815528f8982ffe09be9b5c412f8a0db50f8814c7194e83f23dbd8d162c9326ad",
    },
    {
      payload: "462e20412e20486179656b",
      ciphertext:
        "c7195ffacac1307ff99046f219750fc47693e23c3cb08b89c2af808b444850a80ae475b9df0f169ae80a89be0865b57f58c9fea0d4ec82a286427402f113e4b6ae769a1d95941d49b25030",
    },
    {
      payload: "4361726c204d656e676572",
      ciphertext: "96763ed773f8e47bb3712f0e29b3060ffc956ffc146cee53d5e1df",
    },
    {
      payload: "4a65616e2d426170746973746520536179",
      ciphertext: "3e40f15f6f3a46ae446b253bf8b1d9ffb6ed9b174d272328ff91a7e2e5c79c07f5",
    },
    {
      payload: "457567656e2042f6686d20766f6e2042617765726b",
      ciphertext: "eb3f3515110702e047a6c9da4478b6ead94873c11c0f2d710ddb3f09fce024b3a58502ae3f",
    },
  ],
} as const

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

/** The vector's prologue is ASCII ("John Galt"); our constructor takes a string. */
const PROLOGUE = new TextDecoder().decode(fromHex(VECTOR.init_prologue))

describe("Noise_XX official test vector (cacophony)", () => {
  test("every handshake message matches the vector byte-for-byte", () => {
    const init = new NoiseHandshake(
      "initiator",
      fromHex(VECTOR.init_static),
      PROLOGUE,
      fromHex(VECTOR.init_ephemeral),
    )
    const resp = new NoiseHandshake(
      "responder",
      fromHex(VECTOR.resp_static),
      PROLOGUE,
      fromHex(VECTOR.resp_ephemeral),
    )

    // msg1: -> e, payload (no key yet, so the payload rides in the clear)
    init.setNextPayload(fromHex(VECTOR.messages[0].payload))
    const m1 = init.start()
    expect(toHex(m1)).toBe(VECTOR.messages[0].ciphertext)

    // msg2: <- e, ee, s, es + payload
    resp.setNextPayload(fromHex(VECTOR.messages[1].payload))
    const m2 = resp.feed(m1)!
    expect(toHex(m2)).toBe(VECTOR.messages[1].ciphertext)
    expect(toHex(resp.remoteFirstPayload)).toBe(VECTOR.messages[0].payload)

    // msg3: -> s, se + payload
    init.setNextPayload(fromHex(VECTOR.messages[2].payload))
    const m3 = init.feed(m2)!
    expect(toHex(m3)).toBe(VECTOR.messages[2].ciphertext)
    expect(toHex(init.result.remotePayload)).toBe(VECTOR.messages[1].payload)

    expect(resp.feed(m3)).toBeNull()
    expect(toHex(resp.result.remotePayload)).toBe(VECTOR.messages[2].payload)

    // Channel binding: our transcript hash is the one the rest of the world computes.
    expect(toHex(init.result.handshakeHash)).toBe(VECTOR.handshake_hash)
    expect(toHex(resp.result.handshakeHash)).toBe(VECTOR.handshake_hash)

    // Post-split transport messages. The vector format continues the SAME
    // strict alternation the handshake established, so parity is taken over
    // the absolute index: even = initiator speaking, odd = responder. (msg1
    // and msg3 were the initiator, msg2 the responder — index 3 is therefore
    // the responder, not the initiator.)
    for (const [i, msg] of VECTOR.messages.entries()) {
      if (i < 3) continue
      const fromInitiator = i % 2 === 0
      const sender = fromInitiator ? init.result.send : resp.result.send
      const receiver = fromInitiator ? resp.result.receive : init.result.receive
      const ct = sender.encryptWithAd(new Uint8Array(0), fromHex(msg.payload))
      expect(toHex(ct)).toBe(msg.ciphertext)
      expect(toHex(receiver.decryptWithAd(new Uint8Array(0), ct))).toBe(msg.payload)
    }
  })

  test("the protocol name we advertise is the one we implement", async () => {
    const { NOISE_PROTOCOL_NAME } = await import("../src/network/noise/noise")
    expect(NOISE_PROTOCOL_NAME).toBe(VECTOR.protocol_name)
  })
})
