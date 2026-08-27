// UDP hole punching.
//
// Two machines behind home routers cannot dial each other: a router only
// forwards inbound packets that match a mapping it created for an outbound one.
// Neither side has such a mapping for the other, so both wait for a call that
// cannot arrive.
//
// Punching fixes it by having both sides send FIRST, at the same time. Each
// outbound packet creates the mapping its router needs, so the other side's
// packet — arriving a moment later — now has somewhere to go. The early packets
// are usually lost, and that is expected: their job is to open the door, not to
// be received.
//
// Timing is the whole trick, which is why this is pure logic with an injected
// clock. Coordinating "both start now" is the rendezvous introduction's job;
// getting the cadence right is this module's.

import { encodeFrame } from "./reliable"

export const FRAME_PUNCH = 4
export const FRAME_PUNCH_ACK = 5

/**
 * How often to fire while punching. Fast enough that both sides overlap inside
 * a NAT's mapping lifetime, slow enough not to look like a flood to a router
 * that rate-limits.
 */
const PUNCH_INTERVAL_MS = 120

/**
 * Give up after this long. Beyond a few seconds the pair is behind something
 * punching cannot cross — symmetric NAT on both sides — and continuing just
 * delays telling the user.
 */
const PUNCH_TIMEOUT_MS = 8000

export interface Endpoint {
  host: string
  port: number
}

export interface PunchOptions {
  /** Candidate addresses for the peer, tried in parallel. */
  candidates: readonly Endpoint[]
  /** Send one datagram to a specific endpoint. */
  send(datagram: Uint8Array, to: Endpoint): void
  /** A path opened. Carries the endpoint that actually worked. */
  onOpen(endpoint: Endpoint): void
  /** Nothing got through. */
  onFail(reason: string): void
}

export class HolePuncher {
  private startedAt = -1
  private lastFireAt = -1
  private settled = false
  /** Distinguishes our punches from a stale attempt or an unrelated sender. */
  private readonly token: Uint8Array

  constructor(private readonly opts: PunchOptions) {
    this.token = new Uint8Array(8)
    crypto.getRandomValues(this.token)
  }

  get isSettled(): boolean {
    return this.settled
  }

  /** Fire on every tick until something answers or time runs out. */
  tick(now: number): void {
    if (this.settled) return
    if (this.startedAt < 0) this.startedAt = now

    if (now - this.startedAt > PUNCH_TIMEOUT_MS) {
      this.settled = true
      this.opts.onFail("no path opened; both peers are likely behind symmetric NAT")
      return
    }
    if (this.lastFireAt >= 0 && now - this.lastFireAt < PUNCH_INTERVAL_MS) return
    this.lastFireAt = now

    // Every candidate, every round. A peer may publish a local address and a
    // public one, and which works is not knowable in advance — trying them in
    // sequence would spend the whole budget on the first one that is wrong.
    const frame = encodeFrame(FRAME_PUNCH, 0, 0, this.token)
    for (const c of this.opts.candidates) this.opts.send(frame, c)
  }

  /**
   * Feed a datagram that arrived while punching.
   *
   * A PUNCH from the peer proves their packet reached us, which means our
   * router has a mapping and theirs is sending — so the path is open in both
   * directions and we answer to tell them.
   */
  onDatagram(data: Uint8Array, from: Endpoint): void {
    if (this.settled) return
    if (data.length < 1) return
    const type = data[0]
    if (type !== FRAME_PUNCH && type !== FRAME_PUNCH_ACK) return

    if (type === FRAME_PUNCH) {
      // Echo their token, not ours: this is a reply, and the sender matches it
      // against what they sent.
      const echo = data.subarray(11)
      this.opts.send(encodeFrame(FRAME_PUNCH_ACK, 0, 0, echo), from)
    }

    this.settled = true
    this.opts.onOpen(from)
  }
}
