// Worker A owns this file: implements P2PTransport over Bun TCP per .workers/worker-a-v1.md
//
// Wire protocol: newline-delimited JSON frames.
//   {"v":1,"type":"hello","nodeId":"...","name":"...","nonce":"...","attest":"..."}
//   {"v":1,"type":"prove","proof":"..."}
//   {"v":1,"type":"msg","id":"...","content":"..."}
//   {"v":1,"type":"ping","t":<ms>} / {"v":1,"type":"pong","t":<ms>}
//
// Handshake (mutual proof-of-possession; TOFU + derived verifier, HMAC-SHA256):
//   V_own = hex(HMAC-SHA256(key: seedBytes, msg: "nex-attest-v1:" + nodeId))
//   1. dialer    -> hello{nonce:Nd}
//   2. responder -> hello{nonce:Nr, attest:V_r} + prove{HMAC(V_r, Nd)}
//   3. dialer    -> prove{HMAC(V_d, Nr)}
//   4. each side verifies the OTHER's proof against the verifier REMEMBERED for
//      that nodeId: no record -> store the presented verifier, identityState
//      "unknown" (trust-on-first-use); recomputed HMAC equal -> "identified";
//      different -> "mismatch" + drop (record kept).
// dial() resolves only after the responder's prove verified (steps 3–4 complete).
//
// KNOWN LIMITATIONS (per brief): the verifier is transmitted once at first
// meeting, so an active MITM at exactly first meeting can swap tokens — outside
// v1 scope. This proves continuity of control of a nodeId, not real-world human
// identity (NEX_VISION_v1.md §7). The link itself remains plaintext TCP.
import type {
  ErrorScope,
  IdentityState,
  NodeIdentity,
  P2PTransport,
  PeerInfo,
  TransportEvents,
  Unsubscribe,
} from "../../core/contract.ts"
import type { AttestationRecord, AttestationStore } from "../../core/state/persistence"
import { deriveVerifier, hmacHex } from "../../core/identity"

const DEFAULT_PORT = 42_000
const MAX_PORT = 42_010 // bind 42000; if taken, walk up through 42001..42010
// An explicitly requested port above MAX_PORT used to get a single-shot bind:
// Math.max(startPort, MAX_PORT) collapsed the range, so a momentarily busy port
// (TIME_WAIT from a just-stopped listener, a lingering process, an OS-reserved
// range) failed outright. Walk such requests up by a small bounded window —
// same policy as the default range. Boundaries stay well clear of neighbouring
// test-port pins.
const EXPLICIT_PORT_FALLBACK = 8
const HANDSHAKE_TIMEOUT_MS = 5_000
const PING_TIMEOUT_MS = 3_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ""
  for (const byte of raw) out += byte.toString(16).padStart(2, "0")
  return out
}

type Frame =
  | { v: 1; type: "hello"; nodeId: string; name: string; nonce?: string; attest?: string }
  | { v: 1; type: "prove"; proof: string }
  | { v: 1; type: "msg"; id: string; content: string }
  | { v: 1; type: "ping"; t: number }
  | { v: 1; type: "pong"; t: number }

function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame) + "\n"
}

function parseFrame(line: string): Frame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const f = parsed as Partial<Frame>
  if (!f || f.v !== 1) return null
  switch (f.type) {
    case "hello":
      if (typeof f.nodeId !== "string" || typeof f.name !== "string") return null
      return {
        v: 1,
        type: "hello",
        nodeId: f.nodeId,
        name: f.name,
        nonce: typeof f.nonce === "string" ? f.nonce : undefined,
        attest: typeof f.attest === "string" ? f.attest : undefined,
      }
    case "prove":
      if (typeof f.proof !== "string") return null
      return { v: 1, type: "prove", proof: f.proof }
    case "msg":
      if (typeof f.id !== "string" || typeof f.content !== "string") return null
      return { v: 1, type: "msg", id: f.id, content: f.content }
    case "ping":
      if (typeof f.t !== "number") return null
      return { v: 1, type: "ping", t: f.t }
    case "pong":
      if (typeof f.t !== "number") return null
      return { v: 1, type: "pong", t: f.t }
    default:
      return null
  }
}

interface PendingHandshake {
  resolve: (peer: PeerInfo) => void
  reject: (err: Error) => void
}

/** Per-connection handshake bookkeeping. */
interface HandshakeSession {
  role: "dialer" | "responder"
  /** Our fresh nonce (hex). */
  myNonce: string
  peerNonce?: string
  /** Verifier the peer presented in its hello. */
  peerAttest?: string
  /** Verifier we will check proofs against (remembered record, else presented). */
  checkVerifier?: string
  /** True when we stored a brand-new record this meeting (TOFU). */
  tofuStored?: boolean
  provedByPeer?: boolean
  weSentProve?: boolean
  /** Prove frame held during an in-flight attestation lookup. */
  pendingProof?: string
}

interface PendingLatency {
  resolve: (ms: number | null) => void
  timer: Timer
}

interface PeerConnection {
  peerId: string
  name: string
  address: string
  /** True once the full handshake completed for this socket. */
  established: boolean
  /** Our hello has been sent (inbound side waits for theirs first). */
  helloSent: boolean
  session?: HandshakeSession
  pending?: PendingHandshake & { timer: Timer }
  /** Set when the close is intentional (drop/stop/replace) — suppresses reconnect. */
  closingLocal?: boolean
  /** Resulting identity state of this socket's handshake. */
  identityState?: IdentityState
  /** Timestamp of an outstanding ping, for round-trip latency. */
  pingSentAt?: number
  lastRttMs?: number
  pendingPing?: PendingLatency
}

export interface TcpTransportOptions {
  /**
   * Hex secret seed backing our nodeId. Never logged; used only to derive the
   * handshake verifier in-process. Omitting it disables proving (handshakes
   * fail closed for dial, respond unknown for inbound).
   */
  seedHex?: string
  /** Remembered peer verifiers (TOFU continuity). Omitting keeps states "unknown". */
  attestations?: AttestationStore
}

/** Auto-reconnect bookkeeping (Task 3), keyed by peerId. */
interface ReconnectState {
  address: string
  name: string
  attempts: number
  timer?: Timer
}

export class TcpTransport implements P2PTransport {
  private server: Bun.TCPSocketListener<Uint8Array> | null = null
  private boundPort: number | null = null
  private identity: NodeIdentity | null = null
  private stopped = false
  private readonly seedHex?: string
  private readonly attestations?: AttestationStore

  private readonly connections = new Map<string, PeerConnection>()
  private readonly buffers = new Map<Bun.Socket<Uint8Array>, string>()
  private readonly sockets = new Map<Bun.Socket<Uint8Array>, PeerConnection>()
  private readonly dialing = new Map<string, Promise<PeerInfo>>()

  /** Auto-reconnect state (Task 3), keyed by peerId. */
  private readonly reconnecting = new Map<string, ReconnectState>()

  private readonly peerStatusListeners = new Set<(peer: PeerInfo) => void>()
  private readonly messageListeners = new Set<(peerId: string, content: string, receivedAt: number) => void>()
  private readonly errorListeners = new Set<(scope: ErrorScope, message: string) => void>()

  constructor(options: TcpTransportOptions = {}) {
    this.seedHex = options.seedHex
    this.attestations = options.attestations
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
            open: (socket) => this.onSocketOpen(socket),
            data: (socket, chunk) => this.onSocketData(socket, chunk),
            close: (socket) => this.onSocketClose(socket),
            error: (socket, err) => this.onSocketError(socket, err),
          },
        })
        this.boundPort = port
        return port
      } catch {
        // Port taken — try the next one in range.
      }
    }
    throw new Error(`no free port in ${startPort}..${endPort}`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cancelAllReconnect()
    for (const conn of [...this.connections.values()]) {
      const { peerId, name, address } = conn
      this.closeConnection(conn, "offline")
      this.emitPeerStatus(peerId, name, address, "offline")
    }
    this.connections.clear()
    this.sockets.clear()
    this.buffers.clear()
    this.dialing.clear()
    if (this.server) {
      // Await teardown fully: abandoning it early (the old 250ms race) let
      // stop() return while the OS still held the port, so an immediate
      // re-bind — test cleanup, restart-on-same-port — raced EADDRINUSE.
      await this.server.stop(true)
      this.server = null
      this.boundPort = null
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop()
  }

  /** Exposed for tests: reconnect timers outstanding right now. */
  get pendingReconnectCount(): number {
    let count = 0
    for (const state of this.reconnecting.values()) if (state.timer) count++
    return count
  }

  /** Exposed for tests: peers currently in the reconnect loop. */
  get reconnectingPeerIds(): string[] {
    return [...this.reconnecting.keys()]
  }

  // ---------- outbound ----------

  async dial(address: string): Promise<PeerInfo> {
    if (!this.identity) throw new Error("transport not started")

    const existing = this.findByAddress(address)
    if (existing && existing.established) {
      return this.toPeerInfo(existing, "connected")
    }
    const inflight = this.dialing.get(address)
    if (inflight) return inflight

    const attempt = this.dialOnce(address).finally(() => this.dialing.delete(address))
    this.dialing.set(address, attempt)
    return attempt
  }

  private dialOnce(address: string): Promise<PeerInfo> {
    const split = this.splitAddress(address)
    if (!this.seedHex || !this.identity) {
      return Promise.reject(new Error(`cannot prove identity (no seed configured): ${address}`))
    }
    return new Promise<PeerInfo>((resolve, reject) => {
      let dialSocket: Bun.Socket<Uint8Array> | null = null
      const timer = setTimeout(() => {
        // Fail closed: tear down any half-open socket, not just reject the promise.
        if (dialSocket) {
          this.onSocketClose(dialSocket)
          try {
            dialSocket.end()
          } catch {
            // Already gone.
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
            const session: HandshakeSession = {
              role: "dialer",
              myNonce: randomHex(32),
            }
            const conn: PeerConnection = {
              peerId: "",
              name: "",
              address,
              established: false,
              helloSent: false,
              session,
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
            this.sendHello(socket)
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
    this.closeConnection(conn, "offline")
  }

  async send(peerId: string, content: string): Promise<void> {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established) throw new Error(`not connected: ${peerId}`)
    const socket = this.socketFor(conn)
    if (!socket) throw new Error(`not connected: ${peerId}`)
    const frame: Frame = { v: 1, type: "msg", id: crypto.randomUUID(), content }
    socket.write(encodeFrame(frame))
  }

  /**
   * Round-trip latency to an established peer via ping/pong.
   * Resolves with the measured ms, or null on timeout/not-connected.
   * One measurement in flight at a time per peer.
   */
  measureLatency(peerId: string): Promise<number | null> {
    const conn = this.connections.get(peerId)
    if (!conn || !conn.established || conn.pendingPing) return Promise.resolve(null)
    const socket = this.socketFor(conn)
    if (!socket) return Promise.resolve(null)

    return new Promise<number | null>((resolve) => {
      conn.pingSentAt = Date.now()
      const pending: PendingLatency = {
        resolve: (ms) => {
          clearTimeout(pending.timer)
          delete conn.pendingPing
          resolve(ms)
        },
        timer: setTimeout(() => pending.resolve(null), PING_TIMEOUT_MS),
      }
      conn.pendingPing = pending
      socket.write(encodeFrame({ v: 1, type: "ping", t: conn.pingSentAt }))
    })
  }

  get port(): number | null {
    return this.boundPort
  }

  // ---------- frame handling ----------

  private onSocketOpen(_socket: Bun.Socket<Uint8Array>): void {
    // Inbound connections identify themselves when their hello arrives;
    // dialed sockets attach themselves in dialOnce().
  }

  private onSocketData(socket: Bun.Socket<Uint8Array>, chunk: Uint8Array): void {
    const decoded = new TextDecoder().decode(chunk)
    const buffered = (this.buffers.get(socket) ?? "") + decoded
    const lines = buffered.split("\n")
    // Last element is the (possibly incomplete) remainder — put it back.
    this.buffers.set(socket, lines.pop() ?? "")
    for (const line of lines) {
      if (!line.trim()) continue
      const frame = parseFrame(line)
      if (frame) this.handleFrame(socket, frame)
    }
  }

  private handleFrame(socket: Bun.Socket<Uint8Array>, frame: Frame): void {
    switch (frame.type) {
      case "hello":
        return this.handleHello(socket, frame)
      case "prove":
        return this.handleProve(socket, frame)
      case "msg": {
        const conn = this.sockets.get(socket)
        if (conn && conn.established) {
          for (const listener of this.messageListeners) {
            listener(conn.peerId, frame.content, Date.now())
          }
        }
        return
      }
      case "ping": {
        socket.write(encodeFrame({ v: 1, type: "pong", t: frame.t }))
        return
      }
      case "pong": {
        const conn = this.sockets.get(socket)
        if (conn?.pingSentAt !== undefined) {
          const rttMs = Date.now() - frame.t
          conn.lastRttMs = rttMs
          conn.pingSentAt = undefined
          conn.pendingPing?.resolve(rttMs)
        }
        return
      }
    }
  }

  /** Process a peer hello: learn identity/verifier/nonce; TOFU-check the verifier. */
  private handleHello(socket: Bun.Socket<Uint8Array>, frame: Extract<Frame, { type: "hello" }>): void {
    const known = this.sockets.get(socket)

    if (known && known.established) {
      // Re-hello on an established socket: refresh name, ignore otherwise.
      known.name = frame.name
      return
    }

    const session = known?.session ?? { role: "responder" as const, myNonce: randomHex(32) }
    session.peerNonce = frame.nonce
    session.peerAttest = frame.attest

    const address = known?.address ?? this.remoteAddress(socket)
    const conn: PeerConnection = {
      peerId: frame.nodeId,
      name: frame.name,
      address,
      established: false,
      helloSent: known?.helloSent ?? false,
      session,
      pending: known?.pending,
      identityState: known?.identityState,
    }

    // A previous connection entry for the same node (e.g. reconnect) is replaced.
    const previous = this.connections.get(frame.nodeId)
    if (previous && previous !== known) {
      this.closeConnection(previous, "replace")
    }
    if (known && known.peerId && known.peerId !== frame.nodeId) {
      this.connections.delete(known.peerId)
    }

    this.detach(socket)
    this.attach(socket, conn)
    this.connections.set(conn.peerId, conn)

    // Verifier continuity check (step 5): remember-or-compare BEFORE trusting proofs.
    if (!frame.nodeId || !session.peerAttest || !session.peerNonce) {
      this.failHandshake(socket, conn, "hello missing nonce/attest")
      return
    }
    void this.resolveCheckVerifier(conn).then(() => {
      if (conn.session !== session) return // socket died meanwhile
      if (conn.identityState === "mismatch") {
        this.failHandshake(socket, conn, `verifier mismatch for ${frame.nodeId.slice(0, 8)}…`)
        return
      }
      this.continueAfterHello(socket, conn)
    })
  }

  /**
   * Look up the remembered verifier for the claiming nodeId and compare against
   * the presented attest. Sets conn.identityState accordingly:
   *   no record -> store presented (TOFU), state "unknown"
   *   equal     -> keep checking proof (state decided by proof verification)
   *   different -> "mismatch" (record kept, connection dropped by caller)
   */
  private async resolveCheckVerifier(conn: PeerConnection): Promise<void> {
    const session = conn.session!
    const presented = session.peerAttest!
    try {
      const record = await this.attestations?.get(conn.peerId)
      if (!record) {
        await this.storeAttestation(conn.peerId, presented)
        session.checkVerifier = presented
        session.tofuStored = true
        conn.identityState = "unknown"
        return
      }
      if (record.verifier.toLowerCase() === presented.toLowerCase()) {
        session.checkVerifier = record.verifier
        if (!conn.identityState || conn.identityState === "unknown") delete conn.identityState
        return
      }
      conn.identityState = "mismatch"
    } catch (err) {
      this.emitError("persistence", `attestation store: ${err instanceof Error ? err.message : String(err)}`)
      conn.identityState = "mismatch"
    }
  }

  /** After verifier continuity holds: reply-hello, send our proof, verify theirs. */
  private continueAfterHello(socket: Bun.Socket<Uint8Array>, conn: PeerConnection): void {
    const session = conn.session!

    this.sendHello(socket)
    // Our proof of possession: HMAC(V_own, peerNonce). No-op once sent.
    this.sendProof(socket, conn)

    // Their prove may have landed while the attestation lookup was in flight.
    if (session.pendingProof) {
      const proof = session.pendingProof
      delete session.pendingProof
      this.processProve(socket, conn, proof)
      return
    }
    this.maybeFinalize(socket, conn)
  }

  /** Verify the peer's proof and finish (or fail) the handshake. */
  private handleProve(socket: Bun.Socket<Uint8Array>, frame: Extract<Frame, { type: "prove" }>): void {
    const conn = this.sockets.get(socket)
    const session = conn?.session
    if (!conn || !session || conn.established || conn.identityState === "mismatch") return

    // Attestation lookup still deciding? Hold the proof until it lands
    // (the responder's prove races the dialer's store read).
    if (!session.checkVerifier || !session.myNonce) {
      session.pendingProof = frame.proof
      return
    }
    this.processProve(socket, conn, frame.proof)
  }

  private processProve(socket: Bun.Socket<Uint8Array>, conn: PeerConnection, proof: string): void {
    const session = conn.session!
    if (!session.checkVerifier || !session.myNonce) {
      this.failHandshake(socket, conn, "unexpected prove frame")
      return
    }

    const expected = hmacHex(session.checkVerifier, session.myNonce)
    if (!timingSafeEqual(proof, expected)) {
      conn.identityState = "mismatch"
      this.failHandshake(socket, conn, `proof mismatch for ${conn.peerId.slice(0, 8)}…`)
      return
    }

    session.provedByPeer = true
    if (conn.identityState !== "unknown") conn.identityState = "identified"
    this.maybeFinalize(socket, conn)
  }

  /**
   * Complete the handshake when every step has happened: peer proved itself and
   * we sent our own proof. Dialer resolves dial(); both sides emit connected.
   */
  private maybeFinalize(socket: Bun.Socket<Uint8Array>, conn: PeerConnection): void {
    const session = conn.session!
    if (!session.provedByPeer || !session.weSentProve || conn.established) return
    if (conn.identityState === "mismatch") return

    conn.established = true
    // A successful handshake ends any reconnect cycle for this peer — timer included.
    const stale = this.reconnecting.get(conn.peerId)
    if (stale?.timer) clearTimeout(stale.timer)
    this.reconnecting.delete(conn.peerId)

    const pending = conn.pending
    delete conn.pending
    pending?.resolve(this.toPeerInfo(conn, "connected"))
    this.emitPeerStatus(conn.peerId, conn.name, conn.address, "connected", conn.identityState, conn.lastRttMs)
  }

  private sendHello(socket: Bun.Socket<Uint8Array>): void {
    const conn = this.sockets.get(socket)
    if (!this.identity || !conn || conn.helloSent) return
    const session = conn.session
    socket.write(
      encodeFrame({
        v: 1,
        type: "hello",
        nodeId: this.identity.nodeId,
        name: this.identity.name,
        nonce: session?.myNonce,
        attest: this.ownVerifier(),
      }),
    )
    conn.helloSent = true
  }

  /** Send our proof: HMAC(V_own, peerNonce). Requires having seen their hello. */
  private sendProof(socket: Bun.Socket<Uint8Array>, conn: PeerConnection): void {
    const session = conn.session!
    if (session.weSentProve || !session.peerNonce || !this.seedHex) return
    const verifier = deriveVerifier(this.seedHex, this.identity!.nodeId)
    socket.write(encodeFrame({ v: 1, type: "prove", proof: hmacHex(verifier, session.peerNonce) }))
    session.weSentProve = true
  }

  private ownVerifier(): string | undefined {
    if (!this.seedHex || !this.identity) return undefined
    return deriveVerifier(this.seedHex, this.identity.nodeId)
  }

  private async storeAttestation(nodeId: string, verifier: string): Promise<void> {
    const now = Date.now()
    const record: AttestationRecord = { nodeId, verifier, firstSeenAt: now, lastSeenAt: now }
    await this.attestations?.put(record)
  }

  /** Reject + tear down a failed handshake; mismatch keeps its attestation record. */
  private failHandshake(socket: Bun.Socket<Uint8Array>, conn: PeerConnection, reason: string): void {
    const mismatch = conn.identityState === "mismatch"
    conn.pending?.reject(new Error(reason))
    delete conn.pending
    // Surface the state honestly before dropping (status offline, state kept).
    this.emitPeerStatus(
      conn.peerId || "unknown",
      conn.name,
      conn.address,
      "offline",
      mismatch ? "mismatch" : conn.identityState,
      conn.lastRttMs,
    )
    this.closeConnection(conn, mismatch ? "mismatch" : "failed")
    try {
      socket.end()
    } catch {
      // Already gone.
    }
  }

  // ---------- socket plumbing ----------

  private onSocketClose(socket: Bun.Socket<Uint8Array>): void {
    const conn = this.sockets.get(socket)
    this.detach(socket)
    if (!conn) return
    if (this.connections.get(conn.peerId) === conn) {
      this.connections.delete(conn.peerId)
    }
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
      for (const listener of this.errorListeners) {
        listener("transport", `${conn.address}: ${err.message}`)
      }
    }
    try {
      socket.end()
    } catch {
      // Socket may already be dead; close handler does the cleanup.
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

  /**
   * Close a connection. reason controls post-close behavior:
   *   "offline"  — intentional local drop: emit offline, no reconnect
   *   "replace"  — superseded by a newer connection to the same peer: silent
   *   "mismatch"/"failed" — handshake failed (failHandshake already reported)
   */
  private closeConnection(conn: PeerConnection, reason: "offline" | "replace" | "mismatch" | "failed"): void {
    conn.closingLocal = true
    const socket = this.socketFor(conn)
    conn.pending?.reject(new Error("connection dropped"))
    delete conn.pending
    conn.pendingPing?.resolve(null)
    if (socket) {
      this.detach(socket)
      try {
        socket.end()
      } catch {
        // Already closed.
      }
    }
    if (reason !== "replace" && this.connections.get(conn.peerId) === conn) {
      this.connections.delete(conn.peerId)
    }
  }

  private socketFor(conn: PeerConnection): Bun.Socket<Uint8Array> | null {
    for (const [socket, candidate] of this.sockets) {
      if (candidate === conn) return socket
    }
    return null
  }

  private findByAddress(address: string): PeerConnection | undefined {
    for (const conn of this.connections.values()) {
      if (conn.address === address) return conn
    }
    return undefined
  }

  private remoteAddress(socket: Bun.Socket<Uint8Array>): string {
    const raw = socket.remoteAddress ?? ""
    return this.normalizeAddress(raw, socket.remotePort)
  }

  private normalizeAddress(address: string, port?: number): string {
    // IPv6 loopback like "::1:port" or "[::1]" -> presentable host:port.
    let host = address.replace(/^::ffff:/, "")
    if (host.startsWith("::")) host = "127.0.0.1"
    if (host.endsWith(":") ) host = host.slice(0, -1)
    const parts = host.split(":").filter(Boolean)
    if (parts.length > 2) host = `[${parts.slice(0, -1).join(":")}]`
    else host = parts[0] ?? host
    const p = port ?? (Number(parts[parts.length - 1]) || 0)
    return `${host}:${p}`
  }

  private splitAddress(address: string): { hostname: string; rawPort: number } {
    const idx = address.lastIndexOf(":")
    if (idx === -1) throw new Error(`invalid address "${address}" (expected host:port)`)
    const hostname = address.startsWith("[")
      ? address.slice(1, address.indexOf("]"))
      : address.slice(0, idx)
    const rawPort = Number(address.slice(idx + 1))
    if (!hostname || !Number.isInteger(rawPort) || rawPort <= 0 || rawPort > 65535) {
      throw new Error(`invalid address "${address}" (expected host:port)`)
    }
    return { hostname, rawPort }
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

  // ---------- auto-reconnect (Task 3) ----------

  /**
   * Established connection dropped without a local drop(): go reconnecting and
   * redial the last address with exponential backoff (1s..30s cap, unlimited
   * attempts while running). Cancelled by drop(), stop(), or success.
   */
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
        .then(() => {
          // Success: handshake emitted "connected"; entry already deleted above.
        })
        .catch(() => {
          if (!this.stopped && !this.reconnecting.has(peerId)) {
            // Re-enter the loop carrying the advanced backoff counter.
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
}

/** Constant-time-ish hex comparison; lengths differ => not equal, no early exit on content. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
