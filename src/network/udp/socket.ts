// A real UDP socket carrying reliable channels and hole punching.
//
// This is where the pure layers meet the network. One socket serves every peer:
// that is not an optimisation, it is required. The public address STUN reports
// belongs to a specific local port, and a punched mapping belongs to that same
// port — opening a second socket per peer would produce a different mapping
// that nobody was told about.

import { ReliableChannel, decodeFrame, MAX_PAYLOAD } from "./reliable"
import { FRAME_PUNCH, FRAME_PUNCH_ACK, HolePuncher, type Endpoint } from "./punch"

/** How often to drive retransmits and punching. */
const TICK_MS = 50

/**
 * Keepalive cadence. Routers drop idle UDP mappings, some after only thirty
 * seconds, so this stays comfortably inside the shortest common timeout.
 */
const KEEPALIVE_MS = 15_000

interface UdpLike {
  send(data: Uint8Array, port: number, host: string): unknown
  close(): void
}

interface Peer {
  id: string
  endpoint: Endpoint | null
  channel: ReliableChannel
  puncher: HolePuncher | null
  lastSentAt: number
}

export interface UdpEndpointOptions {
  /** Local port. 0 lets the OS choose, which is fine — STUN reports whatever it is. */
  port?: number
  /** A payload arrived from a peer, in order and exactly once. */
  onMessage(peerId: string, payload: Uint8Array): void
  /** A peer became reachable. */
  onConnected?(peerId: string, endpoint: Endpoint): void
  /** A peer stopped answering, or punching failed. */
  onLost?(peerId: string, reason: string): void
}

export class UdpEndpoint {
  private socket: UdpLike | null = null
  private peers = new Map<string, Peer>()
  /** Reverse lookup so an inbound datagram can be attributed to a peer. */
  private byEndpoint = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private boundPort = 0

  constructor(private readonly opts: UdpEndpointOptions) {}

  get port(): number {
    return this.boundPort
  }

  async start(): Promise<number> {
    const sock = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: this.opts.port ?? 0,
      socket: {
        data: (_s: unknown, data: Uint8Array, port: number, host: string) => {
          this.onDatagram(data, { host, port })
        },
      },
    })
    this.socket = sock as unknown as UdpLike
    this.boundPort = (sock as unknown as { port: number }).port
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS)
    return this.boundPort
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.peers.clear()
    this.byEndpoint.clear()
    try {
      this.socket?.close()
    } catch {
      // already closed
    }
    this.socket = null
  }

  /**
   * Begin reaching a peer at any of its candidate addresses.
   *
   * Both sides must call this at roughly the same moment — that simultaneity is
   * the whole mechanism, and arranging it is the rendezvous introduction's job.
   */
  connect(peerId: string, candidates: readonly Endpoint[]): void {
    if (this.peers.has(peerId)) return

    const peer: Peer = {
      id: peerId,
      endpoint: null,
      lastSentAt: 0,
      channel: new ReliableChannel({
        send: (d) => {
          const to = this.peers.get(peerId)?.endpoint
          if (to) this.write(d, to)
        },
        onDeliver: (p) => this.opts.onMessage(peerId, p),
        onDead: (reason) => this.lose(peerId, reason),
      }),
      puncher: null,
    }
    peer.puncher = new HolePuncher({
      candidates,
      send: (d, to) => this.write(d, to),
      onOpen: (endpoint) => {
        peer.endpoint = endpoint
        peer.puncher = null
        this.byEndpoint.set(key(endpoint), peerId)
        this.opts.onConnected?.(peerId, endpoint)
      },
      onFail: (reason) => this.lose(peerId, reason),
    })
    this.peers.set(peerId, peer)
  }

  /** Queue a payload. Fails loudly if the peer is not reachable yet. */
  send(peerId: string, payload: Uint8Array): void {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`unknown peer ${peerId}`)
    if (!peer.endpoint) throw new Error(`no path to ${peerId} yet`)
    if (payload.length > MAX_PAYLOAD) {
      throw new Error(`payload ${payload.length} exceeds ${MAX_PAYLOAD}; caller must split`)
    }
    peer.channel.send(payload, Date.now())
    peer.lastSentAt = Date.now()
  }

  drop(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer?.endpoint) this.byEndpoint.delete(key(peer.endpoint))
    this.peers.delete(peerId)
  }

  private write(data: Uint8Array, to: Endpoint): void {
    try {
      this.socket?.send(data, to.port, to.host)
    } catch {
      // A send failure here is routine — an unreachable candidate during
      // punching is expected, and the retransmit timer covers real loss.
    }
  }

  private onDatagram(data: Uint8Array, from: Endpoint): void {
    const peerId = this.byEndpoint.get(key(from))
    if (peerId) {
      this.peers.get(peerId)?.channel.onDatagram(data, Date.now())
      return
    }

    // Not a known endpoint. It may be a punch from a peer whose address we were
    // told, arriving from a different port than advertised — which is normal,
    // since the mapping is chosen by their router, not by them.
    if (data.length > 0 && (data[0] === FRAME_PUNCH || data[0] === FRAME_PUNCH_ACK)) {
      for (const peer of this.peers.values()) {
        if (peer.puncher) peer.puncher.onDatagram(data, from)
      }
    }
  }

  private lose(peerId: string, reason: string): void {
    this.drop(peerId)
    this.opts.onLost?.(peerId, reason)
  }

  private tick(now: number): void {
    for (const peer of this.peers.values()) {
      if (peer.puncher) {
        peer.puncher.tick(now)
        continue
      }
      peer.channel.tick(now)
      if (now - peer.lastSentAt >= KEEPALIVE_MS) {
        peer.channel.ping()
        peer.lastSentAt = now
      }
    }
  }
}

function key(e: Endpoint): string {
  return `${e.host}:${e.port}`
}

export { type Endpoint }
export { decodeFrame }
