// EncryptedTcpTransport — P2PTransport over TCP with a Noise_XX secure channel.
//
// Wire: every TCP write is one or more length-prefixed frames [u16be len][body].
//   handshake phase: body = raw Noise_XX message part (m1 | m2 | m3)
//   transport phase: body = AEAD ciphertext of an op-frame:
//     [op u8][...]  0x01 MSG(utf8 content) · 0x02 PING(u64be ms)
//     · 0x03 PONG(u64be ms) · 0x04 CTL(json ControlWire)
//     · 0x05 VOICE([u16be metaLen][meta json][payload bytes])
//
// Security properties (vision §22 "transport security", finally real):
//   - confidentiality + integrity: ChaCha20-Poly1305, per-message nonces
//   - mutual authentication of long-term X25519 keys inside the transcript
//   - MITM after first meeting impossible: TOFU continuity pins nodeId -> static
//     key in identities.json; a known nodeId presenting a different key is a
//     MISMATCH and the connection is dropped
//   - replay/reorder rejected by strict nonce counters (any AEAD failure drops
//     the link — the stream cannot recover past a broken frame by design)
import type {
  ControlWire,
  ErrorScope,
  IdentityState,
  NodeIdentity,
  P2PTransport,
  PeerInfo,
  TransportEvents,
  TransportSecurity,
  Unsubscribe,
  VoiceFrameMeta,
} from "../../core/contract.ts"
import { isKnownControl } from "../../core/contract"
import type { StaticKeyRecord, StaticKeyStore } from "../../core/state/persistence"
import { EPHEM_LEN, ENC_STATIC_LEN, NoiseHandshake } from "../noise/noise"
import { resolveIdentityBinding as resolveSharedBinding } from "../../core/session/identity-binding"

const DEFAULT_PORT = 42_000
const MAX_PORT = 42_010
// See tcp-transport.ts: explicit ports above MAX_PORT walk up by a small
// bounded window instead of failing on a momentarily busy port.
const EXPLICIT_PORT_FALLBACK = 8
const HANDSHAKE_TIMEOUT_MS = 5_000
const PING_TIMEOUT_MS = 3_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** u16 length prefix ceiling. */
const MAX_FRAME = 65_535
/** Safety valve: frames buffered while the TOFU binding check runs. */
const MAX_QUEUED_OPS = 256
/**
 * Largest op-frame plaintext we will ever encrypt.
 * Wire frame = [len u16][ciphertext]; ciphertext = plaintext + 16B Poly1305
 * tag. Budgeting MUST include the tag or a "legal" size throws inside
 * writeFrame AFTER the nonce advanced — the exact desync this guard exists
 * to prevent.
 */
const MAX_OP_PLAINTEXT = MAX_FRAME - 2 - 16

/**
 * Bumped to v3 when the Noise layer was corrected to spec (MixKey output
 * separation, MixKey for DH tokens, msg1 payload hashing). The transcript
 * changed, so an alpha.7-or-older node cannot complete a handshake with a
 * newer one — the prologue difference makes that fail immediately and
 * legibly instead of as an opaque AEAD error mid-stream.
 */
export const TRANSPORT_PROLOGUE = "nex-tcp-v3"

type OpFrame =
  | { op: 0x01; content: string }
  | { op: 0x02; t: number }
  | { op: 0x03; t: number }
  | { op: 0x04; control: ControlWire }
  | { op: 0x05; meta: VoiceFrameMeta; payload: Uint8Array }

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ""
  for (const byte of raw) out += byte.toString(16).padStart(2, "0")
  return out
}

function toHex(bytes: Uint8Array): string {
  let out = ""
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0")
  return out
}

interface PendingHandshake {
  resolve: (peer: PeerInfo) => void
  reject: (err: Error) => void
}

interface PeerConnection {
  peerId: string
  name: string
  address: string
  /** Noise state while handshaking; null once complete. */
  handshake?: NoiseHandshake
  sendCipher?: import("../noise/noise").CipherState
  receiveCipher?: import("../noise/noise").CipherState
  established: boolean
  /**
   * Op frames decrypted-ready but received before `established` flipped true
   * (the TOFU binding window). Buffered IN ORDER so stream counters stay in
   * lockstep; drained by establishConnection. Dropping them here would
   * desync AEAD nonces and kill the link on the peer's very next frame.
   */
  queuedOps?: Uint8Array[]
  /** Identity claimed inside the encrypted handshake payload. */
  claimed?: { nodeId: string; name: string }
  pending?: PendingHandshake & { timer: Timer }
  closingLocal?: boolean
  identityState?: IdentityState
  pingSentAt?: number
  lastRttMs?: number
  pendingPing?: { resolve: (ms: number | null) => void; timer: Timer }
}

interface ReconnectState {
  address: string
  name: string
  attempts: number
  timer?: Timer
}

export interface EncryptedTcpTransportOptions {
  /**
   * Our long-term X25519 private key (hex). Omitting it disables proving:
   * dials fail closed, inbound sessions stay unestablished.
   */
  identityPrivHex?: string
  /** TOFU continuity store for peer static keys. */
  bindings?: StaticKeyStore
}

export class EncryptedTcpTransport implements P2PTransport {
  readonly security: TransportSecurity = { encrypted: true }

  private server: Bun.TCPSocketListener<Uint8Array> | null = null
  private boundPort: number | null = null
  private identity: NodeIdentity | null = null
  private stopped = false
  private readonly identityPrivHex?: string
  private readonly bindings?: StaticKeyStore

  private readonly connections = new Map<string, PeerConnection>()
  private readonly buffers = new Map<Bun.Socket<Uint8Array>, Buffer>()
  private readonly sockets = new Map<Bun.Socket<Uint8Array>, PeerConnection>()
  private readonly dialing = new Map<string, Promise<PeerInfo>>()
  private readonly reconnecting = new Map<string, ReconnectState>()

  private readonly peerStatusListeners = new Set<(peer: PeerInfo) => void>()
  private readonly messageListeners = new Set<(peerId: string, content: string, receivedAt: number) => void>()
  private readonly controlListeners = new Set<(peerId: string, control: ControlWire) => void>()
  private readonly voiceListeners = new Set<(fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void>()
  private readonly errorListeners = new Set<(scope: ErrorScope, message: string) => void>()

  constructor(options: EncryptedTcpTransportOptions = {}) {
    this.identityPrivHex = options.identityPrivHex
    this.bindings = options.bindings
  }

  // ---------- TransportEvents ----------

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

  onError(callback: (scope: ErrorScope, message: string) => void): Unsubscribe {
    this.errorListeners.add(callback)
    return () => this.errorListeners.delete(callback)
  }

  // ---------- lifecycle ----------

  async start(options: { port?: number; identity: NodeIdentity }): Promise<number> {
    if (this.server) throw new Error("transport already started")
    if (this.stopped) throw new Error("transport stopped")
    this.identity = options.identity

    const startPort = options.port ?? DEFAULT_PORT
    const endPort = startPort > MAX_PORT ? startPort + EXPLICIT_PORT_FALLBACK : MAX_PORT
    for (let port = startPort; port <= endPort; port++) {
      try {
        this.server = Bun.listen<Uint8Array>({
          hostname: "0.0.0.0",
          port,
          socket: {
            open: () => {},
            data: (socket, chunk) => this.onSocketData(socket, chunk),
            close: (socket) => this.onSocketClose(socket),
            error: (socket, err) => this.onSocketError(socket, err),
          },
        })
        this.boundPort = port
        return port
      } catch {
        // Port taken — walk up the range.
      }
    }
    throw new Error(`no free port in ${startPort}..${endPort}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cancelAllReconnect()
    for (const conn of [...this.connections.values()]) {
      const { peerId, name, address } = conn
      this.closeConnection(conn)
      this.emitPeerStatus(peerId, name, address, "offline")
    }
    this.connections.clear()
    this.sockets.clear()
    this.buffers.clear()
    this.dialing.clear()
    if (this.server) {
      // Await teardown fully — see tcp-transport.ts. Abandoning it early let
      // stop() return while the OS still held the port.
      await this.server.stop(true)
      this.server = null
      this.boundPort = null
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  get port(): number | null {
    return this.boundPort
  }

  /** Test hooks mirroring TcpTransport. */
  get pendingReconnectCount(): number {
    let count = 0
    for (const state of this.reconnecting.values()) if (state.timer) count++
    return count
  }

  get reconnectingPeerIds(): string[] {
    return [...this.reconnecting.keys()]
  }

  // ---------- outbound ----------

  async dial(address: string): Promise<PeerInfo> {
    if (!this.identity) throw new Error("transport not started")
    const existing = this.findByAddress(address)
    if (existing && existing.established) return this.toPeerInfo(existing, "connected")

    const inflight = this.dialing.get(address)
    if (inflight) return inflight
    const attempt = this.dialOnce(address).finally(() => this.dialing.delete(address))
    this.dialing.set(address, attempt)
    return attempt
  }

  private dialOnce(address: string): Promise<PeerInfo> {
    const split = this.splitAddress(address)
    if (!this.identityPrivHex || !this.identity) {
      return Promise.reject(new Error(`cannot prove identity (no key configured): ${address}`))
    }
    return new Promise<PeerInfo>((resolve, reject) => {
      let dialSocket: Bun.Socket<Uint8Array> | null = null
      const timer = setTimeout(() => {
        if (dialSocket) {
          this.onSocketClose(dialSocket)
          try {
            dialSocket.end()
          } catch {
            /* already gone */
          }
        }
        reject(new Error(`handshake timeout: ${address}`))
      }, HANDSHAKE_TIMEOUT_MS)

      Bun.connect<Uint8Array>({
        hostname: split.hostname,
        port: split.rawPort,
        socket: {
          open: (socket) => {
            dialSocket = socket
            const handshake = new NoiseHandshake("initiator", hexToBytes(this.identityPrivHex!), TRANSPORT_PROLOGUE)
            const conn: PeerConnection = {
              peerId: "",
              name: "",
              address,
              handshake,
              established: false,
            }
            conn.pending = {
              resolve: (peer) => {
                clearTimeout(timer)
                resolve(peer)
              },
              reject: (err) => {
                clearTimeout(timer)
                reject(err)
              },
              timer,
            }
            this.attach(socket, conn)
            // m1: "-> e" with an EMPTY payload. m1 is pre-key: anything placed
            // in it travels in the clear, so our identity must not be armed
            // until after m1 is on the wire.
            this.writeFrame(socket, handshake.start())
            // Identity payload rides m3, encrypted under the handshake keys.
            handshake.setNextPayload(encJson({ nodeId: this.identity!.nodeId, name: this.identity!.name }))
          },
          data: (socket, chunk) => this.onSocketData(socket, chunk),
          close: (socket) => {
            this.onSocketClose(socket)
            const conn = this.sockets.get(socket)
            conn?.pending?.reject(new Error(`connection closed during handshake: ${address}`))
          },
          error: (socket, err) => {
            this.onSocketError(socket, err)
            const conn = this.sockets.get(socket)
            conn?.pending?.reject(new Error(`dial failed: ${address} (${err.message})`))
          },
        },
      }).catch((err: Error) => {
        clearTimeout(timer)
        reject(new Error(`dial failed: ${address} (${err.message})`))
      })
    })
  }

  async drop(peerId: string): Promise<void> {
    const reconnect = this.reconnecting.get(peerId)
    if (reconnect?.timer) clearTimeout(reconnect.timer)
    this.reconnecting.delete(peerId)
    const conn = this.connections.get(peerId)
    if (!conn) return
    this.closeConnection(conn)
  }

  async send(peerId: string, content: string): Promise<void> {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established || !conn.sendCipher) throw new Error(`not connected: ${peerId}`)
    const socket = this.socketFor(conn)
    if (!socket) throw new Error(`not connected: ${peerId}`)
    this.writeOpFrame(socket, conn, { op: 0x01, content })
  }

  async sendControl(peerId: string, control: ControlWire): Promise<void> {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established || !conn.sendCipher) throw new Error(`not connected: ${peerId}`)
    const socket = this.socketFor(conn)
    if (!socket) throw new Error(`not connected: ${peerId}`)
    this.writeOpFrame(socket, conn, { op: 0x04, control })
  }

  /**
   * Send one voice frame inside the secure channel. Fire-and-forget by design:
   * realtime audio never waits on or retries a send (vision §19 semantics).
   */
  sendVoiceFrame(peerId: string, meta: VoiceFrameMeta, payload: Uint8Array): void {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established || !conn.sendCipher) return
    const socket = this.socketFor(conn)
    if (!socket) return
    try {
      this.writeOpFrame(socket, conn, { op: 0x05, meta, payload })
    } catch {
      // A dropped voice frame is better than a dead link; the seq counter
      // lets the receiver detect the gap.
    }
  }

  /** Subscribe to inbound voice frames from peers. */
  onVoiceFrame(callback: (fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void): Unsubscribe {
    this.voiceListeners.add(callback)
    return () => this.voiceListeners.delete(callback)
  }

  measureLatency(peerId: string): Promise<number | null> {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established || conn.pendingPing) return Promise.resolve(null)
    const socket = this.socketFor(conn)
    if (!socket) return Promise.resolve(null)

    return new Promise<number | null>((resolve) => {
      conn.pingSentAt = Date.now()
      const pending = {
        resolve: (ms: number | null) => {
          clearTimeout(pending.timer)
          delete conn.pendingPing
          resolve(ms)
        },
        timer: setTimeout(() => pending.resolve(null), PING_TIMEOUT_MS),
      }
      conn.pendingPing = pending
      this.writeOpFrame(socket, conn, { op: 0x02, t: conn.pingSentAt })
    })
  }

  // ---------- frame plumbing ----------

  private writeFrame(socket: Bun.Socket<Uint8Array>, body: Uint8Array): void {
    if (body.length > MAX_FRAME - 2) throw new Error("frame too large")
    const frame = new Uint8Array(2 + body.length)
    new DataView(frame.buffer).setUint16(0, body.length)
    frame.set(body, 2)
    socket.write(frame)
  }

  private writeOpFrame(socket: Bun.Socket<Uint8Array>, conn: PeerConnection, frame: OpFrame): void {
    if (!conn.sendCipher) throw new Error("secure channel not established")
    // INVARIANT: once encryptWithAd advances the send nonce, writing MUST
    // succeed — a throw here would burn a counter silently and permanently
    // desync the stream (peer rejects everything after with "invalid tag").
    // So every failure mode is resolved BEFORE encryption: validate sizes up
    // front and let writeFrame be the belt-and-suspenders that never trips.
    let plaintext: Uint8Array
    if (frame.op === 0x01) {
      const body = new TextEncoder().encode(frame.content)
      if (body.length > MAX_OP_PLAINTEXT - 1) {
        throw new Error(`message too large (${body.length} bytes; max ${MAX_OP_PLAINTEXT - 1})`)
      }
      plaintext = Uint8Array.from([0x01, ...body])
    } else if (frame.op === 0x04) {
      const body = encJson(frame.control)
      if (body.length > MAX_OP_PLAINTEXT - 1) throw new Error("control op too large")
      plaintext = Uint8Array.from([0x04, ...body])
    } else if (frame.op === 0x05) {
      // [0x05][u16be metaLen][meta json][payload]
      const metaBody = encJson(frame.meta)
      if (metaBody.length > 0xffff) throw new Error("voice frame meta too large")
      const total = 1 + 2 + metaBody.length + frame.payload.length
      if (total > MAX_OP_PLAINTEXT) throw new Error("voice frame too large")
      const plain = new Uint8Array(total)
      plain[0] = 0x05
      new DataView(plain.buffer).setUint16(1, metaBody.length)
      plain.set(metaBody, 3)
      plain.set(frame.payload, 3 + metaBody.length)
      plaintext = plain
    } else {
      const body = new Uint8Array(9)
      body[0] = frame.op
      new DataView(body.buffer).setBigUint64(1, BigInt(Math.min(frame.t, Number.MAX_SAFE_INTEGER)))
      plaintext = body
    }
    const ciphertext = conn.sendCipher.encryptWithAd(new Uint8Array(0), plaintext)
    this.writeFrame(socket, ciphertext)
  }

  private onSocketData(socket: Bun.Socket<Uint8Array>, chunk: Uint8Array): void {
    const buffered = Buffer.concat([this.buffers.get(socket) ?? Buffer.alloc(0), Buffer.from(chunk)])
    let offset = 0
    try {
      while (offset + 2 <= buffered.length) {
        const len = buffered.readUInt16BE(offset)
        if (offset + 2 + len > buffered.length) break
        const body = buffered.subarray(offset + 2, offset + 2 + len)
        offset += 2 + len
        this.handleBody(socket, body)
      }
      this.buffers.set(socket, buffered.subarray(offset))
    } catch (err) {
      // Any protocol/AEAD failure poisons the stream: drop the link.
      const conn = this.sockets.get(socket)
      this.emitError("transport", `${conn?.address ?? "peer"}: ${(err as Error).message}`)
      if (conn) {
        conn.pending?.reject(err instanceof Error ? err : new Error(String(err)))
        delete conn.pending
        this.closeConnection(conn)
      }
      try {
        socket.end()
      } catch {
        /* already gone */
      }
    }
  }

  private handleBody(socket: Bun.Socket<Uint8Array>, body: Uint8Array): void {
    const conn = this.sockets.get(socket) ?? null

    // ---- handshake phase (creates the responder connection when anonymous) ----
    if (!conn || (!conn.established && !conn.receiveCipher)) {
      this.handleHandshakeBody(socket, conn, body)
      return
    }

    // ---- secure transport phase ----
    if (!conn.established) {
      // Handshake crypto is done (ciphers exist) but the binding check is still
      // running: queue instead of decrypting now so ordering/counters hold.
      const queue = (conn.queuedOps ??= [])
      if (queue.length >= MAX_QUEUED_OPS) {
        throw new Error(`pre-establish frame flood (> ${MAX_QUEUED_OPS} queued)`)
      }
      queue.push(body)
      return
    }
    if (!conn.receiveCipher) return
    const plaintext = conn.receiveCipher.decryptWithAd(new Uint8Array(0), body)
    this.dispatchOp(conn, plaintext)
  }

  private handleHandshakeBody(socket: Bun.Socket<Uint8Array>, existing: PeerConnection | null, body: Uint8Array): void {
    let conn = existing

    // Inbound connections arrive anonymous: the first frame must be a Noise m1
    // ephemeral, which we answer as the responder role.
    if (!conn) {
      if (!this.identityPrivHex || !this.identity) return // fail closed: cannot prove ourselves
      const handshake = new NoiseHandshake("responder", hexToBytes(this.identityPrivHex), TRANSPORT_PROLOGUE)
      handshake.setNextPayload(encJson({ nodeId: this.identity.nodeId, name: this.identity.name }))
      conn = {
        peerId: "",
        name: "",
        address: this.remoteAddress(socket),
        handshake,
        established: false,
      }
      this.attach(socket, conn)
    }

    const hs = conn.handshake
    if (!hs || hs.complete) return

    if (hs.awaitingFirstMessage) {
      // Strict, not >=: m1 is pre-key, so a payload here would be plaintext.
      // Nex never sends one and refuses to accept one.
      if (body.length !== EPHEM_LEN) throw new Error("bad handshake: expected bare m1 ephemeral")
      const m2 = hs.feed(body)!
      this.writeFrame(socket, m2)
      return
    }

    // Initiator receiving m2 (reply = m3), or responder receiving m3 (reply = null).
    const reply = hs.feed(body)
    if (reply) this.writeFrame(socket, reply)
    if (hs.complete) this.finishHandshake(socket, conn)
  }

  private finishHandshake(socket: Bun.Socket<Uint8Array>, conn: PeerConnection): void {
    const result = conn.handshake!.result
    conn.sendCipher = result.send
    conn.receiveCipher = result.receive

    let claimed: { nodeId?: string; name?: string }
    try {
      claimed = JSON.parse(new TextDecoder().decode(result.remotePayload))
    } catch {
      throw new Error("handshake payload not valid identity JSON")
    }
    if (!claimed.nodeId || typeof claimed.nodeId !== "string") throw new Error("handshake payload missing nodeId")
    conn.claimed = { nodeId: claimed.nodeId, name: typeof claimed.name === "string" ? claimed.name : "" }

    // Dream vision §17: make the invisible relationship readable. The crypto is
    // done but proof-of-possession (TOFU binding) hasn't resolved yet — that
    // window is exactly "authenticating", and we surface it honestly.
    this.emitPeerStatus(conn.claimed.nodeId, conn.claimed.name, conn.address, "authenticating")

    // Binding decision may be async (store I/O) but the crypto is already done;
    // mark established only after the TOFU check passes.
    void this.resolveIdentityBinding(conn)
      .then(() => {
        if (conn.identityState === "mismatch") {
          const claimedId = conn.claimed!.nodeId
          const reason = `identity mismatch for ${claimedId.slice(0, 8)}…`
          this.emitPeerStatus(claimedId, conn.claimed!.name, conn.address, "offline", "mismatch", conn.lastRttMs)
          this.closeConnection(conn)
          conn.pending?.reject(new Error(reason))
          delete conn.pending
          try {
            socket.end()
          } catch {
            /* gone */
          }
          return
        }
        this.establishConnection(conn)
      })
      .catch((err) => {
        conn.pending?.reject(err instanceof Error ? err : new Error(String(err)))
        delete conn.pending
        this.closeConnection(conn)
        try {
          socket.end()
        } catch {
          /* gone */
        }
      })
  }

  private establishConnection(conn: PeerConnection): void {
    conn.established = true
    conn.handshake = undefined
    const stale = this.reconnecting.get(conn.claimed!.nodeId)
    if (stale?.timer) clearTimeout(stale.timer)
    this.reconnecting.delete(conn.claimed!.nodeId)

    const previous = this.connections.get(conn.claimed!.nodeId)
    if (previous && previous !== conn) this.closeConnection(previous)
    this.connections.delete(conn.peerId) // old placeholder id, if any
    conn.peerId = conn.claimed!.nodeId
    conn.name = conn.claimed!.name
    this.connections.set(conn.peerId, conn)

    const queued = conn.queuedOps ?? []
    conn.queuedOps = undefined

    const pending = conn.pending
    delete conn.pending
    pending?.resolve(this.toPeerInfo(conn, "connected"))
    this.emitPeerStatus(conn.peerId, conn.name, conn.address, "connected", conn.identityState, conn.lastRttMs)

    // Replay anything the peer sent while our binding check was in flight,
    // preserving wire order (see PeerConnection.queuedOps).
    for (const body of queued) {
      if (!conn.receiveCipher) break
      try {
        const plaintext = conn.receiveCipher.decryptWithAd(new Uint8Array(0), body)
        this.dispatchOp(conn, plaintext)
      } catch (err) {
        this.emitError("transport", `${conn.address}: ${(err as Error).message}`)
        this.closeConnection(conn)
        return
      }
    }
  }

  /**
   * TOFU over static keys: no record -> store and mark unknown; equal ->
   * identified; different -> mismatch (record kept, caller drops the link).
   */
  private async resolveIdentityBinding(conn: PeerConnection): Promise<void> {
    // Delegated to the shared implementation. TCP and UDP are two ways to move
    // bytes; who is at the other end must be decided identically for both, and
    // a second copy here is how the two would quietly diverge.
    conn.identityState = await resolveSharedBinding(
      conn.claimed!.nodeId,
      toHex(conn.handshake!.result.remoteStaticKey),
      this.bindings,
      Date.now(),
      (m) => this.emitError("persistence", m),
    )
  }

  private dispatchOp(conn: PeerConnection, plaintext: Uint8Array): void {
    const op = plaintext[0]
    if (op === 0x01) {
      const content = new TextDecoder().decode(plaintext.slice(1))
      for (const listener of this.messageListeners) listener(conn.peerId, content, Date.now())
      return
    }
    if (op === 0x02) {
      const t = Number(new DataView(plaintext.buffer, plaintext.byteOffset).getBigUint64(1))
      const socket = this.socketFor(conn)
      if (socket) this.writeOpFrame(socket, conn, { op: 0x03, t })
      return
    }
    if (op === 0x03) {
      if (conn.pingSentAt !== undefined) {
        const sentAt = Number(new DataView(plaintext.buffer, plaintext.byteOffset).getBigUint64(1))
        const rttMs = Date.now() - sentAt
        conn.lastRttMs = rttMs
        conn.pingSentAt = undefined
        conn.pendingPing?.resolve(rttMs)
      }
      return
    }
    if (op === 0x04) {
      let control: ControlWire
      try {
        control = JSON.parse(new TextDecoder().decode(plaintext.slice(1))) as ControlWire
      } catch {
        throw new Error("control op not valid JSON")
      }
      if (!isKnownControl(control)) {
        // Unknown control kinds are DROPPED, never fatal: an older node must
        // keep its link when a newer peer sends room/voice ops it can't parse.
        return
      }
      for (const listener of this.controlListeners) listener(conn.peerId, control)
      return
    }
    if (op === 0x05) {
      // [u16be metaLen][meta json][payload]; malformed frames are dropped, not fatal.
      if (plaintext.length < 3) return
      const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset).getUint16(1)
      if (3 + metaLen > plaintext.length) return
      let meta: VoiceFrameMeta
      try {
        meta = JSON.parse(new TextDecoder().decode(plaintext.slice(3, 3 + metaLen))) as VoiceFrameMeta
      } catch {
        return
      }
      if (!meta || typeof meta.roomId !== "string" || typeof meta.fromPeerId !== "string") return
      const payload = plaintext.slice(3 + metaLen)
      for (const listener of this.voiceListeners) listener(conn.peerId, meta, payload)
      return
    }
    throw new Error(`unknown op ${op}`)
  }

  // ---------- connection bookkeeping (mirrors v1 TCP semantics) ----------

  private onSocketClose(socket: Bun.Socket<Uint8Array>): void {
    const conn = this.sockets.get(socket)
    this.detach(socket)
    if (!conn) return
    if (this.connections.get(conn.peerId) === conn) this.connections.delete(conn.peerId)
    conn.pendingPing?.resolve(null)
    conn.pending?.reject(new Error("closed before handshake completed"))

    if (conn.established && !conn.closingLocal && !this.stopped) {
      this.scheduleReconnect(conn.peerId, conn.address, conn.name)
    } else if (conn.established && conn.closingLocal) {
      this.emitPeerStatus(conn.peerId, conn.name, conn.address, "offline")
    }
  }

  private onSocketError(socket: Bun.Socket<Uint8Array>, err: Error): void {
    const conn = this.sockets.get(socket)
    if (conn?.established) {
      for (const listener of this.errorListeners) listener("transport", `${conn.address}: ${err.message}`)
    }
    try {
      socket.end()
    } catch {
      /* close handler cleans up */
    }
  }

  private attach(socket: Bun.Socket<Uint8Array>, conn: PeerConnection): void {
    this.sockets.set(socket, conn)
    this.buffers.delete(socket)
  }

  private detach(socket: Bun.Socket<Uint8Array>): void {
    this.sockets.delete(socket)
    this.buffers.delete(socket)
  }

  private closeConnection(conn: PeerConnection): void {
    conn.closingLocal = true
    conn.queuedOps = undefined
    const socket = this.socketFor(conn)
    conn.pending?.reject(new Error("connection dropped"))
    delete conn.pending
    conn.pendingPing?.resolve(null)
    if (socket) {
      this.detach(socket)
      try {
        socket.end()
      } catch {
        /* already closed */
      }
    }
    if (this.connections.get(conn.peerId) === conn) this.connections.delete(conn.peerId)
  }

  private socketFor(conn: PeerConnection): Bun.Socket<Uint8Array> | null {
    for (const [socket, candidate] of this.sockets) {
      if (candidate === conn) return socket
    }
    return null
  }

  private remoteAddress(socket: Bun.Socket<Uint8Array>): string {
    const raw = socket.remoteAddress ?? ""
    return this.normalizeAddress(raw, socket.remotePort)
  }

  private normalizeAddress(address: string, port?: number): string {
    // IPv6 loopback like "::1:port" or "[::1]" -> presentable host:port.
    let host = address.replace(/^::ffff:/, "")
    if (host.startsWith("::")) host = "127.0.0.1"
    if (host.endsWith(":")) host = host.slice(0, -1)
    const parts = host.split(":").filter(Boolean)
    if (parts.length > 2) host = `[${parts.slice(0, -1).join(":")}]`
    else host = parts[0] ?? host
    const p = port ?? (Number(parts[parts.length - 1]) || 0)
    return `${host}:${p}`
  }

  private findByAddress(address: string): PeerConnection | undefined {
    for (const conn of this.connections.values()) {
      if (conn.address === address) return conn
    }
    return undefined
  }

  private toPeerInfo(conn: PeerConnection, status: PeerInfo["status"]): PeerInfo {
    const peer: PeerInfo = {
      peerId: conn.peerId,
      name: conn.name,
      status,
      address: conn.address,
      lastSeenAt: Date.now(),
      latencyMs: conn.lastRttMs,
    }
    if (conn.identityState) peer.identityState = conn.identityState
    return peer
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

  // ---------- auto-reconnect ----------

  private scheduleReconnect(peerId: string, address: string, name: string): void {
    if (this.stopped || this.connections.has(peerId)) return
    const existing = this.reconnecting.get(peerId)
    if (existing?.timer) return

    const state: ReconnectState = existing ?? { address, name, attempts: 0 }
    state.address = address
    state.name = name || existing?.name || peerId.slice(0, 8)
    if (!existing) this.reconnecting.set(peerId, state)

    this.emitPeerStatus(peerId, state.name, state.address, "reconnecting")

    const attempt = state.attempts
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
    const timer = setTimeout(() => {
      state.timer = undefined
      this.reconnecting.delete(peerId)
      if (this.stopped) return
      void this.dial(address)
        .then(() => {})
        .catch(() => {
          if (!this.stopped && !this.reconnecting.has(peerId)) {
            this.reconnecting.set(peerId, { address, name: state.name, attempts: attempt + 1 })
            this.scheduleReconnect(peerId, address, state.name)
          }
        })
    }, delay)
    state.timer = timer
  }

  private cancelAllReconnect(): void {
    for (const state of this.reconnecting.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    this.reconnecting.clear()
  }

  private splitAddress(address: string): { hostname: string; rawPort: number } {
    const idx = address.lastIndexOf(":")
    if (idx === -1) throw new Error(`invalid address "${address}" (expected host:port)`)
    const hostname = address.startsWith("[") ? address.slice(1, address.indexOf("]")) : address.slice(0, idx)
    const rawPort = Number(address.slice(idx + 1))
    if (!hostname || !Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) {
      throw new Error(`invalid address "${address}" (expected host:port)`)
    }
    return { hostname, rawPort }
  }
}

function encJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
