// The UDP transport: a P2PTransport that reaches peers through NAT.
//
// Everything underneath this file already existed and was tested on its own —
// punching, the reliable channel, Noise, the identity binding. This is the
// wiring, and the wiring is where the order matters:
//
//   punch  ->  PATH_ESTABLISHED  ->  reliable channel  ->  Noise  ->  identity
//
// Nothing may start early. Retransmitting into a NAT that has not been punched
// burns the retry budget before the peer can possibly answer, so the link dies
// of impatience rather than of anything real; and a peer is not a peer until
// the identity check has run, so no connection is announced to the application
// before then. Both rules are enforced structurally here: the session is not
// even constructed until the puncher reports a path, and `established` is set
// only after the identity binding returns something other than a mismatch.
//
// One socket serves every peer. That is not an optimisation — the address a
// peer was told to punch belongs to one local port, and a second socket would
// have a different mapping that nobody was told about.

import type {
  ControlWire,
  ErrorScope,
  IdentityState,
  NodeIdentity,
  P2PTransport,
  PeerInfo,
  TransportSecurity,
  Unsubscribe,
  VoiceFrameMeta,
} from "../../core/contract.ts"
import type { StaticKeyStore } from "../../core/state/persistence"
import { decodeOp, encodeOp, OP_CONTROL, OP_MESSAGE, OP_PING, OP_PONG, OP_VOICE, type OpFrame } from "../../core/session/op-frames"
import { DEFAULT_STUN_SERVERS, discoverCandidateVia, type NatBehaviour, type NatReport } from "../stun"
import { MAX_PAYLOAD } from "./reliable"
import { SecureSession } from "./secure-session"
import { UdpEndpoint, type Endpoint } from "./socket"
import { formatUdpAddress, parseUdpAddress } from "../../core/session/udp-address"

// Addressing lives in core/session/udp-address.ts so the application can hold a
// UDP address without importing a transport module. Re-exported here for
// callers already talking to this one.
export { UDP_SCHEME, formatUdpAddress, parseUdpAddress } from "../../core/session/udp-address"

/**
 * Largest plaintext one op frame may hold.
 *
 * A datagram is not a stream: there is no fragmentation underneath, by
 * decision — a fragmented UDP datagram is lost whole when any fragment is. So
 * the MTU ceiling is a real limit on a chat message here, and it is enforced
 * loudly rather than by silent truncation. One byte of session tag and sixteen
 * of Poly1305 tag come off the top.
 */
export const MAX_OP_PLAINTEXT = MAX_PAYLOAD - 1 - 16

/** Noise must finish inside this, measured from the moment the path opened. */
const HANDSHAKE_TIMEOUT_MS = 15_000
const PING_TIMEOUT_MS = 5_000

type Phase = "punching" | "handshaking" | "established"

interface UdpPeer {
  /** The nodeId we expect. Known before connecting: a candidate list is useless without one. */
  expectedNodeId: string
  name: string
  address: string
  role: "initiator" | "responder"
  phase: Phase
  session: SecureSession | null
  identityState?: IdentityState
  handshakeTimer?: ReturnType<typeof setTimeout>
  pending?: { resolve: (peer: PeerInfo) => void; reject: (err: Error) => void }
  pingSentAt?: number
  lastRttMs?: number
  pendingPing?: { resolve: (ms: number | null) => void; timer: ReturnType<typeof setTimeout> }
}

export interface UdpTransportOptions {
  /** Our long-term X25519 private key (hex). Without it nothing can be proven, so dials fail closed. */
  identityPrivHex?: string
  /** TOFU continuity store for peer static keys — the same one TCP uses. */
  bindings?: StaticKeyStore
  /** STUN servers used to learn our own candidate. */
  stunServers?: ReadonlyArray<{ host: string; port: number }>
  /** Developer diagnostics for the integration path. Never carries payload bytes. */
  log?(event: string, detail?: Record<string, unknown>): void
}

export class UdpTransport implements P2PTransport {
  readonly security: TransportSecurity = { encrypted: true }

  private endpoint: UdpEndpoint | null = null
  private identity: NodeIdentity | null = null
  private stopped = false
  private readonly peers = new Map<string, UdpPeer>()

  private publicAddress: { host: string; port: number } | null = null
  private natBehaviourValue: NatBehaviour = "unknown"
  private natDetail = "not measured yet"

  private readonly peerStatusListeners = new Set<(peer: PeerInfo) => void>()
  private readonly messageListeners = new Set<(peerId: string, content: string, receivedAt: number) => void>()
  private readonly controlListeners = new Set<(peerId: string, control: ControlWire) => void>()
  private readonly voiceListeners = new Set<(fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void>()
  private readonly errorListeners = new Set<(scope: ErrorScope, message: string) => void>()

  constructor(private readonly options: UdpTransportOptions = {}) {}

  // ---------- events ----------

  onPeerStatus(callback: (peer: PeerInfo) => void): Unsubscribe {
    this.peerStatusListeners.add(callback)
    return () => this.peerStatusListeners.delete(callback)
  }

  onMessage(callback: (peerId: string, content: string, receivedAt: number) => void): Unsubscribe {
    this.messageListeners.add(callback)
    return () => this.messageListeners.delete(callback)
  }

  onControl(callback: (peerId: string, control: ControlWire) => void): Unsubscribe {
    this.controlListeners.add(callback)
    return () => this.controlListeners.delete(callback)
  }

  onVoiceFrame(callback: (fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void): Unsubscribe {
    this.voiceListeners.add(callback)
    return () => this.voiceListeners.delete(callback)
  }

  onError(callback: (scope: ErrorScope, message: string) => void): Unsubscribe {
    this.errorListeners.add(callback)
    return () => this.errorListeners.delete(callback)
  }

  // ---------- lifecycle ----------

  async start(options: { port?: number; identity: NodeIdentity }): Promise<number> {
    this.identity = options.identity
    this.stopped = false
    const endpoint = new UdpEndpoint({
      port: options.port,
      onMessage: (peerId, payload) => this.onPeerPayload(peerId, payload),
      onConnected: (peerId, remote) => this.onPathEstablished(peerId, remote),
      onLost: (peerId, reason) => this.onPathLost(peerId, reason),
      log: (event, detail) => this.log(event, detail),
    })
    this.endpoint = endpoint
    const port = await endpoint.start()
    this.log("udp_bound", { port })
    return port
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const peerId of [...this.peers.keys()]) this.teardown(peerId, "transport stopping")
    await this.endpoint?.stop()
    this.endpoint = null
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop()
  }

  get port(): number {
    return this.endpoint?.port ?? 0
  }

  /** Our public address as measured on THIS socket, once STUN has answered. */
  get publicCandidate(): { host: string; port: number } | null {
    return this.publicAddress
  }

  get natBehaviour(): NatBehaviour {
    return this.natBehaviourValue
  }

  /** What to tell a user when a connection fails and the NAT is the reason. */
  get natDetailText(): string {
    return this.natDetail
  }

  /**
   * Measure the public mapping of the socket peers will punch.
   *
   * Deliberately separate from start(): it takes seconds on a slow network, and
   * a node with no rendezvous has nothing to publish the answer to. The caller
   * decides when it is worth waiting for.
   */
  async discoverPublicCandidate(): Promise<NatReport> {
    const endpoint = this.endpoint
    if (!endpoint) return { behaviour: "unknown", address: null, detail: "transport is not started" }
    const report = await discoverCandidateVia(endpoint, this.options.stunServers ?? DEFAULT_STUN_SERVERS)
    this.publicAddress = report.address
    this.natBehaviourValue = report.behaviour
    this.natDetail = report.detail
    this.log("stun_mapping", {
      address: report.address ? `${report.address.host}:${report.address.port}` : null,
      localPort: this.port,
      nat: report.behaviour,
    })
    return report
  }

  // ---------- connecting ----------

  /**
   * Dial the initiating side of an introduction.
   *
   * The address is a candidate LIST, not one address, because which of a peer's
   * addresses works is not knowable in advance. The nodeId in it is not
   * decoration: it is what the Noise claim is checked against, so a service
   * that substituted a candidate list cannot hand us somebody else.
   */
  async dial(address: string): Promise<PeerInfo> {
    const parsed = parseUdpAddress(address)
    if (!parsed) throw new Error(`invalid UDP address "${address}"`)
    return this.connect(parsed.nodeId, parsed.candidates, "initiator", address)
  }

  /**
   * The answering side of an introduction: punch, but let them speak first.
   *
   * Both peers must be sending at the same moment or neither router opens, so
   * accepting an introduction has to start punching too. It does NOT make this
   * side the initiator — the peer who asked for the introduction opens the
   * Noise handshake, which both sides work out without another round trip.
   */
  expect(nodeId: string, candidates: ReadonlyArray<{ host: string; port: number }>): Promise<PeerInfo> {
    return this.connect(nodeId.toUpperCase(), candidates, "responder", formatUdpAddress(nodeId, candidates))
  }

  private connect(
    nodeId: string,
    candidates: ReadonlyArray<{ host: string; port: number }>,
    role: "initiator" | "responder",
    address: string,
  ): Promise<PeerInfo> {
    const endpoint = this.endpoint
    if (!endpoint || this.stopped) return Promise.reject(new Error("transport is not started"))
    if (!this.options.identityPrivHex) {
      // Fail closed. Without our own key we cannot prove who we are, and a link
      // nobody can authenticate is worse than no link.
      return Promise.reject(new Error("no transport identity key; cannot open a UDP session"))
    }
    const existing = this.peers.get(nodeId)
    if (existing?.phase === "established") return Promise.resolve(this.toPeerInfo(existing, "connected"))
    if (existing) {
      // A second call while the first is still punching joins it rather than
      // opening a competing attempt from the same socket.
      return new Promise<PeerInfo>((resolve, reject) => {
        const prior = existing.pending
        existing.pending = {
          resolve: (p) => {
            prior?.resolve(p)
            resolve(p)
          },
          reject: (e) => {
            prior?.reject(e)
            reject(e)
          },
        }
      })
    }

    this.log("candidate_selected", { peer: nodeId, role, candidates: candidates.map((c) => `${c.host}:${c.port}`) })

    const peer: UdpPeer = {
      expectedNodeId: nodeId,
      name: nodeId.slice(0, 8),
      address,
      role,
      phase: "punching",
      session: null,
    }
    this.peers.set(nodeId, peer)
    this.emitPeerStatus(nodeId, peer.name, address, "connecting")

    const promise = new Promise<PeerInfo>((resolve, reject) => {
      peer.pending = { resolve, reject }
    })
    endpoint.connect(nodeId, candidates)
    return promise
  }

  /** The path is open in both directions. Only now does anything above start. */
  private onPathEstablished(peerId: string, remote: Endpoint): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.phase = "handshaking"
    peer.address = `${remote.host}:${remote.port}`
    // The reliable channel is usable from this moment. It was constructed with
    // the peer, but nothing was ever written into it before the path opened.
    this.log("reliable_ready", { peer: peerId, endpoint: peer.address })

    const session = new SecureSession({
      role: peer.role,
      staticPrivate: hexToBytes(this.options.identityPrivHex!),
      claim: { nodeId: this.identity!.nodeId, name: this.identity!.name },
      bindings: this.options.bindings,
      send: (payload) => {
        try {
          this.endpoint?.send(peerId, payload)
        } catch (err) {
          this.emitError("transport", `${peer.address}: ${(err as Error).message}`)
        }
      },
      onMessage: (plaintext) => this.onDecrypted(peerId, plaintext),
      onAuthenticated: (info) => this.onAuthenticated(peerId, info.claim, info.identityState),
      onError: (reason) => this.onSessionError(peerId, reason),
    })
    peer.session = session

    peer.handshakeTimer = setTimeout(() => {
      if (this.peers.get(peerId)?.phase === "handshaking") {
        this.fail(peerId, "handshake did not complete before the path went quiet")
      }
    }, HANDSHAKE_TIMEOUT_MS)

    this.log("noise_start", { peer: peerId, role: peer.role })
    session.start()
  }

  private onPathLost(peerId: string, reason: string): void {
    this.fail(peerId, reason)
  }

  private onPeerPayload(peerId: string, payload: Uint8Array): void {
    this.peers.get(peerId)?.session?.onPayload(payload)
  }

  private onSessionError(peerId: string, reason: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.phase === "established") {
      // A single bad frame on an established link is noise or an attack; it is
      // not a reason to drop a working session.
      this.emitError("transport", `${peer.address}: ${reason}`)
      return
    }
    this.fail(peerId, reason)
  }

  private onAuthenticated(
    peerId: string,
    claim: { nodeId: string; name: string },
    identityState: IdentityState,
  ): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer)
    peer.handshakeTimer = undefined

    this.log("noise_authenticated", { peer: peerId, claimed: claim.nodeId })

    // The candidate list came with a nodeId attached. Someone else completing a
    // perfectly good handshake at that address is exactly the substitution the
    // expectation exists to catch — the same hard stop an invite gets.
    if (claim.nodeId.toUpperCase() !== peer.expectedNodeId) {
      this.emitPeerStatus(peer.expectedNodeId, peer.name, peer.address, "offline", "mismatch")
      this.fail(
        peerId,
        `DISCOVERY MISMATCH: expected ${peer.expectedNodeId.slice(0, 8)}... but ${claim.nodeId.slice(0, 8)}... answered`,
      )
      return
    }

    peer.name = claim.name || peer.name
    peer.identityState = identityState
    this.log("identity_result", { peer: peerId, state: identityState })

    // Surface the window honestly: the crypto is done, the binding is decided.
    this.emitPeerStatus(peerId, peer.name, peer.address, "authenticating")

    if (identityState === "mismatch") {
      this.emitPeerStatus(peerId, peer.name, peer.address, "offline", "mismatch")
      this.fail(peerId, `identity mismatch for ${peerId.slice(0, 8)}...`)
      return
    }

    peer.phase = "established"
    const info = this.toPeerInfo(peer, "connected")
    peer.pending?.resolve(info)
    peer.pending = undefined
    this.emitPeerStatus(peerId, peer.name, peer.address, "connected", identityState, peer.lastRttMs)
    this.log("union_formed", { peer: peerId, transport: "udp", endpoint: peer.address })
  }

  private onDecrypted(peerId: string, plaintext: Uint8Array): void {
    const peer = this.peers.get(peerId)
    if (!peer || peer.phase !== "established") return
    let decoded
    try {
      decoded = decodeOp(plaintext)
    } catch (err) {
      // Unparseable at the op level means the two ends disagree about the
      // protocol itself, which no amount of retrying fixes.
      this.emitError("transport", `${peer.address}: ${(err as Error).message}`)
      this.fail(peerId, "unreadable op frame")
      return
    }
    if (decoded.kind === "drop") return
    if (decoded.kind === "message") {
      const at = Date.now()
      for (const listener of this.messageListeners) listener(peerId, decoded.content, at)
      return
    }
    if (decoded.kind === "ping") {
      this.write(peer, peerId, { op: OP_PONG, t: decoded.t })
      return
    }
    if (decoded.kind === "pong") {
      if (peer.pingSentAt !== undefined) {
        peer.lastRttMs = Date.now() - decoded.t
        peer.pingSentAt = undefined
        peer.pendingPing?.resolve(peer.lastRttMs)
      }
      return
    }
    if (decoded.kind === "control") {
      for (const listener of this.controlListeners) listener(peerId, decoded.control)
      return
    }
    for (const listener of this.voiceListeners) listener(peerId, decoded.meta, decoded.payload)
  }

  // ---------- sending ----------

  async send(peerId: string, content: string): Promise<void> {
    const peer = this.requireEstablished(peerId)
    this.write(peer, peerId, { op: OP_MESSAGE, content })
  }

  async sendControl(peerId: string, control: ControlWire): Promise<void> {
    const peer = this.requireEstablished(peerId)
    this.write(peer, peerId, { op: OP_CONTROL, control })
  }

  sendVoiceFrame(peerId: string, meta: VoiceFrameMeta, payload: Uint8Array): void {
    const peer = this.peers.get(peerId)
    if (!peer || peer.phase !== "established") return
    try {
      this.write(peer, peerId, { op: OP_VOICE, meta, payload })
    } catch {
      // Audio never waits and never retries. A dropped frame is a click; a
      // blocked send is a dead call.
    }
  }

  measureLatency(peerId: string): Promise<number | null> {
    const peer = this.peers.get(peerId)
    if (!peer || peer.phase !== "established" || peer.pendingPing) return Promise.resolve(null)
    return new Promise<number | null>((resolve) => {
      peer.pingSentAt = Date.now()
      const pending = {
        resolve: (ms: number | null) => {
          clearTimeout(pending.timer)
          peer.pendingPing = undefined
          resolve(ms)
        },
        timer: setTimeout(() => pending.resolve(null), PING_TIMEOUT_MS),
      }
      peer.pendingPing = pending
      try {
        this.write(peer, peerId, { op: OP_PING, t: peer.pingSentAt })
      } catch {
        pending.resolve(null)
      }
    })
  }

  async drop(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.teardown(peerId, "dropped locally")
    this.emitPeerStatus(peerId, peer.name, peer.address, "offline", peer.identityState)
  }

  private write(peer: UdpPeer, peerId: string, frame: OpFrame): void {
    if (!peer.session?.isAuthenticated) throw new Error(`not connected: ${peerId}`)
    // Encoding validates size BEFORE the cipher advances its nonce. A throw
    // after encryption would desync the stream permanently.
    peer.session.send(encodeOp(frame, MAX_OP_PLAINTEXT))
  }

  private requireEstablished(peerId: string): UdpPeer {
    const peer = this.peers.get(peerId)
    if (!peer || peer.phase !== "established") throw new Error(`not connected: ${peerId}`)
    return peer
  }

  // ---------- teardown ----------

  private fail(peerId: string, reason: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    const wasEstablished = peer.phase === "established"
    this.teardown(peerId, reason)
    peer.pending?.reject(new Error(reason))
    peer.pending = undefined
    if (wasEstablished) {
      this.emitPeerStatus(peerId, peer.name, peer.address, "offline", peer.identityState)
    }
    this.emitError("transport", `${peer.address}: ${reason}`)
    this.log("session_failed", { peer: peerId, reason })
  }

  private teardown(peerId: string, _reason: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    if (peer.handshakeTimer) clearTimeout(peer.handshakeTimer)
    peer.pendingPing?.resolve(null)
    peer.session = null
    this.peers.delete(peerId)
    this.endpoint?.drop(peerId)
  }

  // ---------- plumbing ----------

  private toPeerInfo(peer: UdpPeer, status: PeerInfo["status"]): PeerInfo {
    const info: PeerInfo = {
      peerId: peer.expectedNodeId,
      name: peer.name,
      status,
      address: peer.address,
      lastSeenAt: Date.now(),
      latencyMs: peer.lastRttMs,
    }
    if (peer.identityState) info.identityState = peer.identityState
    return info
  }

  private emitPeerStatus(
    peerId: string,
    name: string,
    address: string,
    status: PeerInfo["status"],
    identityState?: IdentityState,
    rttMs?: number,
  ): void {
    const peer: PeerInfo = { peerId, name, status, address, lastSeenAt: Date.now(), latencyMs: rttMs }
    if (identityState) peer.identityState = identityState
    for (const listener of this.peerStatusListeners) listener(peer)
  }

  private emitError(scope: ErrorScope, message: string): void {
    for (const listener of this.errorListeners) listener(scope, message)
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.options.log?.(event, detail)
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
