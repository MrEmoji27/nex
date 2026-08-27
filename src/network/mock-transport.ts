// Worker B owns this file: mock P2PTransport + in-memory NexApp for UI development.
import type {
  AppEvent,
  AppListener,
  ChatMessage,
  DiscoveredPeer,
  ErrorScope,
  MessageDirection,
  MessageState,
  NodeIdentity,
  NodeStatus,
  P2PTransport,
  PeerInfo,
  PeerRetentionState,
  RetentionPolicy,
  RoomInvitation,
  RoomView,
  Settings,
  NexApp,
  Unsubscribe,
} from "../core/contract.ts"
import { DEFAULT_SETTINGS, retentionCutoff, retentionLooseness } from "../core/contract"
import { encodeInvite } from "../core/discovery"

const DEMO_ADDRESS = "127.0.0.1:41999"

function randomHex(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let out = ""
  for (const byte of raw) out += byte.toString(16).padStart(2, "0")
  return out.toUpperCase()
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Scripted demo persona: echoes, answers greetings and questions.
function demoReply(input: string): string {
  const text = input.trim()
  const low = text.toLowerCase()
  if (!text) return "…that was empty."
  if (low === "ping") return "pong"
  if (/^(hi|hello|yo|hey|sup)\b/.test(low)) {
    return pick(["hey.", "yo — link is solid.", "hello from the other node."])
  }
  if (low.endsWith("?")) {
    return pick(["yes.", "no.", "maybe. resync and ask again.", "short answer: probably."])
  }
  if (low.includes("latency") || low.includes("ms")) return "round-trip looks healthy from here."
  return `echo ▸ ${text}`
}

class MockTransport implements P2PTransport {
  private identity: NodeIdentity | null = null
  private readonly peers = new Map<string, PeerInfo>()
  private readonly statusListeners = new Set<(peer: PeerInfo) => void>()
  private readonly messageListeners = new Set<
    (peerId: string, content: string, receivedAt: number) => void
  >()
  private readonly errorListeners = new Set<(scope: ErrorScope, message: string) => void>()
  private readonly replyTimers = new Set<ReturnType<typeof setTimeout>>()

  async start(options: { port?: number; identity: NodeIdentity }): Promise<number> {
    this.identity = options.identity
    return options.port ?? 42000
  }

  async stop(): Promise<void> {
    for (const timer of this.replyTimers) clearTimeout(timer)
    this.replyTimers.clear()
  }

  onPeerStatus(callback: (peer: PeerInfo) => void): Unsubscribe {
    this.statusListeners.add(callback)
    return () => this.statusListeners.delete(callback)
  }

  onMessage(callback: (peerId: string, content: string, receivedAt: number) => void): Unsubscribe {
    this.messageListeners.add(callback)
    return () => this.messageListeners.delete(callback)
  }

  onError(callback: (scope: ErrorScope, message: string) => void): Unsubscribe {
    this.errorListeners.add(callback)
    return () => this.errorListeners.delete(callback)
  }

  async dial(address: string): Promise<PeerInfo> {
    const existing = [...this.peers.values()].find((peer) => peer.address === address)
    const peer: PeerInfo = existing
      ? { ...existing, status: "connecting", lastSeenAt: Date.now() }
      : {
          peerId: `p-${randomHex(4).toLowerCase()}`,
          name: `peer-${address.split(":").pop() ?? "??"}`,
          status: "connecting",
          address,
          lastSeenAt: Date.now(),
        }
    this.peers.set(peer.peerId, peer)
    this.emitStatus(peer)

    await sleep(220 + Math.floor(Math.random() * 280))

    peer.status = "connected"
    peer.latencyMs = 8 + Math.floor(Math.random() * 40)
    peer.identityState = "identified" // scripted peers always prove (mock only)
    peer.lastSeenAt = Date.now()
    this.emitStatus(peer)
    return { ...peer }
  }

  async drop(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.status = "offline"
    peer.latencyMs = undefined
    peer.lastSeenAt = Date.now()
    this.emitStatus(peer)
  }

  /** Simulated round-trip latency for a connected mock peer; null if unknown/offline. */
  latencyOf(peerId: string): number | null {
    return this.peers.get(peerId)?.latencyMs ?? null
  }

  async send(peerId: string, content: string): Promise<void> {
    const peer = this.peers.get(peerId)
    if (!peer || peer.status !== "connected") {
      throw new Error(`peer not connected: ${peerId}`)
    }
    peer.lastSeenAt = Date.now()
    const delay = 180 + Math.floor(Math.random() * 420)
    const timer = setTimeout(() => {
      this.replyTimers.delete(timer)
      this.deliver(peerId, demoReply(content))
    }, delay)
    this.replyTimers.add(timer)
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop()
  }

  private emitStatus(peer: PeerInfo): void {
    const snapshot = { ...peer }
    for (const callback of [...this.statusListeners]) callback(snapshot)
  }

  private deliver(peerId: string, content: string): void {
    const peer = this.peers.get(peerId)
    if (!peer || peer.status !== "connected") return
    peer.lastSeenAt = Date.now()
    const receivedAt = Date.now()
    for (const callback of [...this.messageListeners]) callback(peerId, content, receivedAt)
  }
}

export interface MockAppOptions {
  port?: number
  name?: string
}

export async function createMockApp(options: MockAppOptions = {}): Promise<NexApp> {
  const fingerprint = randomHex(8)
  const identity: NodeIdentity = {
    nodeId: fingerprint,
    name: options.name ?? `node-${fingerprint.slice(0, 4).toLowerCase()}`,
    createdAt: Date.now(),
  }

  let status: NodeStatus = "starting"
  let seq = 0
  const listeners = new Set<AppListener>()
  const peers = new Map<string, PeerInfo>()
  const conversations = new Map<string, ChatMessage[]>()
  const settings: Settings = { ...DEFAULT_SETTINGS, lastReadAt: {} }

  const emit = (event: AppEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  const setStatus = (next: NodeStatus): void => {
    status = next
    emit({ type: "nodeStatus", status: next })
  }

  const record = (
    direction: MessageDirection,
    peerId: string,
    content: string,
    at: number,
    initialState: MessageState,
  ): ChatMessage => {
    seq += 1
    const message: ChatMessage = {
      id: `m-${seq}-${randomHex(2).toLowerCase()}`,
      direction,
      content,
      sentAt: at,
      state: initialState,
    }
    const list = conversations.get(peerId) ?? []
    list.push(message)
    conversations.set(peerId, list)
    emit({ type: "message", message: { ...message } })
    return message
  }

  const transport = new MockTransport()

  const agreements: Record<string, PeerRetentionState> = {}
  const emitRetention = (peerId: string): void => {
    const state = agreements[peerId]
    if (state) emit({ type: "retentionChanged", peerId, state: { ...state }, mine: settings.retention ?? "forever" })
  }

  transport.onPeerStatus((peer) => {
    peers.set(peer.peerId, peer)
    emit({ type: "peerChanged", peer })
  })
  transport.onMessage((peerId, content, receivedAt) => {
    record("in", peerId, content, receivedAt, "sent")
  })
  transport.onError((scope, message) => {
    emit({ type: "error", scope, message })
  })

  const sortPeers = (list: PeerInfo[]): PeerInfo[] => {
    const rank = (peer: PeerInfo) =>
      peer.status === "connected" ? 0 : peer.status === "connecting" ? 1 : 2
    return [...list]
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
      .map((peer) => ({ ...peer }))
  }

  await transport.start({ port: options.port, identity })
  setStatus("online")

  // Dev-harness seeds: a scripted echo peer plus one dormant peer. Mock app only.
  const bot = await transport.dial(DEMO_ADDRESS)
  bot.name = "echo"
  peers.set(bot.peerId, bot)
  emit({ type: "peerChanged", peer: { ...bot } })

  const ghost: PeerInfo = {
    peerId: "p-roshan",
    name: "roshan",
    status: "discovered",
    address: "192.168.1.47:42001",
    lastSeenAt: Date.now() - 86_400_000,
  }
  peers.set(ghost.peerId, ghost)
  emit({ type: "peerChanged", peer: { ...ghost } })

  const t0 = Date.now()
  record("in", bot.peerId, "echo node online. say something.", t0 - 60_000, "sent")
  record("out", bot.peerId, "wiring the interface.", t0 - 45_000, "sent")
  record("in", bot.peerId, "looks good from here.", t0 - 30_000, "sent")

  const app: NexApp = {
    identity,
    get status() {
      return status
    },

    emit(listener: AppListener): Unsubscribe {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async listPeers() {
      return sortPeers([...peers.values()])
    },

    async connectTo(address) {
      const addr = address.trim()
      if (!/^[^\s:]+:\d+$/.test(addr)) {
        throw new Error(`bad address "${address}" — expected host:port`)
      }
      const peer = await transport.dial(addr)
      peers.set(peer.peerId, peer)
      return { ...peer }
    },

    async disconnect(peerId) {
      await transport.drop(peerId)
    },

    async sendMessage(peerId, content) {
      const text = content.trim()
      if (!text) throw new Error("cannot send an empty message")
      const message = record("out", peerId, text, Date.now(), "queued")
      try {
        await transport.send(peerId, text)
        message.state = "sent"
      } catch (err) {
        message.state = "failed"
        emit({
          type: "error",
          scope: "messaging",
          message: err instanceof Error ? err.message : String(err),
        })
      }
      emit({ type: "message", message: { ...message } })
      return { ...message }
    },

    async conversation(peerId) {
      const cutoff = retentionCutoff(settings.retention ?? "forever")
      return [...(conversations.get(peerId) ?? [])]
        .filter((message) => cutoff == null || message.sentAt >= cutoff)
        .map((message) => ({ ...message }))
    },

    async pingPeer(peerId) {
      return transport.latencyOf(peerId)
    },

    async setTrust(peerId, trusted) {
      const peer = peers.get(peerId)
      if (!peer) throw new Error(`unknown peer ${peerId}`)
      peer.trusted = trusted
      peer.verified = trusted
      peers.set(peerId, peer)
      emit({ type: "peerChanged", peer: { ...peer } })
    },

    async setVerified(peerId, verified) {
      const peer = peers.get(peerId)
      if (!peer) throw new Error(`unknown peer ${peerId}`)
      peer.verified = verified
      peer.trusted = verified
      peers.set(peerId, peer)
      emit({ type: "peerChanged", peer: { ...peer } })
    },

    async setDisplayName(name: string) {
      // Demo mode has no identity store, so this lives only as long as the
      // session does — enough to show the command working, and it says so by
      // simply not persisting rather than by pretending to.
      const trimmed = name.trim()
      if (!trimmed) throw new Error("a name cannot be empty")
      identity.name = trimmed
      emit({ type: "identityLoaded", identity: { ...identity } })
    },

    async renameContact(peerId, displayName) {
      const peer = peers.get(peerId)
      if (!peer) throw new Error(`unknown peer ${peerId}`)
      const trimmed = displayName.trim()
      if (trimmed) {
        peer.displayName = trimmed
      } else {
        delete peer.displayName
      }
      peers.set(peerId, peer)
      emit({ type: "peerChanged", peer: { ...peer } })
    },

    getLinkSecurity() {
      return "none" as const
    },

    getStorageSecurity() {
      return "none" as const
    },

    getSettings(): Settings {
      return { ...settings, lastReadAt: { ...settings.lastReadAt } }
    },

    async setTheme(themeId: string) {
      settings.theme = themeId
      emit({ type: "settingsChanged", settings: app.getSettings() })
    },

    async setRetention(policy: RetentionPolicy) {
      const previous = settings.retention ?? "forever"
      settings.retention = policy
      const cutoff = retentionCutoff(policy)
      if (cutoff != null) {
        for (const [peerId, messages] of conversations) {
          conversations.set(peerId, messages.filter((message) => message.sentAt > cutoff))
        }
      }
      emit({ type: "settingsChanged", settings: app.getSettings() })
      // Scripted peers: announce always; a raise is instantly accepted (bot).
      for (const peerId of peers.keys()) {
        const state: PeerRetentionState = { ...(agreements[peerId] ?? {}) }
        if (retentionLooseness(policy) > retentionLooseness(previous)) {
          state.theirs = undefined
          state.pendingOut = policy
          agreements[peerId] = state
          emitRetention(peerId)
          await Bun.sleep(150)
          delete state.pendingOut
          state.theirs = "forever"
          state.agreedAt = Date.now()
          state.lastAction = "ack"
        } else {
          state.theirs = "forever"
        }
        agreements[peerId] = state
        emitRetention(peerId)
      }
    },

    async markConversationRead(peerId: string) {
      settings.lastReadAt = { ...settings.lastReadAt, [peerId]: Date.now() }
      emit({ type: "settingsChanged", settings: app.getSettings() })
    },

    async markVersionSeen(version: string) {
      settings.lastSeenVersion = version
      emit({ type: "settingsChanged", settings: app.getSettings() })
    },

    // Mock retention agreements: the scripted bot always agrees, so the UI can
    // exercise both auto-ack and explicit flows without a second real node.
    getRetentionAgreement(peerId: string): PeerRetentionState | null {
      return agreements[peerId] ? { ...agreements[peerId]! } : null
    },

    async respondRetentionProposal(peerId: string, accept: boolean) {
      const state = agreements[peerId]
      if (!state?.pendingIn) throw new Error(`no pending retention proposal from ${peerId}`)
      const policy = state.pendingIn
      if (accept) {
        delete state.pendingIn
        state.theirs = policy
        state.agreedAt = Date.now()
        state.lastAction = "ack"
      } else {
        delete state.pendingIn
        state.lastAction = "reject"
      }
      emitRetention(peerId)
    },

    // ---------- mock rooms & voice ----------
    // A scripted room with the echo bot so the UI can exercise surfaces
    // without a second real node. Honest: it exists only in mock mode.
    ...mockRooms(identity, emit as (e: AppEvent) => void),

    // ---------- mock discovery ----------
    ...mockDiscovery(identity),

    async shutdown() {
      await transport.stop()
      setStatus("offline")
      listeners.clear()
    },

    async [Symbol.asyncDispose]() {
      await app.shutdown()
    },
  }

  return app
}

// ---------- mock rooms & voice ----------
// Scripted room behaviors so UI surfaces are exercisable without a second
// real node. The echo bot joins, replies in-room, and toggles speaking.
function mockRooms(
  identity: NodeIdentity,
  emit: (event: AppEvent) => void,
): Pick<
  NexApp,
  | "createRoom"
  | "joinRoom"
  | "sendRoomMessage"
  | "leaveRoom"
  | "closeRoom"
  | "listRooms"
  | "listInvitations"
  | "setVoiceActive"
  | "setVoiceMuted"
  | "setVoiceSpeaking"
> {
  type MockRoom = RoomView & { seq: number }
  const rooms = new Map<string, MockRoom>()
  const invitations: RoomInvitation[] = []
  const botId = "p-echo"

  const snapshot = (room: MockRoom): RoomView => ({
    ...room,
    members: room.members.map((m) => ({ ...m })),
    messages: [...room.messages],
    voice: { ...room.voice, participants: room.voice.participants.map((p) => ({ ...p })) },
  })

  const emitRoom = (room: MockRoom): void => {
    emit({ type: "roomChanged", room: snapshot(room) })
  }

  return {
    async createRoom(name, invitePeerIds) {
      const roomId = crypto.randomUUID().slice(0, 8)
      const room: MockRoom = {
        roomId,
        name: name.trim() || "room",
        hostPeerId: identity.nodeId,
        createdAt: Date.now(),
        seq: 0,
        members: [{ peerId: identity.nodeId, name: identity.name, role: "host", joinedAt: Date.now() }],
        messages: [],
        voice: { roomId, state: "idle", participants: [], selfMuted: false },
      }
      rooms.set(roomId, room)
      if (invitePeerIds.includes(botId)) {
        room.members.push({ peerId: botId, name: "echo", role: "member", joinedAt: Date.now() + 1 })
        emit({ type: "notice", scope: "rooms", message: "echo joined the room" })
      }
      emitRoom(room)
      return snapshot(room)
    },

    async joinRoom(roomId) {
      throw new Error(`mock mode: no real host to join for ${roomId}`)
    },

    async sendRoomMessage(roomId, content) {
      const room = rooms.get(roomId)
      if (!room) throw new Error(`unknown room: ${roomId}`)
      const text = content.trim()
      if (!text) return
      room.seq += 1
      room.messages.push({
        roomId,
        seq: room.seq,
        fromPeerId: identity.nodeId,
        fromName: identity.name,
        content: text,
        sentAt: Date.now(),
      })
      emitRoom(room)
      // Scripted echo reply from the bot, in-room.
      await sleep(300)
      room.seq += 1
      room.messages.push({
        roomId,
        seq: room.seq,
        fromPeerId: botId,
        fromName: "echo",
        content: `echo > ${text}`,
        sentAt: Date.now(),
      })
      emitRoom(room)
    },

    async leaveRoom(roomId) {
      rooms.delete(roomId)
      emit({ type: "roomClosed", roomId, reason: "left" })
    },

    async closeRoom(roomId) {
      rooms.delete(roomId)
      emit({ type: "roomClosed", roomId, reason: "closed by host" })
    },

    listRooms() {
      return [...rooms.values()].map(snapshot)
    },

    listInvitations() {
      return invitations.map((i) => ({ ...i }))
    },

    async setVoiceActive(roomId, active) {
      const room = rooms.get(roomId)
      if (!room) throw new Error(`unknown room: ${roomId}`)
      if (active) {
        if (!room.voice.participants.some((p) => p.peerId === identity.nodeId)) {
          room.voice.participants.push({ peerId: identity.nodeId, name: identity.name, muted: false, speaking: false })
        }
        if (!room.voice.participants.some((p) => p.peerId === botId)) {
          room.voice.participants.push({ peerId: botId, name: "echo", muted: false, speaking: false })
        }
        room.voice.state = "connected"
      } else {
        room.voice.state = "idle"
        room.voice.selfMuted = false
        room.voice.participants = []
      }
      emitRoom(room)
    },

    async setVoiceMuted(roomId, muted) {
      const room = rooms.get(roomId)
      if (!room) throw new Error(`unknown room: ${roomId}`)
      room.voice.selfMuted = muted
      room.voice.participants = room.voice.participants.map((p) =>
        p.peerId === identity.nodeId ? { ...p, muted } : p,
      )
      emitRoom(room)
    },

    async setVoiceSpeaking(roomId, speaking) {
      const room = rooms.get(roomId)
      if (!room) return
      room.voice.participants = room.voice.participants.map((p) =>
        p.peerId === botId ? { ...p, speaking } : p,
      )
      emitRoom(room)
    },
  }
}

// ---------- mock discovery ----------
// A fake nearby peer so the UI's discovered rows have something to show.
function mockDiscovery(identity: NodeIdentity): Pick<
  NexApp,
  | "listDiscovered"
  | "connectDiscovered"
  | "createInvite"
  | "redeemInvite"
  | "introduceTo"
  | "setDiscovery"
  | "setRendezvous"
  | "getRendezvousState"
  | "searchHandle"
  | "requestIntroduction"
  | "listIntroductionRequests"
  | "respondIntroduction"
> {
  let enabled = true
  const ghost: DiscoveredPeer = {
    peerId: "p-nearby-ghost",
    name: "someone.nearby",
    address: "192.168.1.77:42001",
    source: "lan",
    fp: "GHOST0000FAKEFINGERPRINTFORUIWORK",
    seenAt: Date.now(),
  }
  void identity
  return {
    listDiscovered() {
      return enabled ? [{ ...ghost, seenAt: Date.now() }] : []
    },
    async connectDiscovered(peerId) {
      if (peerId !== ghost.peerId) throw new Error(`no discovered peer ${peerId}`)
      throw new Error("mock mode: cannot dial the scripted neighbor")
    },
    async createInvite(address) {
      return encodeInvite({
        name: identity.name,
        host: address ?? "192.168.1.42",
        port: 42001,
        fp: identity.nodeId,
      })
    },
    async redeemInvite(code) {
      throw new Error(`mock mode: cannot redeem ${code.slice(0, 24)}…`)
    },
    async introduceTo(_to, _other) {
      throw new Error("mock mode: introductions need real links")
    },
    async setDiscovery(on) {
      enabled = on
    },

    // ---------- rendezvous ----------
    // Mock mode has no service to talk to, and inventing presence is exactly
    // what V3 §7 forbids. So the scripted node reports itself honestly as
    // switched off rather than faking a connected network.
    async setRendezvous() {
      throw new Error("mock mode: rendezvous needs a real service")
    },
    getRendezvousState() {
      return { enabled: false, connected: false, connectable: false, handle: null, expiresAt: null }
    },
    async searchHandle(handle) {
      throw new Error(`mock mode: cannot search for "${handle}"`)
    },
    async requestIntroduction(handle) {
      throw new Error(`mock mode: cannot request an introduction to "${handle}"`)
    },
    listIntroductionRequests() {
      return []
    },
    async respondIntroduction() {
      throw new Error("mock mode: no introductions to answer")
    },
  }
}
