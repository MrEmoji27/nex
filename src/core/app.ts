// NexApp facade: implements the contract over stores + transport.
import { networkInterfaces } from "node:os"
import type {
  AppEvent,
  AppListener,
  ChatMessage,
  ConversationStore,
  ControlWire,
  ErrorScope,
  IdentityStore,
  NatTraversal,
  NodeIdentity,
  PeerInfo,
  PeerRegistryStore,
  PeerRetentionState,
  P2PTransport,
  RetentionControl,
  RetentionPolicy,
  RetentionStore,
  RoomControl,
  RoomInvitation,
  RoomView,
  Settings,
  StorageSecurity,
  NexApp as NexAppContract,
  SettingsStore,
  Unsubscribe,
  VoiceChannelStateView,
  VoiceControl,
} from "./contract.ts"
import { DEFAULT_SETTINGS, retentionCutoff } from "./contract"
import {
  acceptRemoteProposal,
  onLocalPolicyChange,
  onRemoteAnswer,
  onRemotePropose,
  onRemoteState,
  rejectRemoteProposal,
} from "./retention-agreement"
import {
  activePeers,
  appendOwnMessage,
  localVoiceJoin,
  localVoiceLeave,
  localVoiceMute,
  localVoiceSpeaking,
  newHostedRoom,
  newJoinedRoom,
  onPeerLost,
  onRoomControl,
  onVoiceControl,
} from "./room-service"
import {
  BEACON_INTERVAL_MS,
  DISCOVERY_PORT,
  DISCOVERY_TTL_MS,
  SeenRegistry,
  decodeInvite,
  encodeInvite,
  makeBeacon,
  parseBeacon,
} from "./discovery"
import type {
  DiscoveryBeacon,
  DiscoveredPeer,
  HandleSearchResult,
  IntroductionRequestView,
  RendezvousStatusView,
} from "./contract"
import { MockAudioSink, MockAudioSource, MockVoiceCodec, VoiceSession } from "./voice"
import { generateIdentity, noisePublicKeyFromPrivate } from "./identity"
import { RendezvousClient, browserSocketFactory, type ControlSocket } from "./rendezvous/client"
import { dialAddresses, normalizeHandle, udpCandidates, type ContactDescriptor } from "./rendezvous/descriptor"
import { formatUdpAddress } from "./session/udp-address"

/** Local alias for the pure machine's context shape. */
interface RoomContextShape {
  selfId: string
  selfName: string
  isHost: boolean
  hostPeerId: string
}

/** Member peerIds other than self. */
function othersOf(ctx: RoomContextShape, room: RoomView): string[] {
  return room.members.filter((m) => m.peerId !== ctx.selfId).map((m) => m.peerId)
}

// ---------- discovery platform helpers ----------
// Typed loosely here: Bun's UDP types vary across versions and the failure
// mode we care about (port blocked) is handled at the call site.

interface UdpSocketLike {
  send(data: Uint8Array | string, port: number, address: string): boolean | Promise<boolean> | void
  close(): Promise<void> | void
}

/** All private-range IPv4 interface addresses (RFC1918), loopback excluded. */
function privateV4Addresses(): string[] {
  const table = networkInterfaces() as Record<string, Array<{ family?: string; address?: string; internal?: boolean }>>
  const out: string[] = []
  for (const list of Object.values(table)) {
    for (const net of list ?? []) {
      if (net.internal || !net.address) continue
      // node:os reports family as "IPv4"/"IPv6" strings; some stacks as 4/6.
      const fam = String(net.family).toLowerCase()
      if (!fam.startsWith("ipv4") && fam !== "4") continue
      const [a, b] = net.address.split(".").map(Number)
      if ((a === 192 && b === 168) || a === 10 || (a === 172 && b! >= 16 && b! <= 31)) {
        out.push(net.address)
      }
    }
  }
  return out
}

/** Broadcast targets: global + each private subnet's .255 (used by tests). */
function broadcastTargets(): Array<{ address: string; port: number }> {
  const out: Array<{ address: string; port: number }> = [{ address: "255.255.255.255", port: DISCOVERY_PORT }]
  for (const addr of privateV4Addresses()) {
    const parts = addr.split(".")
    if (parts.length === 4) out.push({ address: `${parts[0]}.${parts[1]}.${parts[2]}.255`, port: DISCOVERY_PORT })
  }
  return out
}
void broadcastTargets

export interface NexAppOptions {
  identityStore: IdentityStore
  conversations: ConversationStore
  registry: PeerRegistryStore
  transport: P2PTransport
  /**
   * NAT traversal, when the wired transport has it.
   *
   * Kept separate from `transport` because it is not part of moving bytes: it
   * is what makes an address publishable and what lets the answering side of an
   * introduction start punching without dialling. Omitted, everything still
   * works between peers who can already reach each other.
   */
  nat?: NatTraversal
  /** Local preferences; omit for an in-memory default store. */
  settings?: SettingsStore
  /** Per-peer retention-agreement protocol state; omit for memory-only. */
  retentionStore?: RetentionStore
  /** Data-at-rest state of the wired stores; defaults to "none" (honest). */
  storageSecurity?: StorageSecurity
  /** Listen port override; transport applies its own default/fallback. */
  port?: number
  /**
   * Rendezvous control-channel factory. Omit for a real WebSocket; tests inject
   * a fake so no suite ever needs a live service.
   */
  openControlSocket?: (url: string, headers: Record<string, string>) => ControlSocket
}

/**
 * Split an invite address into host + port.
 *
 * Accepts a bare host ("nex.example", "100.64.0.2"), a bracketed IPv6 literal
 * with or without a port, and "host:port". A BARE IPv6 literal is left alone:
 * "fe80::1" ends in a numeric run after a colon and would otherwise be read as
 * host "fe80:" on port 1.
 */
export function splitHostPort(raw: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = raw.trim()

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]")
    if (end !== -1) {
      const host = trimmed.slice(1, end)
      const tail = trimmed.slice(end + 1)
      const port = tail.startsWith(":") ? Number(tail.slice(1)) : NaN
      return { host, port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallbackPort }
    }
  }

  // More than one colon and no brackets means a bare IPv6 literal, not host:port.
  const first = trimmed.indexOf(":")
  const last = trimmed.lastIndexOf(":")
  if (first !== -1 && first === last) {
    const port = Number(trimmed.slice(last + 1))
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return { host: trimmed.slice(0, last), port }
    }
  }
  return { host: trimmed, port: fallbackPort }
}

export class NexAppImpl implements NexAppContract {
  private readonly listeners = new Set<AppListener>()
  private readonly peers = new Map<string, PeerInfo>()
  private identityValue: NodeIdentity | null = null
  private statusValue: NexAppContract["status"] = "offline"
  private started = false
  private settingsValue: Settings = { ...DEFAULT_SETTINGS }
  private retentionValue: Record<string, PeerRetentionState> = {}
  // ---------- rooms & voice ----------
  private roomsValue = new Map<string, RoomView>()
  private invitationsValue: RoomInvitation[] = []
  /** Per-room outbound chat counters (own lines). */
  private roomSeq = new Map<string, number>()
  /** Per-room, per-sender highest applied inbound chat seq (dedupe). */
  private seenRoomSeq = new Map<string, Map<string, number>>()
  /** Live voice pipelines keyed by roomId. */
  private voiceSessions = new Map<string, VoiceSession>()
  // ---------- discovery ----------
  private discovered = new SeenRegistry()
  private discoveryTimer: Timer | undefined
  private sweepTimer: Timer | undefined
  private beaconSocket: { close(): Promise<void> | void } | null = null
  /** Per-interface sender sockets (subnet-directed broadcast). */
  private extraSockets: Array<{ close(): Promise<void> | void }> = []
  /** Our LAN listen port, captured after transport.start(). */
  private lanPort = 0
  // ---------- v3 rendezvous ----------
  private rendezvous: RendezvousClient | null = null
  private rendezvousState: RendezvousStatusView = {
    enabled: false,
    connected: false,
    connectable: false,
    handle: null,
    expiresAt: null,
  }
  /** Requests awaiting this user's Accept/Ignore, by requestId. */
  private introductions = new Map<string, { view: IntroductionRequestView; descriptor: ContactDescriptor }>()
  /** Requests WE sent, so an acceptance can be matched back to a dial. */
  private outboundIntroductions = new Set<string>()

  constructor(private readonly options: NexAppOptions) {}

  get identity(): NodeIdentity {
    if (!this.identityValue) throw new Error("app not started")
    return this.identityValue
  }

  get status(): NexAppContract["status"] {
    return this.statusValue
  }

  emit(listener: AppListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.statusValue = "starting"

    // 1. Identity: load or create, persist on first run (spec §5).
    let identity = await this.options.identityStore.load()
    if (!identity) {
      const generated = generateIdentity()
      await this.options.identityStore.save(generated.identity, generated.secret)
      identity = generated.identity
    }
    this.identityValue = identity
    this.emitEvent({ type: "identityLoaded", identity })

    // 2. Restore settings, registry, agreements + conversations from disk.
    try {
      this.settingsValue = { ...DEFAULT_SETTINGS, ...(await this.options.settings?.load()) }
    } catch {
      this.settingsValue = { ...DEFAULT_SETTINGS }
    }
    try {
      this.retentionValue = (await this.options.retentionStore?.load()) ?? {}
    } catch {
      this.retentionValue = {}
    }

    for (const peer of await this.options.registry.list()) {
      this.peers.set(peer.peerId, peer)
    }

    // 3. Transport wiring + start listening.
    const transport = this.options.transport
    transport.onPeerStatus((peer) => this.onTransportPeerStatus(peer))
    transport.onMessage((peerId, content, receivedAt) => this.onTransportMessage(peerId, content, receivedAt))
    transport.onControl?.((peerId, control) => this.onTransportControl(peerId, control))
    transport.onError((scope, message) => this.emitError(scope, message))
    transport.onVoiceFrame?.((fromPeerId, meta, payload) => {
      const session = this.voiceSessions.get(meta.roomId)
      session?.acceptWireFrame(meta, payload)
    })
    await transport.start({ port: this.options.port, identity })
    this.lanPort = (transport as { port?: number }).port ?? 0
    this.startDiscovery().catch(() => {
      // Discovery is opportunistic; a closed/blocked UDP socket must never
      // block boot. The rest of Nex works fine without it.
    })
    this.startRendezvous().catch(() => {
      // Same rule, and V3 §5 makes it explicit: Nex must run with rendezvous
      // off, so an unreachable service can never be a boot failure.
    })
    this.statusValue = "online"
    this.emitEvent({ type: "nodeStatus", status: "online" })
  }

  async listPeers(): Promise<PeerInfo[]> {
    return [...this.peers.values()].map((peer) => ({ ...peer }))
  }

  async connectTo(address: string): Promise<PeerInfo> {
    const peer = await this.options.transport.dial(address)
    const existing = this.peers.get(peer.peerId)
    // Preserve local-only state (trust/verification/rename) the transport cannot know.
    // identityState: keep the previously known value when this report carries none.
    const merged: PeerInfo = existing
      ? {
          ...existing,
          ...peer,
          trusted: existing.trusted,
          verified: existing.verified,
          displayName: existing.displayName,
          identityState: peer.identityState ?? existing.identityState,
        }
      : { ...peer }
    this.peers.set(peer.peerId, merged)
    await this.options.registry.upsert(merged)
    return { ...merged }
  }

  async disconnect(peerId: string): Promise<void> {
    await this.options.transport.drop(peerId)
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.status = "offline"
      await this.options.registry.upsert({ ...peer })
    }
  }

  async sendMessage(peerId: string, content: string): Promise<ChatMessage> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      direction: "out",
      content,
      sentAt: Date.now(),
      state: "queued",
    }
    this.emitEvent({ type: "message", message: { ...message } })

    try {
      await this.options.transport.send(peerId, content)
      message.state = "sent"
    } catch (err) {
      message.state = "failed"
      this.emitError("messaging", err instanceof Error ? err.message : String(err))
    }
    await this.options.conversations.append(peerId, message)
    void this.pruneExpired(peerId)
    this.emitEvent({ type: "message", message: { ...message } })
    return { ...message }
  }

  async conversation(peerId: string): Promise<ChatMessage[]> {
    const messages = await this.options.conversations.loadAll(peerId)
    return this.applyRetention(peerId, messages)
  }

  /**
   * Retention is LOCAL (vision §12): expired messages disappear from this node's
   * view and are pruned from disk when the store supports it. The peer keeps its
   * own copy; nothing here claims otherwise.
   */
  private applyRetention(peerId: string, messages: ChatMessage[]): ChatMessage[] {
    const cutoff = retentionCutoff(this.settingsValue.retention ?? "forever")
    if (cutoff == null) return messages
    // Strictly-older-than-cutoff expiry: a message at exactly cutoff survives
    // until the next evaluation (documented semantics, vision §12).
    return messages.filter((message) => message.sentAt >= cutoff)
  }

  /** Best-effort disk prune of already-expired history for one peer. */
  private async pruneExpired(peerId: string): Promise<void> {
    const cutoff = retentionCutoff(this.settingsValue.retention ?? "forever")
    if (cutoff == null) return
    try {
      await this.options.conversations.deleteBefore?.(peerId, cutoff)
    } catch {
      // Pruning is opportunistic; load-time filtering still enforces the policy.
    }
  }

  // ---------- v2 settings ----------

  getSettings(): Settings {
    return { ...this.settingsValue }
  }

  async setTheme(themeId: string): Promise<void> {
    this.settingsValue = { ...this.settingsValue, theme: themeId }
    await this.saveSettings()
    this.emitEvent({ type: "settingsChanged", settings: { ...this.settingsValue } })
  }

  async setRetention(policy: RetentionPolicy): Promise<void> {
    const previous = this.settingsValue.retention ?? "forever"
    this.settingsValue = { ...this.settingsValue, retention: policy }
    // Enforce immediately across known conversations BEFORE announcing the
    // change, so the disk state matches the new policy when the UI repaints.
    const cutoff = retentionCutoff(policy)
    if (cutoff != null) {
      await Promise.allSettled(
        [...this.peers.keys()].map((peerId) => this.options.conversations.deleteBefore?.(peerId, cutoff)),
      )
    }
    await this.saveSettings()
    this.emitEvent({ type: "settingsChanged", settings: { ...this.settingsValue } })

    // Relationship layer: announce to every connected peer; a raise also
    // proposes the wider shared window (peer must ack before it counts).
    for (const [peerId, peer] of this.peers) {
      if (peer.status !== "connected") continue
      const outcome = onLocalPolicyChange(this.retentionValue[peerId], previous, policy)
      await this.applyRetentionOutcome(peerId, outcome)
    }
  }

  async markConversationRead(peerId: string): Promise<void> {
    const lastReadAt = { ...this.settingsValue.lastReadAt, [peerId]: Date.now() }
    this.settingsValue = { ...this.settingsValue, lastReadAt }
    await this.saveSettings()
    this.emitEvent({ type: "settingsChanged", settings: { ...this.settingsValue } })
  }

  async markVersionSeen(version: string): Promise<void> {
    if (this.settingsValue.lastSeenVersion === version) return
    this.settingsValue = { ...this.settingsValue, lastSeenVersion: version }
    await this.saveSettings()
  }

  getRetentionAgreement(peerId: string): PeerRetentionState | null {
    const state = this.retentionValue[peerId]
    return state ? { ...state } : null
  }

  async respondRetentionProposal(peerId: string, accept: boolean): Promise<void> {
    const state = this.retentionValue[peerId]
    if (!state?.pendingIn) throw new Error(`no pending retention proposal from ${peerId}`)
    const outcome = accept ? acceptRemoteProposal(state) : rejectRemoteProposal(state)
    await this.applyRetentionOutcome(peerId, outcome)
  }

  private async saveSettings(): Promise<void> {
    try {
      await this.options.settings?.save({ ...this.settingsValue })
    } catch {
      this.emitError("persistence", "failed to persist settings")
    }
  }

  async pingPeer(peerId: string): Promise<number | null> {
    const measure = this.options.transport.measureLatency?.bind(this.options.transport)
    if (!measure) return null
    let rttMs: number | null = null
    try {
      rttMs = await measure(peerId)
    } catch (err) {
      this.emitError("transport", err instanceof Error ? err.message : String(err))
      return null
    }
    if (rttMs != null) {
      const peer = this.peers.get(peerId)
      if (peer) {
        peer.latencyMs = rttMs
        peer.lastSeenAt = Date.now()
        // Volatile measurement: surfaced to the UI, not written to the registry.
        this.emitEvent({ type: "peerChanged", peer: { ...peer } })
      }
      this.emitEvent({ type: "latency", peerId, latencyMs: rttMs })
    }
    return rttMs
  }

  async setTrust(peerId: string, trusted: boolean): Promise<void> {
    await this.setVerified(peerId, trusted)
  }

  async setVerified(peerId: string, verified: boolean): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`unknown peer: ${peerId}`)
    peer.verified = verified
    // Mirror into the deprecated field so v0.x readers see a coherent value.
    peer.trusted = verified
    await this.options.registry.upsert({ ...peer })
    this.emitEvent({ type: "peerChanged", peer: { ...peer } })
  }

  async renameContact(peerId: string, displayName: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) throw new Error(`unknown peer: ${peerId}`)
    const trimmed = displayName.trim()
    if (trimmed) {
      peer.displayName = trimmed
    } else {
      delete peer.displayName
    }
    await this.options.registry.upsert({ ...peer })
    this.emitEvent({ type: "peerChanged", peer: { ...peer } })
  }

  getLinkSecurity(): "none" | "transport" {
    return this.options.transport.security?.encrypted === true ? "transport" : "none"
  }

  getStorageSecurity(): StorageSecurity {
    return this.options.storageSecurity ?? "none"
  }

  // ---------- v2 discovery ----------

  listDiscovered(): DiscoveredPeer[] {
    // Hide anyone we already know as a real peer (connected or registered).
    return this.discovered.list().filter((d) => !this.peers.has(d.peerId))
  }

  async connectDiscovered(peerId: string): Promise<PeerInfo> {
    const entry = this.discovered.get(peerId)
    if (!entry) throw new Error(`no discovered peer ${peerId.slice(0, 8)}`)
    const peer = await this.connectTo(entry.address)
    // Beacons are unauthenticated UDP, and an intro is only as good as the
    // friend relaying it: anyone can announce any name and nodeId. The entry
    // told us WHICH identity lives at that address, so if someone else
    // answers, that is the substitution this check exists to catch. Same hard
    // stop as an invite mismatch.
    if (peer.peerId !== entry.peerId) {
      await this.disconnect(peer.peerId).catch(() => {})
      const via = entry.source === "intro" ? ` (introduced by ${entry.viaName ?? "a contact"})` : ""
      throw new Error(
        `DISCOVERY MISMATCH: ${entry.name}${via} announced ${entry.peerId.slice(0, 8)}… but ` +
          `${peer.peerId.slice(0, 8)}… answered at ${entry.address} — do not trust this link`,
      )
    }
    this.discovered.observe(
      { ...entry },
      // keep the entry until the registry copy supersedes it in the UI
      Date.now(),
    )
    return peer
  }

  async createInvite(address?: string): Promise<string> {
    // Callers pass either a bare host ("100.64.0.2") or a full "host:port".
    // Appending our own port to the latter produced "host:port:port", which
    // no longer parses as an invite at all.
    const raw = address ?? this.lanAddressHint()
    const { host, port } = splitHostPort(raw, this.lanPort || 42001)
    return encodeInvite({ name: this.identity.name, host, port, fp: this.identity.nodeId })
  }

  async redeemInvite(code: string): Promise<PeerInfo> {
    const parts = decodeInvite(code)
    if (!parts) throw new Error("invalid nex:// invite code")
    const peer = await this.connectTo(`${parts.host}:${parts.port}`)
    // Fingerprint pin check, BEFORE we write the inviter's name onto anyone.
    // The invite carries the expected nodeId; the transport enforces TOFU
    // continuity on top. A mismatch is a hard stop, surfaced loudly.
    //
    // Ordering matters: naming first meant an impostor sitting at the invited
    // address was stored in the registry wearing the inviter's name, and
    // disconnect() only marks a peer offline — so the mislabelled contact
    // outlived the rejection.
    // No fingerprint = no pin. Every code createInvite() emits carries one, so
    // a code without it was either hand-made or stripped in transit — and
    // stripping is the cheapest possible attack on a pinned invite. Refuse
    // rather than quietly downgrade to an unchecked connect.
    if (!parts.fp) {
      throw new Error(
        "UNPINNED INVITE: this nex:// code carries no fingerprint, so the identity " +
          "behind it cannot be checked — ask for a fresh code",
      )
    }

    {
      const expected = parts.fp.toUpperCase()
      if (peer.peerId !== expected) {
        await this.disconnect(peer.peerId).catch(() => {})
        throw new Error(
          `INVITE MISMATCH: expected ${expected.slice(0, 8)}… but ${peer.peerId.slice(0, 8)}… answered ` +
            `at ${parts.host}:${parts.port} — do not trust this link`,
        )
      }
    }

    if (parts.name && !peer.displayName && peer.name === parts.host) {
      // Cosmetic: show the inviter's self-claimed name if we have nothing
      // better. Only reachable once the pin above confirmed WHO answered.
      await this.renameContact(peer.peerId, parts.name).catch(() => {})
    }
    return peer
  }

  async introduceTo(toPeerId: string, otherPeerId: string): Promise<void> {
    const to = (await this.listPeers()).find((p) => p.peerId === toPeerId)
    const other = (await this.listPeers()).find((p) => p.peerId === otherPeerId)
    if (!to || to.status !== "connected") throw new Error(`not connected to ${toPeerId.slice(0, 8)}`)
    if (!other?.address) throw new Error(`no known address for ${otherPeerId.slice(0, 8)}`)
    await this.sendControlTo(toPeerId, {
      kind: "intro",
      introducedNodeId: other.peerId,
      introducedName: other.displayName ?? other.name,
      address: other.address,
      fp: other.peerId,
    })
  }

  async setDiscovery(enabled: boolean): Promise<void> {
    this.settingsValue = { ...this.settingsValue, discovery: enabled }
    await this.saveSettings()
    this.emitEvent({ type: "settingsChanged", settings: { ...this.settingsValue } })
    if (enabled) await this.startDiscovery()
    else await this.stopDiscovery()
  }

  /**
   * Best-effort LAN address hint for invites: a private-range interface
   * address. Over the internet, pass an explicit address/routable IP instead.
   */
  private lanAddressHint(): string {
    for (const net of privateV4Addresses()) {
      return net
    }
    return "127.0.0.1"
  }

  /** Bring up UDP beaconing (announce + listen + sweep) unless disabled. */
  private async startDiscovery(): Promise<void> {
    if (this.discoveryTimer || this.settingsValue.discovery === false || !this.identityValue) return
    let listener: UdpSocketLike | null = null
    try {
      listener = await Bun.udpSocket({
        port: DISCOVERY_PORT,
        hostname: "0.0.0.0",
        socket: {
          data: (_sock, data, port, host) => {
            this.onBeaconDatagram(data, host, port)
          },
        },
      })
      this.beaconSocket = listener
    } catch {
      // Port busy or blocked: stay silent, keep working.
      listener = null
    }
    // One sender socket PER private interface, bound to it: Windows refuses
    // global 255.255.255.255 without SO_BROADCAST, but subnet-directed
    // broadcast from the interface's own address goes through.
    const senders: Array<{ sock: UdpSocketLike; target: string }> = []
    for (const addr of privateV4Addresses()) {
      try {
        const s = await Bun.udpSocket({ hostname: addr, port: 0, socket: { data() {} } })
        const parts = addr.split(".")
        const subnetBc =
          parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.255` : null
        if (subnetBc) senders.push({ sock: s as unknown as UdpSocketLike, target: subnetBc })
        this.extraSockets.push(s as unknown as UdpSocketLike)
      } catch {
        // interface unavailable; skip
      }
    }

    const sendBeacon = (): void => {
      if (this.settingsValue.discovery === false) return
      const payload = makeBeacon(
        { nodeId: this.identity.nodeId, name: this.identity.name, port: this.lanPort || 42001 },
        this.identity.nodeId,
      )
      for (const s of senders) {
        try {
          s.sock.send(payload, DISCOVERY_PORT, s.target)
        } catch {
          // single failed send is fine; the next beat retries
        }
      }
    }
    this.discoveryTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS)
    // Fire one immediately so neighbors see us without waiting a beat.
    sendBeacon()
    if (process.env.NEX_DEBUG_DISCOVERY === "1") {
      console.error(`[discovery] listener=${listener ? "up" : "DOWN"} senders=${senders.length} targets=${senders.map((s) => s.target).join(",") || "none"}`)
    }
    this.sweepTimer = setInterval(() => {
      for (const gone of this.discovered.sweepExpired()) {
        this.emitEvent({ type: "discoveredLost", peerId: gone.peerId })
      }
    }, Math.floor(DISCOVERY_TTL_MS / 3))
  }

  private async stopDiscovery(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = undefined
    for (const extra of this.extraSockets.splice(0)) {
      try {
        await extra.close()
      } catch {
        // already gone
      }
    }
    const socket = this.beaconSocket
    this.beaconSocket = null
    if (socket) {
      try {
        await socket.close()
      } catch {
        // already gone
      }
    }
  }

  /** One inbound UDP datagram: parse, ignore self, record + emit. */
  private onBeaconDatagram(data: Uint8Array, _host: string, _port: number): void {
    const beacon = parseBeacon(data)
    if (!beacon) return
    if (beacon.nodeId === this.identity.nodeId) return // our own echo
    const { added, peer } = this.discovered.observe({
      peerId: beacon.nodeId,
      name: beacon.name,
      address: `${_host}:${beacon.port}`,
      source: "lan",
      fp: beacon.fp,
    })
    this.emitEvent({ type: "discoveredSeen", peer })
    if (added) this.emitEvent({ type: "notice", scope: "rooms" as const, message: `${beacon.name} appeared nearby` })
  }

  // ---------- v3 rendezvous ----------
  //
  // One more discovery SOURCE, feeding the same DiscoveredPeer pipeline as LAN
  // and intros (V3 §3, §18). It is never in the message path, and everything it
  // reports is a candidate until the Noise handshake proves otherwise.

  getRendezvousState(): RendezvousStatusView {
    return { ...this.rendezvousState }
  }

  async setRendezvous(enabled: boolean, config?: { baseUrl?: string; handle?: string }): Promise<void> {
    const current = this.settingsValue.rendezvous ?? { enabled: false }
    const baseUrl = config?.baseUrl ?? current.baseUrl
    const handleRaw = config?.handle ?? current.handle

    if (enabled) {
      if (!baseUrl) throw new Error("rendezvous needs a service URL: /rendezvous on <url> <handle>")
      if (!handleRaw) throw new Error("rendezvous needs a handle: /rendezvous on <url> <handle>")
      // Normalize BEFORE persisting, so what we store is what we publish and
      // what the user sees. A handle silently rewritten later is a handle the
      // user did not choose.
      const handle = normalizeHandle(handleRaw)
      if (!handle) {
        throw new Error(
          `invalid handle "${handleRaw}": 3-32 chars, a-z 0-9 _ - only, starting with a letter or digit`,
        )
      }
      this.settingsValue = { ...this.settingsValue, rendezvous: { enabled: true, baseUrl, handle } }
    } else {
      this.settingsValue = { ...this.settingsValue, rendezvous: { ...current, enabled: false } }
    }

    await this.saveSettings()
    this.emitEvent({ type: "settingsChanged", settings: { ...this.settingsValue } })
    if (enabled) await this.startRendezvous()
    else await this.stopRendezvous()
  }

  /**
   * Bring up rendezvous participation. Never throws into boot: the service is
   * optional by definition, so an unreachable one degrades to "not connectable"
   * rather than taking Nex down with it.
   */
  private async startRendezvous(): Promise<void> {
    const settings = this.settingsValue.rendezvous
    if (this.rendezvous || !settings?.enabled || !settings.baseUrl || !settings.handle) return
    if (!this.identityValue) return

    const secret = (await this.options.identityStore.loadSecret?.()) ?? null
    if (!secret?.identityPrivHex) {
      this.emitError("rendezvous", "no transport identity key yet; rendezvous stays off this boot")
      return
    }

    // Measure our public UDP address BEFORE the descriptor is built. Candidates
    // are signed into it, so one published without a punchable address is one
    // no peer behind a router can use, and the fix would be re-signing a
    // descriptor the service has already handed out.
    if (this.options.nat) {
      const report = await this.options.nat.discoverPublicCandidate()
      if (!report.address) {
        this.emitError(
          "rendezvous",
          `could not learn this machine's public address: ${report.detail} — peers behind a router may not be able to reach you`,
        )
      }
    }

    const client = new RendezvousClient({
      baseUrl: settings.baseUrl,
      identity: {
        nodeId: this.identity.nodeId,
        seedHex: secret.seedHex,
        noisePub: noisePublicKeyFromPrivate(secret.identityPrivHex),
      },
      handle: settings.handle,
      capabilities: ["chat", "rooms", "voice"],
      candidates: this.rendezvousCandidates(),
      openSocket: this.options.openControlSocket ?? browserSocketFactory,
      events: {
        stateChanged: (state) => {
          this.rendezvousState = { enabled: true, ...state }
          this.emitEvent({ type: "rendezvousChanged", state: { ...this.rendezvousState } })
        },
        error: (message) => this.emitError("rendezvous", message),
        introductionRequest: (req) => this.onIntroductionRequest(req),
        introductionResponse: (res) => void this.onIntroductionResponse(res),
      },
    })
    this.rendezvous = client
    this.rendezvousState = { ...this.rendezvousState, enabled: true }
    await client.start()
  }

  private async stopRendezvous(): Promise<void> {
    const client = this.rendezvous
    this.rendezvous = null
    this.introductions.clear()
    this.outboundIntroductions.clear()
    if (client) await client.stop().catch(() => {})
    this.rendezvousState = {
      enabled: false,
      connected: false,
      connectable: false,
      handle: null,
      expiresAt: null,
    }
    this.emitEvent({ type: "rendezvousChanged", state: { ...this.rendezvousState } })
  }

  /**
   * Where we tell the service we can be reached. NEX_PUBLIC_ADDRESS is how a
   * node behind a forwarded port advertises the address that actually works;
   * without it we publish our private-range hint, which is honest but usually
   * only reachable from the same network.
   */
  private rendezvousCandidates(): Array<{ kind: string; host: string; port: number }> {
    const port = this.lanPort || this.options.port || 42001
    const explicit = process.env.NEX_PUBLIC_ADDRESS?.trim()
    const out: Array<{ kind: string; host: string; port: number }> = []

    // UDP first. It is the one that works between two ordinary home networks,
    // and a peer tries candidates in order.
    const nat = this.options.nat
    if (nat) {
      // The public one, measured on the socket peers will actually punch. A
      // mapping belongs to one local port, so an address learned anywhere else
      // would advertise a door that leads nowhere.
      const mapped = nat.publicCandidate
      if (mapped) out.push({ kind: "udp", host: mapped.host, port: mapped.port })
      // And the private one, which is what works when "across the internet"
      // turns out to be the same building.
      if (nat.port > 0) out.push({ kind: "udp", host: this.lanAddressHint(), port: nat.port })
    }

    if (explicit) {
      const { host, port: explicitPort } = splitHostPort(explicit, port)
      out.push({ kind: "direct-tcp", host, port: explicitPort })
    } else {
      out.push({ kind: "direct-tcp", host: this.lanAddressHint(), port })
    }
    return out
  }

  /**
   * Start punching toward a peer we just accepted.
   *
   * Failure here is not an error the user needs to see: it means no UDP path
   * opened, and the peer will fall back to whatever else they were told. It is
   * logged as a transport notice and nothing else.
   */
  private beginPunch(descriptor: ContactDescriptor): void {
    const nat = this.options.nat
    const candidates = udpCandidates(descriptor)
    if (!nat || candidates.length === 0) return
    void nat.expect(descriptor.nodeId, candidates).catch(() => {})
  }

  private requireRendezvous(): RendezvousClient {
    if (!this.rendezvous) throw new Error("rendezvous is off; enable it with /rendezvous on <url> <handle>")
    return this.rendezvous
  }

  async searchHandle(handle: string): Promise<HandleSearchResult | null> {
    const normalized = normalizeHandle(handle)
    if (!normalized) throw new Error(`invalid handle "${handle}"`)
    const found = await this.requireRendezvous().search(normalized)
    if (!found) return null
    return {
      handle: found.handle,
      nodeId: found.nodeId,
      capabilities: found.capabilities,
      connectable: found.connectable,
      expiresAt: found.expiresAt,
    }
  }

  async requestIntroduction(handle: string): Promise<{ requestId: string; expiresAt: number }> {
    const normalized = normalizeHandle(handle)
    if (!normalized) throw new Error(`invalid handle "${handle}"`)
    const res = await this.requireRendezvous().requestIntroduction(normalized)
    this.outboundIntroductions.add(res.requestId)
    return res
  }

  listIntroductionRequests(): IntroductionRequestView[] {
    const now = Date.now()
    return [...this.introductions.values()]
      .filter((entry) => entry.view.expiresAt > now)
      .map((entry) => ({ ...entry.view }))
  }

  async respondIntroduction(requestId: string, accept: boolean): Promise<void> {
    const entry = this.introductions.get(requestId)
    if (!entry) throw new Error(`no pending introduction ${requestId.slice(0, 8)}`)
    await this.requireRendezvous().respondIntroduction(requestId, accept)
    this.introductions.delete(requestId)
    this.emitEvent({ type: "introductionAnswered", requestId, accept })
    if (!accept) return
    // Accepting released our address to them. Record theirs as a discovered
    // candidate so the user can dial back, but do NOT dial: they asked to reach
    // us, so the inbound connection is theirs to open.
    this.observeRendezvousPeer(entry.descriptor)
    // Punching is the exception, and it is not a dial. Neither router will
    // open unless both sides are sending at the same moment, and the accept we
    // just sent is the only moment both sides agree on. So we start pushing at
    // their address now and let them speak first.
    this.beginPunch(entry.descriptor)
  }

  /** Inbound "someone is looking for you". Surfaced for a human to answer. */
  private onIntroductionRequest(req: {
    requestId: string
    fromHandle: string
    fromContactDescriptor: ContactDescriptor
    expiresAt: number
  }): void {
    const view: IntroductionRequestView = {
      requestId: req.requestId,
      fromHandle: req.fromHandle,
      fromNodeId: req.fromContactDescriptor.nodeId,
      receivedAt: Date.now(),
      expiresAt: req.expiresAt,
    }
    this.introductions.set(req.requestId, { view, descriptor: req.fromContactDescriptor })
    this.emitEvent({ type: "introductionRequested", request: { ...view } })
  }

  /** They answered us. On accept, this is where the direct relationship begins. */
  private async onIntroductionResponse(res: {
    requestId: string
    accept: boolean
    contactDescriptor?: ContactDescriptor
  }): Promise<void> {
    if (!this.outboundIntroductions.delete(res.requestId)) {
      // A response to a request we never sent. Nothing good can come of acting
      // on it, and the service is not trusted enough to be given the benefit of
      // the doubt.
      this.emitError("rendezvous", "ignored an introduction response we did not ask for")
      return
    }
    this.emitEvent({ type: "introductionAnswered", requestId: res.requestId, accept: res.accept })
    if (!res.accept || !res.contactDescriptor) return

    const peer = this.observeRendezvousPeer(res.contactDescriptor)
    try {
      await this.connectDiscovered(peer.peerId)
    } catch (err) {
      // connectDiscovered enforces the identity pin; a mismatch surfaces here
      // with the same loud wording as an invite mismatch.
      this.emitError("rendezvous", err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Fold a verified contact descriptor into the ordinary discovered-peer list.
   *
   * The descriptor's signature proves the service did not forge or mutate it. It
   * does NOT prove the signing key belongs to this nodeId — nothing in the
   * rendezvous protocol does. That binding is made by connectDiscovered(), which
   * hard-stops when a different identity answers at the address, exactly as it
   * does for an unauthenticated LAN beacon.
   */
  private observeRendezvousPeer(descriptor: ContactDescriptor): DiscoveredPeer {
    // Prefer the punchable address when they published one: across the internet
    // it is usually the only one that can work, and it carries the nodeId so
    // the Noise claim has something to be checked against.
    const udp = udpCandidates(descriptor)
    const [tcp] = dialAddresses(descriptor)
    const address = this.options.nat && udp.length > 0 ? formatUdpAddress(descriptor.nodeId, udp) : tcp
    const { peer } = this.discovered.observe({
      peerId: descriptor.nodeId,
      name: descriptor.handle,
      address: address ?? "",
      source: "rendezvous",
      fp: descriptor.nodeId,
    })
    this.emitEvent({ type: "discoveredSeen", peer })
    return peer
  }

  // ---------- v2 rooms & voice ----------

  async createRoom(name: string, invitePeerIds: string[]): Promise<RoomView> {
    const trimmed = name.trim()
    if (!trimmed) throw new Error("room name required")
    const roomId = crypto.randomUUID().slice(0, 8)
    const ctx: RoomContextShape = {
      selfId: this.identity.nodeId,
      selfName: this.identity.name,
      isHost: true,
      hostPeerId: this.identity.nodeId,
    }
    const room = newHostedRoom(roomId, trimmed, ctx, Date.now())
    this.roomsValue.set(roomId, room)
    this.roomSeq.set(roomId, 0)
    this.seenRoomSeq.set(roomId, new Map())
    this.emitEvent({ type: "roomChanged", room: this.snapshotRoom(room) })

    for (const peerId of invitePeerIds) {
      const peer = (await this.listPeers()).find((p) => p.peerId === peerId)
      await this.sendControlTo(peerId, {
        kind: "room",
        action: "invite",
        roomId,
        roomName: trimmed,
        hostPeerId: this.identity.nodeId,
        ts: Date.now(),
      })
      if (!peer) this.emitEvent({ type: "notice", scope: "rooms", message: `invite queued for unknown peer ${peerId.slice(0, 8)}` })
    }
    return this.snapshotRoom(room)
  }

  async joinRoom(roomId: string, hostPeerId?: string): Promise<RoomView> {
    const invitation = this.invitationsValue.find((i) => i.roomId === roomId)
    const host = hostPeerId ?? invitation?.hostPeerId
    if (!host) throw new Error(`no known host for room ${roomId}`)
    const existing = this.roomsValue.get(roomId)
    const ctx: RoomContextShape = {
      selfId: this.identity.nodeId,
      selfName: this.identity.name,
      isHost: false,
      hostPeerId: host,
    }
    // Idempotent rejoin keeps accumulated history.
    const base =
      existing ??
      newJoinedRoom(roomId, invitation?.roomName ?? roomId, ctx, [], Date.now())
    if (existing) base.voice.state = "connected"
    this.roomsValue.set(roomId, base)
    this.roomSeq.set(roomId, this.roomSeq.get(roomId) ?? 0)
    this.seenRoomSeq.set(roomId, this.seenRoomSeq.get(roomId) ?? new Map())

    const peers = await this.listPeers()
    if (!peers.some((p) => p.peerId === host && p.status === "connected")) {
      throw new Error(`host not connected: ${host.slice(0, 8)} (connect first, then rejoin)`)
    }
    await this.sendControlTo(host, {
      kind: "room",
      action: "join",
      roomId,
      fromPeerId: this.identity.nodeId,
      fromName: this.identity.name,
    })
    this.emitEvent({ type: "roomChanged", room: this.snapshotRoom(base) })
    return this.snapshotRoom(base)
  }

  async sendRoomMessage(roomId: string, content: string): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) throw new Error(`unknown room: ${roomId}`)
    const trimmed = content.trim()
    if (!trimmed) return
    const seq = (this.roomSeq.get(roomId) ?? 0) + 1
    this.roomSeq.set(roomId, seq)
    const ctx = this.roomContext(room)

    const local = appendOwnMessage(room, trimmed, seq, ctx, Date.now())
    this.roomsValue.set(roomId, local.next!)
    this.emitEvent({ type: "roomChanged", room: this.snapshotRoom(local.next!) })

    const control: RoomControl = {
      kind: "room",
      action: "chat",
      roomId,
      seq,
      content: trimmed,
      fromPeerId: this.identity.nodeId,
      fromName: this.identity.name,
      ts: Date.now(),
    }
    // Host relays its own lines to members; members hand lines UP to the host.
    const targets = ctx.isHost
      ? othersOf(ctx, room)
      : room.members.filter((m) => m.role === "host").map((m) => m.peerId)
    for (const target of targets) await this.sendControlTo(target, control)
  }

  async leaveRoom(roomId: string): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) return
    await this.setVoiceActive(roomId, false).catch(() => {})
    const ctx = this.roomContext(room)
    if (!ctx.isHost) {
      await this.sendControlTo(ctx.hostPeerId, {
        kind: "room",
        action: "bye",
        roomId,
        fromPeerId: this.identity.nodeId,
        fromName: this.identity.name,
      }).catch(() => {})
    }
    this.roomsValue.delete(roomId)
    this.roomSeq.delete(roomId)
    this.seenRoomSeq.delete(roomId)
    this.emitEvent({ type: "roomClosed", roomId, reason: "left" })
  }

  async closeRoom(roomId: string): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) return
    const ctx = this.roomContext(room)
    if (!ctx.isHost) throw new Error("only the host can close a room")
    await this.setVoiceActive(roomId, false).catch(() => {})
    for (const peer of othersOf(ctx, room)) {
      await this.sendControlTo(peer, { kind: "room", action: "close", roomId }).catch(() => {})
    }
    this.roomsValue.delete(roomId)
    this.roomSeq.delete(roomId)
    this.seenRoomSeq.delete(roomId)
    this.emitEvent({ type: "roomClosed", roomId, reason: "closed by host" })
  }

  listRooms(): RoomView[] {
    return [...this.roomsValue.values()].map((room) => this.snapshotRoom(room))
  }

  listInvitations(): RoomInvitation[] {
    return this.invitationsValue.map((i) => ({ ...i }))
  }

  async setVoiceActive(roomId: string, active: boolean): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) throw new Error(`unknown room: ${roomId}`)
    if (active && !this.voiceSessions.has(roomId)) {
      const session = await this.startVoiceSession(room)
      this.voiceSessions.set(roomId, session)
      await session.join(() => void this.applyRoomOutcome(localVoiceJoin(room, this.roomContext(room))))
    } else if (active) {
      // Pipeline already up; just (re-)announce presence.
      await this.applyRoomOutcome(localVoiceJoin(this.roomsValue.get(roomId)!, this.roomContext(room)))
    } else {
      const session = this.voiceSessions.get(roomId)
      if (session) {
        await session.leave()
        this.voiceSessions.delete(roomId)
      }
      await this.applyRoomOutcome(localVoiceLeave(this.roomsValue.get(roomId)!, this.roomContext(room)))
    }
  }

  async setVoiceMuted(roomId: string, muted: boolean): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) throw new Error(`unknown room: ${roomId}`)
    const session = this.voiceSessions.get(roomId)
    // Mute semantics: keep capturing (pipeline stays warm), stop SENDING.
    if (session) session.setSendEnabled(!muted)
    await this.applyRoomOutcome(localVoiceMute(this.roomsValue.get(roomId)!, this.roomContext(room), muted))
  }

  async setVoiceSpeaking(roomId: string, speaking: boolean): Promise<void> {
    const room = this.roomsValue.get(roomId)
    if (!room) return
    const outcome = localVoiceSpeaking(room, this.roomContext(room), speaking)
    if (outcome) await this.applyRoomOutcome(outcome)
  }

  private async startVoiceSession(room: RoomView): Promise<VoiceSession> {
    const app = this
    const source = new MockAudioSource()
    const sink = new MockAudioSink()
    const codec = new MockVoiceCodec()
    const session = new VoiceSession({
      roomId: room.roomId,
      selfId: this.identity.nodeId,
      source,
      sink,
      codec,
      send: {
        targets(): string[] {
          // Star topology: members ship everything UP to the host;
          // hosts fan out to every other voice participant.
          const current = app.roomsValue.get(room.roomId)
          if (!current) return []
          const ctx = app.roomContext(current)
          if (ctx.isHost) return othersOf(ctx, current)
          return current.members.filter((m) => m.role === "host").map((m) => m.peerId)
        },
        sendFrame(peerId, meta, payload) {
          app.options.transport.sendVoiceFrame?.(peerId, meta, payload)
        },
      },
      onSpeakingChange: (speaking) => void app.setVoiceSpeaking(room.roomId, speaking),
    })
    return session
  }

  /** Room ops arriving over the encrypted CTL channel. */
  private async onRoomWire(fromPeerId: string, control: RoomControl): Promise<void> {
    const room = this.roomsValue.get(control.roomId)

    // INVITE: record an invitation unless we already hold the room.
    if (control.action === "invite") {
      if (room || control.hostPeerId === this.identity.nodeId) return
      const hostPeer = (await this.listPeers()).find((p) => p.peerId === control.hostPeerId)
      this.invitationsValue = [
        ...this.invitationsValue.filter((i) => i.roomId !== control.roomId),
        {
          roomId: control.roomId,
          roomName: control.roomName ?? control.roomId,
          hostPeerId: control.hostPeerId!,
          hostName: hostPeer?.displayName ?? hostPeer?.name ?? control.hostPeerId!.slice(0, 8),
          receivedAt: Date.now(),
        },
      ]
      this.emitEvent({
        type: "roomInvitation",
        invitation: this.invitationsValue[this.invitationsValue.length - 1]!,
      })
      return
    }

    // JOIN is member -> host only; we are not the host of this room.
    if (control.action === "join" && !this.roomContext(room ?? { hostPeerId: "" } as RoomView).isHost) return

    const ctx = this.roomContext(room ?? { hostPeerId: control.hostPeerId ?? "" } as RoomView)
    // A member treats every op as coming through its host; the host trusts the link.
    const seen = this.seenRoomSeq.get(control.roomId) ?? new Map<string, number>()
    const senderForSeq = control.action === "chat" ? control.fromPeerId ?? fromPeerId : fromPeerId
    const outcome = onRoomControl(
      room,
      ctx,
      { ...control, fromPeerId: control.fromPeerId ?? fromPeerId },
      seen.get(senderForSeq) ?? 0,
      Date.now(),
    )
    if (!outcome) return
    if (typeof outcome.seenSeq === "number") seen.set(senderForSeq, outcome.seenSeq)
    this.seenRoomSeq.set(control.roomId, seen)
    await this.applyRoomOutcome(outcome)
  }

  /** Voice-presence ops arriving over the encrypted CTL channel. */
  private async onVoiceWire(fromPeerId: string, control: VoiceControl): Promise<void> {
    const room = this.roomsValue.get(control.roomId)
    if (!room) return
    const outcome = onVoiceControl(room, this.roomContext(room), {
      ...control,
      aboutPeerId: control.aboutPeerId ?? fromPeerId,
    })
    if (outcome) await this.applyRoomOutcome(outcome)
  }

  /** An intro arrived: record the introduced peer as a discovered entry. */
  private async onIntroWire(viaPeerId: string, control: import("./contract").IntroControl): Promise<void> {
    if (control.introducedNodeId === this.identity.nodeId) return
    if (this.peers.has(control.introducedNodeId)) return // already known
    const via = (await this.listPeers()).find((p) => p.peerId === viaPeerId)
    const { added, peer } = this.discovered.observe({
      peerId: control.introducedNodeId,
      name: control.introducedName,
      address: control.address,
      source: "intro",
      viaPeerId,
      viaName: via?.displayName ?? via?.name,
      fp: control.fp,
    })
    this.emitEvent({ type: "discoveredSeen", peer })
    if (added) {
      this.emitEvent({
        type: "notice",
        scope: "rooms",
        message: `${via?.displayName ?? via?.name ?? "a friend"} introduced you to ${control.introducedName}`,
      })
    }
  }

  /** Apply a pure outcome: replace view, fan out replies, surface notices. */
  private async applyRoomOutcome(outcome: {
    next: RoomView | null
    replies?: Array<{ toPeerId: string; control: ControlWire }>
    notice?: string
  }): Promise<void> {
    if (outcome.next) {
      const previous = this.roomsValue.get(outcome.next.roomId)
      this.roomsValue.set(outcome.next.roomId, outcome.next)
      const snapshot = this.snapshotRoom(outcome.next)
      this.emitEvent({ type: "roomChanged", room: snapshot })
      // Focused voice event whenever the channel's participant set/state moved,
      // so voice surfaces (strip, headless) don't have to diff whole rooms.
      const voiceMoved =
        !previous ||
        JSON.stringify(previous.voice.participants) !== JSON.stringify(snapshot.voice.participants) ||
        previous.voice.state !== snapshot.voice.state
      if (voiceMoved) {
        this.emitEvent({ type: "voiceChanged", voice: snapshot.voice })
      }
    }
    await this.dispatchReplies(outcome.replies ?? [])
    if (outcome.notice) this.emitEvent({ type: "notice", scope: "rooms", message: outcome.notice })
  }

  private async dispatchReplies(replies: Array<{ toPeerId: string; control: ControlWire }>): Promise<void> {
    for (const reply of replies) await this.sendControlTo(reply.toPeerId, reply.control)
  }

  private roomContext(room: RoomView): RoomContextShape {
    const selfId = this.identity.nodeId
    return {
      selfId,
      selfName: this.identity.name,
      isHost: room.hostPeerId === selfId,
      hostPeerId: room.hostPeerId,
    }
  }

  private snapshotRoom(room: RoomView): RoomView {
    const session = this.voiceSessions.get(room.roomId)
    const voice: VoiceChannelStateView = {
      ...room.voice,
      state: session?.active ? "connected" : room.voice.state,
      participants: room.voice.participants.map((p) => ({ ...p })),
    }
    return { ...room, members: room.members.map((m) => ({ ...m })), messages: [...room.messages], voice }
  }

  private async sendControlTo(peerId: string, control: ControlWire): Promise<void> {
    try {
      await this.options.transport.sendControl?.(peerId, control)
    } catch {
      // Opportunistic: room convergence rides reconnects/reannouncements too.
    }
  }

  async shutdown(): Promise<void> {
    if (!this.started) return
    this.started = false
    this.statusValue = "offline"
    this.emitEvent({ type: "nodeStatus", status: "offline" })
    // Tear down voice pipelines BEFORE the transport goes away.
    for (const [roomId, session] of [...this.voiceSessions]) {
      try {
        await session.leave()
      } catch {
        // Shutdown is best-effort; audio timers must not block exiting.
      }
      this.voiceSessions.delete(roomId)
    }
    await this.stopDiscovery()
    await this.stopRendezvous().catch(() => {
      // Best-effort: the lease lapses on its own within 90s regardless.
    })
    await this.options.transport.stop()
    for (const listener of [...this.listeners]) this.listeners.delete(listener)
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.shutdown()
  }

  // ---------- internals ----------

  private async onTransportPeerStatus(peer: PeerInfo): Promise<void> {
    const existing = this.peers.get(peer.peerId)
    const wasConnected = existing?.status === "connected"
    // identityState: keep the previously known value when this report carries none.
    const merged: PeerInfo = existing
      ? { ...existing, ...peer, identityState: peer.identityState ?? existing.identityState }
      : { ...peer }
    this.peers.set(peer.peerId, merged)
    void this.options.registry.upsert(merged).catch(() => {
      this.emitError("persistence", `failed to persist peer ${peer.peerId}`)
    })
    this.emitEvent({ type: "peerChanged", peer: { ...merged } })

    // Freshly established link → announce our standing retention policy so the
    // relationship view converges without waiting for a change event.
    if (merged.status === "connected" && !wasConnected) {
      void this.announceRetention(merged.peerId)
      // Rooms: a re-linked host gets our join replay; a re-linked member is
      // told we're still here (host refreshes everyone).
      for (const room of this.roomsValue.values()) {
        const ctx = this.roomContext(room)
        if (room.members.some((m) => m.peerId === merged.peerId)) {
          if (ctx.isHost) {
            void this.sendControlTo(merged.peerId, {
              kind: "room",
              action: "state",
              roomId: room.roomId,
              roomName: room.name,
              hostPeerId: room.hostPeerId,
              members: room.members.map((m) => ({ ...m })),
              voiceActive: activePeers(room),
            })
          } else {
            void this.sendControlTo(merged.peerId, {
              kind: "room",
              action: "join",
              roomId: room.roomId,
              fromPeerId: this.identity.nodeId,
              fromName: this.identity.name,
            })
          }
        }
      }
    }

    // Link lost → rooms react (host prunes + fans out; member notices a lost host).
    if (wasConnected && (merged.status === "reconnecting" || merged.status === "offline")) {
      for (const room of [...this.roomsValue.values()]) {
        const outcome = onPeerLost(room, this.roomContext(room), merged.peerId)
        if (outcome) await this.applyRoomOutcome(outcome)
      }
    }
  }

  private async onTransportControl(peerId: string, control: ControlWire): Promise<void> {
    if (control.kind === "retention") {
      await this.onRetentionControl(peerId, control)
      return
    }
    if (control.kind === "room") {
      await this.onRoomWire(peerId, control)
      return
    }
    if (control.kind === "voice") {
      await this.onVoiceWire(peerId, control)
      return
    }
    if (control.kind === "intro") {
      await this.onIntroWire(peerId, control)
      return
    }
  }

  private async onRetentionControl(peerId: string, control: RetentionControl): Promise<void> {
    const mine = this.settingsValue.retention ?? "forever"
    const state = this.retentionValue[peerId]
    let outcome
    switch (control.action) {
      case "state":
        outcome = onRemoteState(state, control.policy)
        break
      case "propose":
        outcome = onRemotePropose(state, mine, control.policy)
        break
      case "ack":
      case "reject":
        outcome = onRemoteAnswer(state, control.action, control.policy)
        break
      default:
        return
    }
    await this.applyRetentionOutcome(peerId, outcome)
  }

  private async announceRetention(peerId: string): Promise<void> {
    const send = this.options.transport.sendControl?.bind(this.options.transport)
    if (!send) return
    try {
      await send(peerId, {
        kind: "retention",
        action: "state",
        policy: this.settingsValue.retention ?? "forever",
      })
    } catch {
      // Announcement is opportunistic; the next change or reconnect retries.
    }
  }

  private async applyRetentionOutcome(
    peerId: string,
    outcome: ReturnType<typeof onLocalPolicyChange>,
  ): Promise<void> {
    this.retentionValue = { ...this.retentionValue, [peerId]: outcome.next }
    try {
      await this.options.retentionStore?.save({ ...this.retentionValue })
    } catch {
      this.emitError("persistence", "failed to persist retention agreement")
    }
    if (outcome.reply) {
      try {
        await this.options.transport.sendControl?.(peerId, outcome.reply)
      } catch (err) {
        this.emitError("messaging", `retention control: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.emitEvent({
      type: "retentionChanged",
      peerId,
      state: { ...outcome.next },
      mine: this.settingsValue.retention ?? "forever",
    })
    if (outcome.notice) {
      this.emitEvent({ type: "notice", scope: "retention", message: outcome.notice })
    }
  }

  private async onTransportMessage(peerId: string, content: string, receivedAt: number): Promise<void> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      direction: "in",
      content,
      sentAt: receivedAt,
      state: "sent",
    }
    try {
      await this.options.conversations.append(peerId, message)
    } catch {
      this.emitError("persistence", `failed to persist inbound message from ${peerId}`)
    }
    this.emitEvent({ type: "message", message: { ...message } })
  }

  private emitEvent(event: AppEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private emitError(scope: ErrorScope, message: string): void {
    this.emitEvent({ type: "error", scope, message })
  }
}

/** Convenience factory mirroring how main will boot a node. */
export async function createNexApp(options: NexAppOptions): Promise<NexAppImpl> {
  const app = new NexAppImpl(options)
  await app.start()
  return app
}
