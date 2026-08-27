// Sealed contact details.
//
// The rendezvous service holds your contact descriptor — address and port —
// in plaintext while your lease is alive, and relays it when you accept an
// introduction. It never logs it and it lapses in ninety seconds, but "we do
// not look" is a promise, and this project's whole argument is that promises
// are the thing you should not have to accept.
//
// So the address is sealed to the recipient before it is handed over. The
// service relays a blob it cannot read. Only the person who accepted the
// introduction can open it.
//
// Construction is the standard sealed box: an ephemeral X25519 key per seal,
// agreed against the recipient's long-term key, with the shared secret bound to
// both public keys so a ciphertext cannot be replayed at a different recipient.
// A fresh ephemeral key per message means the nonce can be fixed without ever
// repeating a key/nonce pair.

import { x25519, ed25519 } from "@noble/curves/ed25519.js"
import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { hexToBytes } from "../identity"
import { bytesToHex, deriveSigningKey } from "./framing"

const DOMAIN = "nex-rendezvous/sealed-contact-v1"

/**
 * Recipients are found by search, which returns their Ed25519 signing key. That
 * key already carries their identity and is already verified, so the seal is
 * addressed to its X25519 equivalent rather than introducing a second key that
 * would need its own distribution and its own trust story.
 */
export function sealingKeyFromSignPub(signPubHex: string): Uint8Array {
  return ed25519.utils.toMontgomery(hexToBytes(signPubHex))
}

function sealingSecretFromSeed(seedHex: string): Uint8Array {
  // The Ed25519 private key is HMAC(seed, label), NOT the seed itself. Passing
  // the raw seed here produced a secret whose Montgomery public half did not
  // match the published signing key, so the recipient could not open their own
  // mail. Derive the same private scalar the signer uses, then convert that.
  return ed25519.utils.toMontgomerySecret(deriveSigningKey(seedHex).privSeed)
}

/**
 * Bind the shared secret to both parties. Without this a ciphertext could be
 * lifted and presented to a different recipient who happened to agree the same
 * secret through some other path.
 */
function deriveKey(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const input = new Uint8Array(DOMAIN.length + shared.length + ephPub.length + recipientPub.length)
  let off = 0
  input.set(new TextEncoder().encode(DOMAIN), off)
  off += DOMAIN.length
  input.set(shared, off)
  off += shared.length
  input.set(ephPub, off)
  off += ephPub.length
  input.set(recipientPub, off)
  return sha256(input)
}

/** Fixed, and safe: the ephemeral key is never reused, so neither is the pair. */
const NONCE = new Uint8Array(12)

/** Seal `plaintext` so only the holder of `recipientSignPub` can read it. */
export function seal(plaintext: string, recipientSignPubHex: string): string {
  const recipientPub = sealingKeyFromSignPub(recipientSignPubHex)
  const ephSecret = x25519.utils.randomSecretKey()
  const ephPub = x25519.getPublicKey(ephSecret)
  const shared = x25519.getSharedSecret(ephSecret, recipientPub)
  const key = deriveKey(shared, ephPub, recipientPub)
  const box = chacha20poly1305(key, NONCE).encrypt(new TextEncoder().encode(plaintext))

  const out = new Uint8Array(ephPub.length + box.length)
  out.set(ephPub, 0)
  out.set(box, ephPub.length)
  return bytesToHex(out)
}

/**
 * Open a sealed blob. Returns null on any failure — a wrong key, a truncated
 * blob and a forged one are deliberately indistinguishable to the caller, so
 * nothing here becomes an oracle.
 */
export function open(sealedHex: string, ownSeedHex: string, ownSignPubHex: string): string | null {
  try {
    const sealed = hexToBytes(sealedHex)
    if (sealed.length <= 32 + 16) return null
    const ephPub = sealed.subarray(0, 32)
    const box = sealed.subarray(32)

    const ownSecret = sealingSecretFromSeed(ownSeedHex)
    const ownPub = sealingKeyFromSignPub(ownSignPubHex)
    const shared = x25519.getSharedSecret(ownSecret, ephPub)
    const key = deriveKey(shared, ephPub, ownPub)
    const plain = chacha20poly1305(key, NONCE).decrypt(box)
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}
