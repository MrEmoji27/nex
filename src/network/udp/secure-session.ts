// Noise_XX over the reliable datagram channel.
//
// The audited handshake is used unchanged. It assumes ordered, exactly-once,
// retransmitted delivery, and the reliable channel underneath provides exactly
// that — so the handshake never learns the network is unreliable. Writing a
// UDP-specific variant would put the byte-for-byte conformance already verified
// against foreign vectors at risk, and this codebase has been burned once by an
// implementation that called itself Noise_XX and was not.
//
// Nothing here starts until the path is open. Retransmitting a handshake
// message into a NAT that has not been punched yet burns the retry budget
// before the peer can possibly answer, and the connection dies of impatience
// rather than of anything real.

import { NoiseHandshake, type HandshakeResult } from "../noise/noise"
import { resolveIdentityBinding, type IdentityState, type StaticKeyBindings } from "../../core/session/identity-binding"

/**
 * Distinct from the TCP prologue on purpose. A prologue binds a handshake to
 * its context, so a transcript from one transport cannot be replayed into the
 * other.
 */
export const UDP_TRANSPORT_PROLOGUE = "nex-udp-v1"

const TAG_HANDSHAKE = 0x01
const TAG_TRANSPORT = 0x02

/**
 * Ceiling on frames held during the binding window. A slow disk is milliseconds;
 * anything filling this is not a peer waiting politely.
 */
const MAX_QUEUED = 256

export interface SecureSessionOptions {
  role: "initiator" | "responder"
  /** Our long-term static private key. */
  staticPrivate: Uint8Array
  /** Sent inside the handshake so the peer learns who we claim to be. */
  claim: { nodeId: string; name: string }
  bindings?: StaticKeyBindings
  /** Hand one framed payload to the reliable channel. */
  send(payload: Uint8Array): void
  /** A decrypted application message arrived. */
  onMessage(plaintext: Uint8Array): void
  /**
   * The handshake completed and the peer's identity was resolved. A `mismatch`
   * means the caller must drop the link — this module reports, it does not
   * decide policy.
   */
  onAuthenticated(info: { claim: { nodeId: string; name: string }; identityState: IdentityState; result: HandshakeResult }): void
  onError(reason: string): void
}

export class SecureSession {
  private handshake: NoiseHandshake
  private started = false
  private authenticated = false
  private peerClaim: { nodeId: string; name: string } | null = null
  /**
   * Transport frames that arrived while the identity binding was still being
   * decided, held IN ORDER.
   *
   * The handshake finishes synchronously; resolving who the peer is does not —
   * it reads a store, and a slow disk widens the gap. The peer has no way to
   * know about that gap: from their side the handshake is complete and they may
   * send immediately, which they routinely do.
   *
   * Dropping those frames is not survivable here. The receive cipher advances a
   * nonce per frame, so a frame that is never decrypted leaves the two counters
   * one apart forever and EVERY later frame fails authentication. The link goes
   * on looking connected and carries nothing. The TCP transport learned this
   * first (see its queuedOps); this is the same window, and this is the same
   * answer.
   */
  private queued: Uint8Array[] = []

  constructor(private readonly opts: SecureSessionOptions) {
    this.handshake = new NoiseHandshake(opts.role, opts.staticPrivate, UDP_TRANSPORT_PROLOGUE)
  }

  get isAuthenticated(): boolean {
    return this.authenticated
  }

  /**
   * Begin. The initiator sends message 1; the responder simply waits.
   *
   * Call only once the path is established.
   */
  start(): void {
    if (this.started) return
    this.started = true
    if (this.opts.role !== "initiator") return
    this.handshake.setNextPayload(encodeClaim(this.opts.claim))
    this.opts.send(frame(TAG_HANDSHAKE, this.handshake.start()))
  }

  /** Feed one payload delivered by the reliable channel. */
  onPayload(payload: Uint8Array): void {
    if (payload.length < 1) return
    const tag = payload[0]
    const body = payload.subarray(1)

    if (tag === TAG_HANDSHAKE) {
      this.onHandshake(body)
      return
    }
    if (tag !== TAG_TRANSPORT) return
    if (!this.authenticated) {
      if (!this.handshake.complete) {
        // Nothing has been agreed yet. This is either a bug or an attempt to
        // skip authentication, and neither is worth decrypting.
        this.opts.onError("transport message arrived before the handshake completed")
        return
      }
      // The handshake IS done and only the binding check is outstanding. Hold
      // it; see `queued`.
      if (this.queued.length >= MAX_QUEUED) {
        this.opts.onError("peer sent more than the binding window can hold")
        return
      }
      this.queued.push(body)
      return
    }
    // A frame that fails authentication is not a message; it is noise or an
    // attack, and either way the session state must not be advanced by it.
    this.deliver(body)
  }

  /** Encrypt and send one application message. */
  send(plaintext: Uint8Array): void {
    if (!this.authenticated) throw new Error("session is not authenticated")
    this.opts.send(frame(TAG_TRANSPORT, this.handshake.result.send.encryptWithAd(new Uint8Array(0), plaintext)))
  }

  private onHandshake(message: Uint8Array): void {
    if (this.authenticated) return
    if (!this.started) {
      // A responder is started by the first message arriving.
      this.started = true
    }

    // The payload is consumed by whichever message carries it, so it is set
    // before every step rather than once. Setting it only at the start meant
    // the initiator's final message went out empty and the peer completed the
    // handshake with nobody's name in it.
    this.handshake.setNextPayload(encodeClaim(this.opts.claim))

    let reply: Uint8Array | null
    try {
      reply = this.handshake.feed(message)
    } catch (err) {
      // Tampering, truncation or an out-of-sequence message. The handshake
      // cannot be resumed after this — it is one transcript, not a set of
      // independent steps.
      this.opts.onError(`handshake failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    if (reply) this.opts.send(frame(TAG_HANDSHAKE, reply))
    if (!this.handshake.complete) return

    // The claim rides in the peer's FINAL handshake message, which is the one
    // covered by the completed transcript. remoteFirstPayload is msg1 only, and
    // msg1 is sent before any key exists — a name read from there would be
    // unauthenticated.
    const claim = decodeClaim(this.handshake.result.remotePayload)
    if (!claim) {
      this.opts.onError("peer completed the handshake without a usable identity claim")
      return
    }
    this.peerClaim = claim
    void this.finish(claim)
  }

  private async finish(claim: { nodeId: string; name: string }): Promise<void> {
    const presented = toHex(this.handshake.result.remoteStaticKey)
    // The same resolver the TCP transport uses. Two verifiers would be two
    // chances to disagree about who someone is.
    const identityState = await resolveIdentityBinding(
      claim.nodeId,
      presented,
      this.opts.bindings,
      Date.now(),
      (m) => this.opts.onError(m),
    )
    this.authenticated = true
    this.opts.onAuthenticated({ claim, identityState, result: this.handshake.result })

    // A mismatched peer is being dropped by the caller right now; decrypting
    // what they queued would be handing an impostor's messages to the user.
    if (identityState === "mismatch") {
      this.queued = []
      return
    }
    const held = this.queued
    this.queued = []
    for (const body of held) this.deliver(body)
  }

  /** Decrypt one transport frame in wire order and hand it up. */
  private deliver(body: Uint8Array): void {
    try {
      this.opts.onMessage(this.handshake.result.receive.decryptWithAd(new Uint8Array(0), body))
    } catch {
      this.opts.onError("dropped a transport frame that failed authentication")
    }
  }
}

function frame(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length)
  out[0] = tag
  out.set(body, 1)
  return out
}

function encodeClaim(claim: { nodeId: string; name: string }): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(claim))
}

function decodeClaim(payload: Uint8Array): { nodeId: string; name: string } | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(payload)) as { nodeId?: unknown; name?: unknown }
    if (typeof parsed.nodeId !== "string" || !parsed.nodeId) return null
    return { nodeId: parsed.nodeId, name: typeof parsed.name === "string" ? parsed.name : "" }
  } catch {
    return null
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
