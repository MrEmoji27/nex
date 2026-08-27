// Which way to reach a peer.
//
// Nex now has two transports that both end in the same place — a Noise session,
// an identity binding, an authenticated peer. They differ in how they get
// there, and the difference is not a preference:
//
//   TCP  works when one side can already be dialled: same Wi-Fi, a forwarded
//        port, an invite carrying a reachable address. It is simpler, it has no
//        MTU ceiling, and it has been the transport since v1.
//   UDP  works when neither side can be dialled, which is the ordinary case
//        across the internet. It is the only one that can punch through NAT.
//
// So the rule is: an address that names a UDP candidate list goes over UDP,
// everything else over TCP. That is the whole policy, deliberately. A richer
// one — probing both, racing them, scoring paths — is a thing to build once
// there is evidence about which paths actually fail, not before.

import type {
  ControlWire,
  ErrorScope,
  NodeIdentity,
  P2PTransport,
  PeerInfo,
  TransportSecurity,
  Unsubscribe,
  VoiceFrameMeta,
} from "../core/contract.ts"
import { parseUdpAddress } from "../core/session/udp-address"
import type { UdpTransport } from "./udp/udp-transport"

type Route = "tcp" | "udp"

export interface TransportSelectorOptions {
  /** Local UDP port. 0 lets the OS choose; the candidate published is whatever it picked. */
  udpPort?: number
  /** Developer diagnostics. */
  log?(event: string, detail?: Record<string, unknown>): void
}

export class TransportSelector implements P2PTransport {
  readonly security: TransportSecurity = { encrypted: true }

  /** Which transport currently holds each peer. */
  private readonly routes = new Map<string, Route>()
  private readonly peerStatusListeners = new Set<(peer: PeerInfo) => void>()

  constructor(
    readonly tcp: P2PTransport,
    readonly udp: UdpTransport,
    private readonly options: TransportSelectorOptions = {},
  ) {}

  // ---------- events ----------

  onPeerStatus(callback: (peer: PeerInfo) => void): Unsubscribe {
    this.peerStatusListeners.add(callback)
    return () => this.peerStatusListeners.delete(callback)
  }

  onMessage(callback: (peerId: string, content: string, receivedAt: number) => void): Unsubscribe {
    const offTcp = this.tcp.onMessage(callback)
    const offUdp = this.udp.onMessage(callback)
    return () => {
      offTcp()
      offUdp()
    }
  }

  onControl(callback: (peerId: string, control: ControlWire) => void): Unsubscribe {
    const offTcp = this.tcp.onControl?.(callback)
    const offUdp = this.udp.onControl(callback)
    return () => {
      offTcp?.()
      offUdp()
    }
  }

  onVoiceFrame(callback: (fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void): Unsubscribe {
    const offTcp = this.tcp.onVoiceFrame?.(callback)
    const offUdp = this.udp.onVoiceFrame(callback)
    return () => {
      offTcp?.()
      offUdp()
    }
  }

  onError(callback: (scope: ErrorScope, message: string) => void): Unsubscribe {
    const offTcp = this.tcp.onError(callback)
    const offUdp = this.udp.onError(callback)
    return () => {
      offTcp()
      offUdp()
    }
  }

  // ---------- lifecycle ----------

  async start(options: { port?: number; identity: NodeIdentity }): Promise<number> {
    // Routing is decided here, where both streams of events meet, rather than
    // by asking each transport afterwards who it knows.
    this.tcp.onPeerStatus((peer) => this.onStatus("tcp", peer))
    this.udp.onPeerStatus((peer) => this.onStatus("udp", peer))

    const tcpPort = await this.tcp.start(options)
    const udpPort = await this.udp.start({ port: this.options.udpPort ?? 0, identity: options.identity })
    this.options.log?.("transports_started", { tcpPort, udpPort })
    // The TCP port is what the app publishes as its LAN address, so it is the
    // one returned; the UDP port is reached through `udpTransport.port`.
    return tcpPort
  }

  async stop(): Promise<void> {
    await this.udp.stop()
    await this.tcp.stop()
    this.routes.clear()
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop()
  }

  get port(): number {
    return (this.tcp as { port?: number }).port ?? 0
  }

  get udpPort(): number {
    return this.udp.port
  }

  // ---------- routing ----------

  async dial(address: string): Promise<PeerInfo> {
    const route: Route = parseUdpAddress(address) ? "udp" : "tcp"
    this.options.log?.("transport_selected", { address, transport: route })
    const peer = route === "udp" ? await this.udp.dial(address) : await this.tcp.dial(address)
    this.routes.set(peer.peerId, route)
    return peer
  }

  async drop(peerId: string): Promise<void> {
    // Dropped on both: a peer reachable two ways must not stay half-connected
    // because only one of them was told to let go.
    await this.tcp.drop(peerId).catch(() => {})
    await this.udp.drop(peerId).catch(() => {})
    this.routes.delete(peerId)
  }

  async send(peerId: string, content: string): Promise<void> {
    await this.pick(peerId).send(peerId, content)
  }

  async sendControl(peerId: string, control: ControlWire): Promise<void> {
    await this.pick(peerId).sendControl?.(peerId, control)
  }

  sendVoiceFrame(peerId: string, meta: VoiceFrameMeta, payload: Uint8Array): void {
    this.pick(peerId).sendVoiceFrame?.(peerId, meta, payload)
  }

  measureLatency(peerId: string): Promise<number | null> {
    return this.pick(peerId).measureLatency?.(peerId) ?? Promise.resolve(null)
  }

  /** Which transport currently carries this peer, if any. */
  routeOf(peerId: string): Route | null {
    return this.routes.get(peerId) ?? null
  }

  private pick(peerId: string): P2PTransport {
    return this.routes.get(peerId) === "udp" ? this.udp : this.tcp
  }

  private onStatus(route: Route, peer: PeerInfo): void {
    if (peer.status === "connected") {
      const current = this.routes.get(peer.peerId)
      // TCP wins a tie. If a peer is reachable both ways it is already directly
      // dialable, and the punched path buys nothing over a plain socket.
      if (current !== "tcp") this.routes.set(peer.peerId, route)
    } else if (peer.status === "offline" && this.routes.get(peer.peerId) === route) {
      this.routes.delete(peer.peerId)
    }
    for (const listener of this.peerStatusListeners) listener(peer)
  }
}
