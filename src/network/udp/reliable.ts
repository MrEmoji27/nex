// A reliable, ordered channel over datagrams.
//
// UDP is what NAT traversal needs — hole punching is a UDP technique and TCP
// cannot do it here, because Bun gives no way to bind a source port. But UDP
// drops, duplicates and reorders, and the layers above assume a stream that
// does none of those things. This provides that stream.
//
// It is deliberately NOT a congestion-controlled transport. There is no
// bandwidth estimation and no slow start: a chat session sends a few hundred
// bytes at human speed, and a voice call is already rate-limited by the codec.
// What it does provide is the part that actually breaks without it — nothing
// lost, nothing out of order, nothing delivered twice.
//
// Pure logic on purpose. It owns no socket and reads no clock: datagrams come
// in through onDatagram, go out through the `send` callback, and time arrives
// via tick(). That makes loss, reordering and duplication testable exactly,
// rather than hoped for against a real network.

/** Datagram kinds. One byte, first in every frame. */
export const FRAME_DATA = 1
export const FRAME_ACK = 2
export const FRAME_PING = 3

/**
 * Payload ceiling. 1200 bytes keeps a datagram under the smallest MTU seen in
 * practice once IPv6 and tunnel headers are accounted for; going higher invites
 * fragmentation, and a fragmented UDP datagram is lost whole when any fragment
 * is.
 */
export const MAX_PAYLOAD = 1200

const HEADER_BYTES = 1 + 4 + 4 + 2

/** Retransmit an unacknowledged frame after this long, doubling each attempt. */
const RTO_MS = 300
const RTO_MAX_MS = 4000
/** Give up on a peer after this many attempts on the same frame. */
const MAX_ATTEMPTS = 8

interface Outbound {
  seq: number
  payload: Uint8Array
  sentAt: number
  attempts: number
  rto: number
}

export interface ReliableOptions {
  /** Write one datagram to the wire. */
  send(datagram: Uint8Array): void
  /** A payload arrived, in order, exactly once. */
  onDeliver(payload: Uint8Array): void
  /** The peer stopped acknowledging; the channel is dead. */
  onDead?(reason: string): void
}

export function encodeFrame(type: number, seq: number, ack: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.length)
  const v = new DataView(out.buffer)
  v.setUint8(0, type)
  v.setUint32(1, seq)
  v.setUint32(5, ack)
  v.setUint16(9, payload.length)
  out.set(payload, HEADER_BYTES)
  return out
}

export interface Frame {
  type: number
  seq: number
  ack: number
  payload: Uint8Array
}

export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < HEADER_BYTES) return null
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const len = v.getUint16(9)
  // A length that disagrees with the datagram is either corruption or someone
  // probing; either way it is not ours.
  if (HEADER_BYTES + len !== data.length) return null
  return {
    type: v.getUint8(0),
    seq: v.getUint32(1),
    ack: v.getUint32(5),
    payload: data.subarray(HEADER_BYTES),
  }
}

export class ReliableChannel {
  private nextSeq = 1
  /** Highest contiguous sequence delivered to the application. */
  private delivered = 0
  private unacked = new Map<number, Outbound>()
  /** Arrived out of order, held until the gap fills. */
  private pending = new Map<number, Uint8Array>()
  private dead = false

  constructor(private readonly opts: ReliableOptions) {}

  get inFlight(): number {
    return this.unacked.size
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Queue a payload for reliable, ordered delivery. */
  send(payload: Uint8Array, now: number): void {
    if (this.dead) return
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`payload ${payload.length} exceeds ${MAX_PAYLOAD}; caller must split`)
    }
    const seq = this.nextSeq++
    const frame: Outbound = { seq, payload, sentAt: now, attempts: 1, rto: RTO_MS }
    this.unacked.set(seq, frame)
    this.opts.send(encodeFrame(FRAME_DATA, seq, this.delivered, payload))
  }

  /** Feed one datagram received from the wire. */
  onDatagram(data: Uint8Array, now: number): void {
    if (this.dead) return
    const frame = decodeFrame(data)
    if (!frame) return

    // Every frame carries the sender's delivered watermark, so an ACK rides
    // along with ordinary data and a silent direction still gets acknowledged.
    this.acknowledge(frame.ack)

    if (frame.type === FRAME_ACK || frame.type === FRAME_PING) {
      if (frame.type === FRAME_PING) {
        this.opts.send(encodeFrame(FRAME_ACK, 0, this.delivered, new Uint8Array(0)))
      }
      return
    }
    if (frame.type !== FRAME_DATA) return

    if (frame.seq <= this.delivered) {
      // Already delivered. The peer retransmitted because our ack was lost, so
      // acknowledge again rather than staying silent.
      this.opts.send(encodeFrame(FRAME_ACK, 0, this.delivered, new Uint8Array(0)))
      return
    }

    this.pending.set(frame.seq, frame.payload)
    // Drain everything that is now contiguous.
    for (;;) {
      const next = this.pending.get(this.delivered + 1)
      if (!next) break
      this.pending.delete(this.delivered + 1)
      this.delivered += 1
      this.opts.onDeliver(next)
    }
    this.opts.send(encodeFrame(FRAME_ACK, 0, this.delivered, new Uint8Array(0)))
  }

  /** Drop everything the peer has confirmed receiving. */
  private acknowledge(upTo: number): void {
    if (upTo <= 0) return
    for (const seq of [...this.unacked.keys()]) {
      if (seq <= upTo) this.unacked.delete(seq)
    }
  }

  /** Drive retransmissions. Call regularly. */
  tick(now: number): void {
    if (this.dead) return
    for (const frame of this.unacked.values()) {
      if (now - frame.sentAt < frame.rto) continue
      if (frame.attempts >= MAX_ATTEMPTS) {
        this.dead = true
        this.opts.onDead?.(`no acknowledgement after ${MAX_ATTEMPTS} attempts`)
        return
      }
      frame.attempts += 1
      frame.sentAt = now
      // Exponential backoff. Retransmitting at a fixed interval into a
      // congested path is how a struggling link is turned into a dead one.
      frame.rto = Math.min(frame.rto * 2, RTO_MAX_MS)
      this.opts.send(encodeFrame(FRAME_DATA, frame.seq, this.delivered, frame.payload))
    }
  }

  /**
   * Send a keepalive.
   *
   * This is not optional on UDP behind NAT. A router drops an idle mapping
   * after as little as thirty seconds, and once it is gone the peer's packets
   * arrive at a port that no longer forwards anywhere — the connection dies
   * silently while both sides believe it is fine.
   */
  ping(): void {
    if (this.dead) return
    this.opts.send(encodeFrame(FRAME_PING, 0, this.delivered, new Uint8Array(0)))
  }
}
