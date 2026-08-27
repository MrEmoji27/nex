// Rendezvous client — the optional Internet-scale discovery source.
//
// Wire contract doc/RENDEZVOUS_WIRE_V1.md §5, §7, §10.
//
// Three things this client is careful about:
//
//   Presence is a lease, not a session. We refresh on a timer and never assume
//   the service remembers us. If this process dies, the lease lapses on its own
//   and we become undiscoverable — no logout required (V3 §6).
//
//   CONNECTED and CONNECTABLE are separate facts (V3 §7). The control socket
//   being up says nothing about whether a usable descriptor is published, and
//   vice versa. The client never infers one from the other and never invents
//   presence it has not confirmed.
//
//   The service is an untrusted introducer (V3 §16). Everything it hands us is a
//   candidate. The identity check happens at the Noise handshake, in app.ts,
//   using the same hard stop as invites and LAN discovery.
import {
  DOMAIN,
  SigningInput,
  bytesToHex,
  deriveSigningKey,
  sign,
  type RendezvousSigningKey,
} from "./framing"
import {
  signContactDescriptor,
  signPublicDescriptor,
  verifyContactDescriptor,
  verifyPublicDescriptor,
  type ContactDescriptor,
  type PublicDescriptor,
  type TransportCandidate,
} from "./descriptor"
import { open as openSealed, seal } from "./seal"

/** Lifetime we ask for on each published descriptor. Contract caps this at 300 s. */
const DESCRIPTOR_TTL_MS = 90_000
/** How long an introduction request stays answerable. Contract caps this at 120 s. */
const INTRODUCTION_TTL_MS = 120_000
const CONTROL_PING_MS = 30_000
const BACKOFF_MIN_MS = 2_000
const BACKOFF_MAX_MS = 60_000
/** Refresh jitter, ±10%, so a restarted service does not get a synchronized stampede. */
const REFRESH_JITTER = 0.1

export interface RendezvousIdentityInput {
  nodeId: string
  seedHex: string
  noisePub: string
}

/** Minimal WebSocket surface, so tests can inject one without a real socket. */
export interface ControlSocket {
  send(data: string): void
  close(code?: number): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: () => void): void
  onError(cb: (err: unknown) => void): void
}

export interface RendezvousEvents {
  /** Someone is looking for us and we have not answered yet. */
  introductionRequest(req: {
    requestId: string
    fromHandle: string
    fromContactDescriptor: ContactDescriptor
    expiresAt: number
  }): void
  /** A peer answered our request. `accept: false` carries no descriptor. */
  introductionResponse(res: {
    requestId: string
    accept: boolean
    contactDescriptor?: ContactDescriptor
  }): void
  /** CONNECTED / CONNECTABLE changed. Both are reported, never conflated. */
  stateChanged(state: RendezvousState): void
  error(message: string): void
}

export interface RendezvousState {
  /** A live control channel is attached. */
  connected: boolean
  /** A current descriptor is published, giving peers a path to dial us. */
  connectable: boolean
  handle: string | null
  /** Lease expiry (unix ms); null when nothing is published. */
  expiresAt: number | null
}

export interface RendezvousClientOptions {
  baseUrl: string
  identity: RendezvousIdentityInput
  handle: string
  capabilities: string[]
  /** Where we can be reached. Empty means we publish presence but cannot be dialed. */
  candidates: TransportCandidate[]
  events: Partial<RendezvousEvents>
  fetchImpl?: typeof fetch
  /** Injected for tests; real use opens a WebSocket. */
  openSocket?: (url: string, headers: Record<string, string>) => ControlSocket
  now?: () => number
}

export class RendezvousError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "RendezvousError"
  }
}

export class RendezvousClient {
  private readonly key: RendezvousSigningKey
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly base: string

  private leaseId: string | null = null
  private expiresAt: number | null = null
  private socket: ControlSocket | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private backoffMs = BACKOFF_MIN_MS
  /** Backoff for control-channel reattachment, grown on every drop (§10). */
  private reattachMs = BACKOFF_MIN_MS
  private running = false
  private lastState: RendezvousState | null = null
  /**
   * requestId -> the requester's signing key, kept only until we answer.
   * Accepting means sealing our address back to them, and the key arrives with
   * the request rather than being looked up, so a service that lied about who
   * asked cannot redirect the reply.
   */
  private requesterKeys = new Map<string, string>()

  constructor(private readonly options: RendezvousClientOptions) {
    this.key = deriveSigningKey(options.identity.seedHex)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => Date.now())
    this.base = options.baseUrl.replace(/\/+$/, "")
  }

  get signPub(): string {
    return this.key.signPub
  }

  state(): RendezvousState {
    const now = this.now()
    return {
      connected: this.socket !== null,
      // Connectable is about the LEASE, not the socket: a dropped control
      // channel leaves us dialable until the lease actually lapses.
      connectable: this.expiresAt !== null && this.expiresAt > now,
      handle: this.leaseId ? this.options.handle : null,
      expiresAt: this.expiresAt,
    }
  }

  // ---------- lifecycle ----------

  /** Register and attach the control channel; keeps retrying until stop(). */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.registerCycle()
  }

  /**
   * Stop participating. Best-effort unregister, then tear down.
   *
   * A failure to reach the service here is NOT an error worth surfacing: the
   * lease lapses on its own within 90 s, which is the whole point of §6. Trying
   * to guarantee a clean logout would be building the dependency we are avoiding.
   */
  async stop(): Promise<void> {
    this.running = false
    this.clearTimers()
    const leaseId = this.leaseId
    this.closeSocket()
    this.leaseId = null
    this.expiresAt = null
    if (leaseId) {
      try {
        await this.unregister(leaseId)
      } catch {
        // Expiry is sufficient. Nothing to report and nothing to retry.
      }
    }
    this.emitState()
  }

  private clearTimers(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = undefined
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = undefined
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close(1000)
      } catch {
        // already gone
      }
    }
  }

  private emitState(): void {
    const next = this.state()
    const prev = this.lastState
    if (
      prev &&
      prev.connected === next.connected &&
      prev.connectable === next.connectable &&
      prev.handle === next.handle &&
      prev.expiresAt === next.expiresAt
    ) {
      return
    }
    this.lastState = next
    this.options.events.stateChanged?.(next)
  }

  private scheduleRetry(): void {
    if (!this.running) return
    // Full jitter: without it, every node knocked offline by the same outage
    // comes back in lockstep and knocks the service over again.
    const delay = Math.floor(Math.random() * this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.refreshTimer = setTimeout(() => void this.registerCycle(), delay)
  }

  private scheduleRefresh(afterMs: number): void {
    if (!this.running) return
    const jitter = 1 + (Math.random() * 2 - 1) * REFRESH_JITTER
    this.refreshTimer = setTimeout(() => void this.refreshCycle(), Math.max(1_000, afterMs * jitter))
  }

  private async registerCycle(): Promise<void> {
    if (!this.running) return
    try {
      const res = await this.register()
      this.leaseId = res.leaseId
      this.expiresAt = res.expiresAt
      this.backoffMs = BACKOFF_MIN_MS
      this.emitState()
      this.openControl()
      this.scheduleRefresh(res.refreshAfterMs)
    } catch (err) {
      this.expiresAt = null
      this.leaseId = null
      this.emitState()
      this.options.events.error?.(err instanceof Error ? err.message : String(err))
      this.scheduleRetry()
    }
  }

  private async refreshCycle(): Promise<void> {
    if (!this.running || !this.leaseId) return
    try {
      const res = await this.refresh(this.leaseId)
      this.expiresAt = res.expiresAt
      this.backoffMs = BACKOFF_MIN_MS
      this.emitState()
      this.scheduleRefresh(res.refreshAfterMs)
    } catch (err) {
      // A lapsed lease is recoverable by registering again — that is the normal
      // path after the service restarts, which the contract treats as routine.
      const lapsed = err instanceof RendezvousError && err.code === "lease_expired"
      this.leaseId = null
      this.expiresAt = null
      this.closeSocket()
      this.emitState()
      if (!lapsed) this.options.events.error?.(err instanceof Error ? err.message : String(err))
      this.scheduleRetry()
    }
  }

  // ---------- signed request plumbing ----------

  /** Open a sealed contact descriptor addressed to us, or null. */
  private openContact(sealed: string): ContactDescriptor | null {
    const plain = openSealed(sealed, this.options.identity.seedHex, this.key.signPub)
    if (!plain) return null
    try {
      return JSON.parse(plain) as ContactDescriptor
    } catch {
      return null
    }
  }

  private envelope(): { nodeId: string; signPub: string; issuedAt: number; nonce: string } {
    const nonce = new Uint8Array(16)
    crypto.getRandomValues(nonce)
    return {
      nodeId: this.options.identity.nodeId,
      signPub: this.key.signPub,
      issuedAt: this.now(),
      nonce: bytesToHex(nonce),
    }
  }

  private envelopeInput(domain: string, env: ReturnType<RendezvousClient["envelope"]>): SigningInput {
    return new SigningInput(domain).str(env.nodeId).str(env.signPub).int(env.issuedAt).str(env.nonce)
  }

  private async call<T>(path: string, method: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      throw new RendezvousError("unreachable", `rendezvous unreachable: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      throw new RendezvousError("invalid_response", `rendezvous returned non-JSON (status ${res.status})`, res.status)
    }
    if (!res.ok) {
      const e = (parsed as { error?: { code?: string; message?: string } } | null)?.error
      throw new RendezvousError(e?.code ?? "internal", e?.message ?? `rendezvous error ${res.status}`, res.status)
    }
    return parsed as T
  }

  // ---------- descriptors ----------

  private buildDescriptors(now: number): { pub: PublicDescriptor; contact: ContactDescriptor } {
    const common = {
      v: 1 as const,
      handle: this.options.handle,
      nodeId: this.options.identity.nodeId,
      signPub: this.key.signPub,
      capabilities: this.options.capabilities,
      issuedAt: now,
      expiresAt: now + DESCRIPTOR_TTL_MS,
    }
    return {
      pub: signPublicDescriptor(
        // Honest, not optimistic: with no candidate to publish there is no path
        // for anyone to dial, so we say so rather than advertising availability.
        { ...common, connectable: this.options.candidates.length > 0 },
        this.key,
      ),
      contact: signContactDescriptor(
        { ...common, noisePub: this.options.identity.noisePub, candidates: this.options.candidates },
        this.key,
      ),
    }
  }

  // ---------- operations ----------

  private async register(): Promise<{ leaseId: string; expiresAt: number; refreshAfterMs: number }> {
    const env = this.envelope()
    const { pub, contact } = this.buildDescriptors(env.issuedAt)
    const input = this.envelopeInput(DOMAIN.register, env)
      .str(this.options.handle)
      .str(pub.sig)
      .str(contact.sig)
    return this.call("/v1/presence/register", "POST", {
      ...env,
      handle: this.options.handle,
      publicDescriptor: pub,
      contactDescriptor: contact,
      sig: sign(input, this.key),
    })
  }

  private async refresh(leaseId: string): Promise<{ expiresAt: number; refreshAfterMs: number }> {
    const env = this.envelope()
    const { pub, contact } = this.buildDescriptors(env.issuedAt)
    // Descriptors ride every refresh so a roaming node's address stays current,
    // mirroring how the LAN layer refreshes an address when a peer changes
    // interface. Their signatures append to the signed order (contract §5.2).
    const input = this.envelopeInput(DOMAIN.refresh, env).str(leaseId).str(pub.sig).str(contact.sig)
    return this.call("/v1/presence/refresh", "POST", {
      ...env,
      leaseId,
      publicDescriptor: pub,
      contactDescriptor: contact,
      sig: sign(input, this.key),
    })
  }

  private async unregister(leaseId: string): Promise<void> {
    const env = this.envelope()
    const input = this.envelopeInput(DOMAIN.unregister, env).str(leaseId)
    await this.call("/v1/presence", "DELETE", { ...env, leaseId, sig: sign(input, this.key) })
  }

  /**
   * Exact-handle lookup. Returns null for "nobody by that handle is connectable"
   * — the service reports a miss as a 200 with a null result so status codes
   * cannot be used to enumerate the namespace.
   */
  async search(handle: string): Promise<PublicDescriptor | null> {
    const env = this.envelope()
    const input = this.envelopeInput(DOMAIN.search, env).str(handle)
    const res = await this.call<{ result: PublicDescriptor | null }>(
      `/v1/discovery/search?handle=${encodeURIComponent(handle)}`,
      "GET",
      undefined,
      {
        "X-Nex-Node": env.nodeId,
        "X-Nex-Key": env.signPub,
        "X-Nex-Issued": String(env.issuedAt),
        "X-Nex-Nonce": env.nonce,
        "X-Nex-Sig": sign(input, this.key),
      },
    )
    const descriptor = res?.result ?? null
    if (!descriptor) return null
    if (!verifyPublicDescriptor(descriptor, this.now())) {
      // The service is untrusted; a descriptor it could not have produced
      // honestly is discarded rather than shown to the user as a person.
      throw new RendezvousError("invalid_signature", `search result for "${handle}" failed signature validation`)
    }
    if (descriptor.handle !== handle) {
      throw new RendezvousError("invalid_response", `asked for "${handle}" but got "${descriptor.handle}"`)
    }
    return descriptor
  }

  /** "I'm looking for <handle>." Ships our own contact descriptor as consent. */
  async requestIntroduction(targetHandle: string): Promise<{ requestId: string; expiresAt: number }> {
    // The address is sealed to the target, so we need their key first. Search
    // returns it and the client re-verifies the signature, so this costs one
    // request and trusts nothing the service says about it.
    const target = await this.search(targetHandle)
    if (!target) throw new RendezvousError("not_found", `no node is registered as ${targetHandle}`)

    const env = this.envelope()
    const requestId = crypto.randomUUID()
    const { contact } = this.buildDescriptors(env.issuedAt)
    const expiresAt = env.issuedAt + INTRODUCTION_TTL_MS
    const sealedContact = seal(JSON.stringify(contact), target.signPub)
    // The sealed blob is signed, not a field inside it: the service cannot open
    // the blob, so signing the ciphertext is what binds the address to us.
    const input = this.envelopeInput(DOMAIN.introductionRequest, env)
      .str(requestId)
      .str(targetHandle)
      .str(this.options.handle)
      .str(this.key.signPub)
      .str(sealedContact)
      .int(expiresAt)
    return this.call("/v1/introduction/request", "POST", {
      ...env,
      requestId,
      targetHandle,
      fromHandle: this.options.handle,
      // Our signing key travels in the clear: it is already public, search
      // returns it, and the recipient needs it to seal their reply back to us.
      fromSignPub: this.key.signPub,
      // Our address does not. The service relays this and cannot open it.
      sealedContact,
      expiresAt,
      sig: sign(input, this.key),
    })
  }

  /**
   * Accept or ignore. Accepting releases our address to that one requester and
   * means only "willing to attempt communication" — never "verified" (V3 §13).
   */
  async respondIntroduction(requestId: string, accept: boolean): Promise<void> {
    const env = this.envelope()
    const contact = accept ? this.buildDescriptors(env.issuedAt).contact : null
    // Recorded when the request arrived. Without it there is nobody to seal to,
    // and sending the address in the clear instead would defeat the point.
    const toSignPub = this.requesterKeys.get(requestId)
    if (accept && !toSignPub) {
      throw new RendezvousError("not_found", "cannot accept an introduction that was never received")
    }
    const sealedContact = contact && toSignPub ? seal(JSON.stringify(contact), toSignPub) : ""
    const input = this.envelopeInput(DOMAIN.introductionRespond, env)
      .str(requestId)
      .bool(accept)
      .str(sealedContact)
    await this.call("/v1/introduction/respond", "POST", {
      ...env,
      requestId,
      accept,
      ...(sealedContact ? { sealedContact } : {}),
      sig: sign(input, this.key),
    })
    this.requesterKeys.delete(requestId)
  }

  // ---------- control channel ----------

  private openControl(): void {
    if (!this.options.openSocket || !this.leaseId || this.socket) return
    const env = this.envelope()
    const input = this.envelopeInput(DOMAIN.control, env).str(this.leaseId)
    const url = `${this.base.replace(/^http/, "ws")}/v1/control`
    let socket: ControlSocket
    try {
      socket = this.options.openSocket(url, {
        "X-Nex-Node": env.nodeId,
        "X-Nex-Key": env.signPub,
        "X-Nex-Issued": String(env.issuedAt),
        "X-Nex-Nonce": env.nonce,
        "X-Nex-Sig": sign(input, this.key),
        "X-Nex-Lease": this.leaseId,
      })
    } catch (err) {
      this.options.events.error?.(`control channel failed to open: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    socket.onOpen(() => {
      this.socket = socket
      this.reattachMs = BACKOFF_MIN_MS
      this.emitState()
      this.pingTimer = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "ping", t: this.now() }))
        } catch {
          // The close handler will deal with a dead socket.
        }
      }, CONTROL_PING_MS)
    })
    socket.onMessage((data) => this.onControlFrame(data))
    socket.onError(() => {
      // Surfaced through onClose; a socket error alone is not user-actionable.
    })
    socket.onClose(() => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = undefined
      if (this.socket === socket) {
        this.socket = null
        this.emitState()
        // The lease outlives the socket: we stay CONNECTABLE and simply
        // reattach. Losing the channel must not make us undiscoverable.
        // Reattachment backs off exponentially with full jitter, exactly like
        // register/refresh retries (§10: "never a tight retry loop") — a flat
        // 2 s hammer here would keep knocking a struggling service that is
        // already refusing our upgrades at 6/min.
        if (this.running && this.leaseId) {
          const delay = Math.floor(Math.random() * this.reattachMs)
          this.reattachMs = Math.min(this.reattachMs * 2, BACKOFF_MAX_MS)
          setTimeout(() => this.openControl(), delay)
        }
      }
    })
  }

  private onControlFrame(raw: string): void {
    let frame: { type?: string } | null = null
    try {
      frame = JSON.parse(raw) as { type?: string }
    } catch {
      return // unparseable frames are dropped, never surfaced
    }
    if (!frame || typeof frame.type !== "string") return

    switch (frame.type) {
      case "introduction.request": {
        const f = frame as unknown as {
          requestId: string
          fromHandle: string
          fromSignPub: string
          sealedContact: string
          expiresAt: number
        }
        if (!f.requestId || !f.fromSignPub || !f.sealedContact) return

        const opened = this.openContact(f.sealedContact)
        if (!opened) {
          this.options.events.error?.("ignored an introduction request that could not be opened")
          return
        }
        // Validate before showing a human a name. This is the same lesson the
        // invite path learned: naming first meant an impostor got stored wearing
        // someone else's label.
        if (!verifyContactDescriptor(opened, this.now())) {
          this.options.events.error?.("ignored an introduction request with an invalid descriptor")
          return
        }
        // The sealed descriptor must belong to the key that sent it, or anyone
        // could relay somebody else's address under their own name.
        if (opened.signPub !== f.fromSignPub) {
          this.options.events.error?.("ignored an introduction request whose descriptor did not match its sender")
          return
        }
        if (opened.handle !== f.fromHandle) {
          this.options.events.error?.("ignored an introduction request whose handle did not match its descriptor")
          return
        }
        this.requesterKeys.set(f.requestId, f.fromSignPub)
        this.options.events.introductionRequest?.({
          requestId: f.requestId,
          fromHandle: f.fromHandle,
          fromContactDescriptor: opened,
          expiresAt: f.expiresAt,
        })
        return
      }
      case "introduction.response": {
        const f = frame as unknown as {
          requestId: string
          accept: boolean
          sealedContact?: string
        }
        if (!f.requestId) return
        let contact: ContactDescriptor | undefined
        if (f.accept) {
          const opened = f.sealedContact ? this.openContact(f.sealedContact) : null
          if (!opened || !verifyContactDescriptor(opened, this.now())) {
            this.options.events.error?.("ignored an acceptance carrying an invalid descriptor")
            return
          }
          contact = opened
        }
        this.options.events.introductionResponse?.({
          requestId: f.requestId,
          accept: Boolean(f.accept),
          contactDescriptor: contact,
        })
        return
      }
      case "lease.expiring": {
        // Refresh early rather than waiting for the timer to catch up.
        if (this.running && this.leaseId) void this.refreshCycle()
        return
      }
      default:
        return // pong and unknown types need no action
    }
  }
}

/** Real WebSocket factory. Kept out of the class so tests never touch a socket. */
export function browserSocketFactory(url: string, headers: Record<string, string>): ControlSocket {
  // Header auth on the upgrade needs a client that can set them; Bun's WebSocket
  // accepts them, which is why the contract authenticates the control channel
  // with headers rather than a query string that would land in access logs.
  const ws = new WebSocket(url, { headers } as unknown as string[])
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onOpen: (cb) => ws.addEventListener("open", () => cb()),
    onMessage: (cb) => ws.addEventListener("message", (e) => cb(String((e as MessageEvent).data))),
    onClose: (cb) => ws.addEventListener("close", () => cb()),
    onError: (cb) => ws.addEventListener("error", (e) => cb(e)),
  }

}
