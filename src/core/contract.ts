// nex shared contract
// FROZEN INTERFACE: both workers build against this file. Do not edit during the sprint;
// propose changes via worktree comment if something is genuinely impossible to implement.
//
// v0.2 additions (spec §31 step 11 trust/identity UX, step 12 robustness):
//   - PeerStatus "reconnecting", PeerInfo.latencyMs, PeerInfo.trusted
//   - AppEvent "latency", NexApp.pingPeer / setTrust
//
// v1 additions (NEX_VISION_v1.md §36: identity-first, contacts, honest security):
//   - PeerInfo.identityState: cryptographic proof-of-possession result from handshake
//   - PeerInfo.verified replaces trusted (kept temporarily for load compatibility)
//   - PeerInfo.displayName: local-only contact rename
//   - NexApp.renameContact / setVerified / getLinkSecurity
//
// v2 additions (settings, retention, themes):
//   - Settings + FileSettingsStore-backed port (theme, retention, read state)
//   - NexApp.getSettings / setTheme / setRetention / markConversationRead
//   - ConversationStore.deleteBefore: retention prune support
//
// Layering rule (spec §23):
//   UI -> application services -> P2PTransport -> transport implementation
// Nothing above this file may import from `@opentui/*` or from a concrete transport module.

// ---------- identity ----------

export interface NodeIdentity {
  /** Stable fingerprint shown to users, e.g. "7F3A91C2..." (hex, uppercase). */
  readonly nodeId: string
  /** Human-readable display name of this node. */
  name: string
  /** Unix ms when the identity was first created. */
  readonly createdAt: number
}

// ---------- peers ----------

export type PeerStatus =
  | "discovered"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "offline"

/**
 * Result of the cryptographic proof-of-possession handshake (v1).
 * - "unknown": no proof exchanged yet (e.g. peer predates v1 handshake)
 * - "identified": peer demonstrated control of its claimed nodeId
 * - "mismatch": peer failed to prove control of its claimed nodeId
 */
export type IdentityState = "unknown" | "identified" | "mismatch"

export interface PeerInfo {
  readonly peerId: string
  name: string
  status: PeerStatus
  /** Last known address as "host:port", when discoverable. */
  address?: string
  lastSeenAt?: number
  /** Last measured round-trip latency in ms, when known. */
  latencyMs?: number
  /**
   * Explicit user trust decision. DEPRECATED in v1 — kept only so older
   * peers.json files load; new code uses `verified`.
   */
  trusted?: boolean
  /** Proof-of-possession result for this peer's claimed nodeId. */
  identityState?: IdentityState
  /** User-confirmed identity match (fingerprint comparison, spec §8). Omitted = undecided. */
  verified?: boolean
  /** Local-only contact rename; when set, UI shows this instead of `name`. */
  displayName?: string
}

// ---------- messaging ----------

export type MessageDirection = "in" | "out"
export type MessageState = "queued" | "sent" | "failed"

export interface ChatMessage {
  readonly id: string
  readonly direction: MessageDirection
  readonly content: string
  readonly sentAt: number
  state: MessageState
}

// ---------- settings ----------
// Local-only preferences (vision §15 themes, §12 retention). Never leaves data/local/.

/**
 * Message retention policy. LOCAL semantics only: expiry removes THIS node's
 * stored copy; it says nothing about the peer's copy (vision §12).
 */
export type RetentionPolicy = "24h" | "7d" | "forever"

export interface Settings {
  /** Active theme id (see src/ui/themes.ts registry); omitted = default. */
  theme?: string
  /** Message retention choice; omitted = "forever". */
  retention?: RetentionPolicy
  /** peerId -> unix ms of the last time that conversation was opened locally. */
  lastReadAt?: Record<string, number>
  /** App version whose changelog the user last saw ("What's New", vision §16). */
  lastSeenVersion?: string
  /**
   * LAN discovery beacon (alpha.7). When true (the default), this node
   * broadcasts its name + nodeId prefix on local networks and answers
   * neighbors' announcements, so nearby peers appear without typing
   * addresses. Turn OFF in hostile Wi-Fi; nothing else changes.
   */
  discovery?: boolean
  /** Optional Internet-scale rendezvous discovery (v3). Off unless chosen. */
  rendezvous?: RendezvousSettings
}

/**
 * Participation in the optional Rendezvous discovery service (v3 §5, §8).
 *
 * Absent or `enabled: false` means this node makes no network call to the
 * service at all — not for presence, not for status, not for metrics. Turning it
 * off stops publishing presence; it never touches the local Nex identity.
 */
export interface RendezvousSettings {
  enabled: boolean
  /** Service base URL, e.g. https://rendezvous.nex.example. */
  baseUrl?: string
  /** The searchable alias other people type. A lookup key, never an identity. */
  handle?: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: undefined,
  retention: "forever",
  discovery: true,
  // Opt-in, per V3 §5: Nex must be fully usable with rendezvous switched off,
  // so the default cannot be participation.
  rendezvous: { enabled: false },
}

// ---------- serverless discovery (alpha.7) ----------
// Three layers, no central anything:
//   LAN    — UDP beacons on the local network (this file's DiscoveryBeacon)
//   invite — nex:// codes exchanged over any channel; fingerprint-pinned dial
//   intro  — a connected vouches for a third by passing their beacon down a link

/** Payload of one LAN UDP beacon (sent as JSON datagram). */
export interface DiscoveryBeacon {
  v: 1
  nodeId: string
  name: string
  port: number
  /** Full fingerprint lets receivers pre-pin TOFU before dialing. */
  fp: string
  /** Unix ms, so stale announcements can age out. */
  ts: number
}

/**
 * A peer learned passively — not dialed yet. Surfaced as "discovered" rows;
 * connecting upgrades it to a normal registry entry.
 */
export interface DiscoveredPeer {
  readonly peerId: string
  name: string
  /** host:port last announced (LAN address or intro-provided address). */
  address: string
  /** How we heard about them. */
  source: "lan" | "intro" | "rendezvous"
  /** Introducing peer's nodeId when source === "intro". */
  viaPeerId?: string
  viaName?: string
  fp?: string
  seenAt: number
}

/** Wire op: "I know someone you might want to meet" (rides the CTL channel). */
export interface IntroControl {
  kind: "intro"
  roomId?: never
  introducedNodeId: string
  introducedName: string
  address: string
  fp?: string
}

/** Cutoff for a retention policy: messages strictly older than this expire. Returns null for forever. */
export function retentionCutoff(policy: RetentionPolicy, now = Date.now()): number | null {
  switch (policy) {
    case "24h":
      return now - 24 * 60 * 60 * 1000
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000
    case "forever":
      return null
  }
}

// ---------- retention agreements (dream vision §4/§5: negotiated relationship terms) ----------
// The relationship is a thing two nodes create together. Each node always enforces
// its own local policy on its own copies (vision §12 — nothing here pretends
// otherwise); the agreement layer makes the SHARED promise visible and requires
// explicit consent before the shared window may widen.

/** Total ordering: 24h is tightest, forever loosest. */
export function retentionLooseness(policy: RetentionPolicy): number {
  switch (policy) {
    case "24h":
      return 0
    case "7d":
      return 1
    case "forever":
      return 2
  }
}

/** The tighter of two policies (the one that expires sooner). */
export function tighterRetention(a: RetentionPolicy, b: RetentionPolicy): RetentionPolicy {
  return retentionLooseness(a) <= retentionLooseness(b) ? a : b
}

/**
 * Relationship-level retention view for one peer.
 * `mine` comes from settings; the rest is protocol state.
 */
export interface PeerRetentionState {
  /** Last policy announced by the peer, when known. */
  theirs?: RetentionPolicy
  /** Our proposal awaiting their answer. */
  pendingOut?: RetentionPolicy
  /** Their proposal awaiting our answer. */
  pendingIn?: RetentionPolicy
  /** Unix ms of the last accepted convergence. */
  agreedAt?: number
  /** Outcome of the most recent raise attempt ("ack" | "reject"). */
  lastAction?: "ack" | "reject"
}

/** The promise both sides can rely on: min(mine, theirs); mine alone when theirs unknown. */
export function effectiveRetention(
  mine: RetentionPolicy,
  theirs?: RetentionPolicy,
): RetentionPolicy {
  return theirs ? tighterRetention(mine, theirs) : mine
}

// ---------- control channel ----------
// Relationship-level ops carried INSIDE the encrypted transport, above frames,
// below UX. Never carries message content.

export type RetentionWireAction = "state" | "propose" | "ack" | "reject"

export interface RetentionControl {
  kind: "retention"
  action: RetentionWireAction
  policy: RetentionPolicy
}

// ---------- rooms & voice (alpha.6) ----------
// Host-based group spaces ("rooms", vision §12 extended to N peers) plus a
// voice channel per room (vision §19 groundwork). A room is anchored on its
// HOST's node — no central server exists anywhere; the room lives exactly as
// long as the host keeps it open. All room/voice traffic rides the SAME
// encrypted pairwise Noise links as everything else: members that only reach
// the host relay through it (star topology), exactly like chat fan-out.

/**
 * Role inside a hosted room. Exactly one host exists per room; the creator.
 */
export type RoomMemberRole = "host" | "member"

export interface RoomMember {
  readonly peerId: string
  name: string
  role: RoomMemberRole
  /** Unix ms the member joined (or created) the room. */
  joinedAt: number
}

/**
 * One chat line inside a room. `seq` is a PER-SENDER counter — (fromPeerId,
 * seq) is the dedupe key, because relayed delivery can reorder arrivals.
 */
export interface RoomMessage {
  readonly roomId: string
  readonly seq: number
  readonly fromPeerId: string
  readonly fromName: string
  content: string
  sentAt: number
}

export interface VoiceParticipant {
  readonly peerId: string
  name: string
  muted: boolean
  /** Set while the participant's latest voice activity stayed above threshold. */
  speaking?: boolean
  lastSpokeAt?: number
}

export type VoiceChannelState = "idle" | "joining" | "connected"

/** UI-facing snapshot of one room's voice channel. */
export interface VoiceChannelStateView {
  readonly roomId: string
  state: VoiceChannelState
  participants: VoiceParticipant[]
  selfMuted: boolean
}

/** Materialized room state as held by THIS node (each member keeps its own copy). */
export interface RoomView {
  readonly roomId: string
  name: string
  /** Host's nodeId — the anchor the room hangs from. */
  readonly hostPeerId: string
  members: RoomMember[]
  /** Newest last, capped at ROOM_MESSAGE_CAP locally. */
  messages: RoomMessage[]
  createdAt: number
  voice: VoiceChannelStateView
}

/** Cap of locally kept room chat lines (honest local history, like conversations). */
export const ROOM_MESSAGE_CAP = 500

export type RoomWireAction =
  | "invite" // host -> invited peer: come join my room (meta only; rides the existing link)
  | "join" // member -> host: admission request (host answers with state)
  | "state" // membership snapshot from the sender, merged by union on receipt
  | "chat" // member -> host: line; host relays to the rest unchanged
  | "bye" // explicit departure
  | "close" // host dissolves the room

/**
 * Wire shape for room ops. Rides the transport's CTL op (0x04) next to
 * RetentionControl — same encrypted channel, never plaintext.
 */
export interface RoomControl {
  kind: "room"
  action: RoomWireAction
  roomId: string
  roomName?: string
  hostPeerId?: string
  /** Informational reachability hint for the host, e.g. "192.168.1.10:42101". */
  hostAddress?: string
  seq?: number
  content?: string
  fromPeerId?: string
  fromName?: string
  ts?: number
  members?: RoomMember[]
  /** Sender's view of who is currently in the room's voice channel (peerIds). */
  voiceActive?: string[]
}

export type VoiceWireAction = "join" | "leave" | "mute" | "unmute" | "speaking"

/** Wire shape for voice-channel presence ops (audio samples do NOT ride this — alpha.6 is pipeline-only). */
export interface VoiceControl {
  kind: "voice"
  action: VoiceWireAction
  roomId: string
  /** Whose state this reports (the relay preserves the ORIGINAL speaker). */
  aboutPeerId?: string
  aboutName?: string
  speaking?: boolean
}

export type ControlWire = RetentionControl | RoomControl | VoiceControl | IntroControl

/** Guard narrowing a decoded CTL payload to something this build understands. */
export function isKnownControl(value: unknown): value is ControlWire {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { kind?: unknown }).kind === "retention" ||
      (value as { kind?: unknown }).kind === "room" ||
      (value as { kind?: unknown }).kind === "voice" ||
      (value as { kind?: unknown }).kind === "intro")
  )
}

/** Invitation captured from a received room invite; joinRoom consumes one. */
export interface RoomInvitation {
  readonly roomId: string
  roomName: string
  readonly hostPeerId: string
  hostName: string
  receivedAt: number
}

// ---------- app-level event bus ----------
// The single channel through which state changes reach the UI (and commands reach services).

export type AppEvent =
  | { type: "identityLoaded"; identity: NodeIdentity }
  | { type: "peerChanged"; peer: PeerInfo }
  | { type: "message"; message: ChatMessage }
  | { type: "nodeStatus"; status: NodeStatus }
  | { type: "latency"; peerId: string; latencyMs: number }
  | { type: "settingsChanged"; settings: Settings }
  | { type: "retentionChanged"; peerId: string; state: PeerRetentionState; mine: RetentionPolicy }
  | { type: "notice"; scope: "retention" | "rooms"; message: string }
  | { type: "roomChanged"; room: RoomView }
  | { type: "roomClosed"; roomId: string; reason: string }
  | { type: "roomInvitation"; invitation: RoomInvitation }
  | { type: "voiceChanged"; voice: VoiceChannelStateView }
  | { type: "discoveredSeen"; peer: DiscoveredPeer }
  | { type: "discoveredLost"; peerId: string }
  | { type: "rendezvousChanged"; state: RendezvousStatusView }
  | { type: "introductionRequested"; request: IntroductionRequestView }
  | { type: "introductionAnswered"; requestId: string; accept: boolean }
  | { type: "error"; scope: ErrorScope; message: string }

export type NodeStatus = "offline" | "starting" | "online"
export type ErrorScope = "transport" | "identity" | "persistence" | "messaging" | "rendezvous"

// ---------- v3 rendezvous ----------

/**
 * Rendezvous participation, reported honestly (V3 §7).
 *
 * `connected` and `connectable` are separate facts and the client never derives
 * one from the other: a dropped control channel leaves a node dialable until its
 * lease actually lapses, and a live socket says nothing about whether a usable
 * descriptor is published. The UI must not invent presence from either alone.
 */
export interface RendezvousStatusView {
  /** Participation is switched on locally. */
  enabled: boolean
  /** A live control connection to the service exists. */
  connected: boolean
  /** A current descriptor is published, giving peers a path to attempt P2P. */
  connectable: boolean
  /** The handle presence is published under; null when nothing is published. */
  handle: string | null
  /** Lease expiry (unix ms); null when nothing is published. */
  expiresAt: number | null
}

/** "Zro is looking for you." Awaiting an Accept/Ignore that only the user makes. */
export interface IntroductionRequestView {
  readonly requestId: string
  /** The requester's self-claimed handle. A label, not a proven identity. */
  fromHandle: string
  /** The nodeId their descriptor claims; pinned when we dial, never before. */
  fromNodeId: string
  receivedAt: number
  expiresAt: number
}

/** A handle lookup result. Carries no address — that arrives only on accept. */
export interface HandleSearchResult {
  handle: string
  nodeId: string
  capabilities: string[]
  /** The service's claim that this node currently has a dialable path. */
  connectable: boolean
  expiresAt: number
}

export type AppListener = (event: AppEvent) => void

/**
 * Application-facing facade. The UI receives an instance of this and nothing else.
 * Implemented by src/core/app.ts; mocked nowhere else.
 */
export interface NexApp extends AsyncDisposable {
  readonly identity: NodeIdentity
  readonly status: NodeStatus

  emit(listener: AppListener): Unsubscribe

  listPeers(): Promise<PeerInfo[]>
  /** Connect (or reconnect) to a peer by address "host:port". Registers it if new. */
  connectTo(address: string): Promise<PeerInfo>
  disconnect(peerId: string): Promise<void>

  sendMessage(peerId: string, content: string): Promise<ChatMessage>
  conversation(peerId: string): Promise<ChatMessage[]>

  /** Measure current round-trip latency to a connected peer; resolves null if unavailable. */
  pingPeer(peerId: string): Promise<number | null>
  /**
   * Record an explicit trust decision for a peer. DEPRECATED in v1 —
   * alias for setVerified(peerId, trusted); kept so v0.x callers keep working.
   */
  setTrust(peerId: string, trusted: boolean): Promise<void>
  /** Record the user's identity verification decision (spec §8). Persists locally. */
  setVerified(peerId: string, verified: boolean): Promise<void>
  /** Set a local-only display name for a contact; empty string clears it. Persists locally. */
  renameContact(peerId: string, displayName: string): Promise<void>
  /**
   * Security properties of the active transport, for honest status display (spec §21.5).
   * "none" = transport provides no encryption (raw TCP); UI must say NO ENCRYPTION.
   */
  getLinkSecurity(): LinkSecurity
  /** Data-at-rest state of local storage; UI must surface NOT ENCRYPTED when "none". */
  getStorageSecurity(): StorageSecurity

  // ---------- v2 settings ----------

  /** Current local settings (theme, retention, read state). */
  getSettings(): Settings
  /** Switch theme; persists locally. Unknown ids are rejected by the caller (UI registry). */
  setTheme(themeId: string): Promise<void>
  /** Set message retention policy; prunes already-expired local history. */
  setRetention(policy: RetentionPolicy): Promise<void>
  /** Record that a conversation was just opened (drives unread counts). */
  markConversationRead(peerId: string): Promise<void>
  /** Stamp the app version whose changelog the user has seen ("What's New", vision §16). */
  markVersionSeen(version: string): Promise<void>

  // ---------- v2 retention agreements ----------

  /** Relationship-level retention view for a peer; null when no protocol state exists yet. */
  getRetentionAgreement(peerId: string): PeerRetentionState | null
  /**
   * Answer the peer's pending retention proposal. Accept converges the shared
   * window; reject keeps the current one and leaves the disagreement visible.
   */
  respondRetentionProposal(peerId: string, accept: boolean): Promise<void>

  // ---------- v2 rooms & voice (alpha.6) ----------

  /** Create a room hosted by THIS node; the listed peers are invited immediately. */
  createRoom(name: string, invitePeerIds: string[]): Promise<RoomView>
  /**
   * Join a room hosted elsewhere. With an invitation, the host link is dialed
   * automatically; otherwise hostPeerId must name a connected peer.
   */
  joinRoom(roomId: string, hostPeerId?: string): Promise<RoomView>
  /** Send one chat line to a room (host relays to the other members). */
  sendRoomMessage(roomId: string, content: string): Promise<void>
  /** Leave a room (sends bye); the local copy of history stays until closed. */
  leaveRoom(roomId: string): Promise<void>
  /** Host only: dissolve the room for everyone. */
  closeRoom(roomId: string): Promise<void>
  /** Rooms this node currently holds a view of (hosted or joined). */
  listRooms(): RoomView[]
  /** Pending invitations not yet consumed by joinRoom. */
  listInvitations(): RoomInvitation[]
  /** Join/leave this room's voice channel. */
  setVoiceActive(roomId: string, active: boolean): Promise<void>
  /** Mute/unmute self in this room's voice channel. */
  setVoiceMuted(roomId: string, muted: boolean): Promise<void>
  /** Simulated voice activity tick — pipeline-only alpha.6; real capture lands next. */
  setVoiceSpeaking(roomId: string, speaking: boolean): Promise<void>

  // ---------- v2 discovery (alpha.7) ----------

  /** Peers heard via LAN beacon or introduction, not yet connected. */
  listDiscovered(): DiscoveredPeer[]
  /** Dial a discovered peer (upgrades the entry to a normal registry peer). */
  connectDiscovered(peerId: string): Promise<PeerInfo>
  /** Create a nex:// invite for this node; share it over any channel. */
  createInvite(address?: string): Promise<string>
  /** Redeem a pasted invite: dials and fingerprint-pins in one step. */
  redeemInvite(code: string): Promise<PeerInfo>
  /** Vouch for `otherPeerId` to `toPeerId` (both must be connected). */
  introduceTo(toPeerId: string, otherPeerId: string): Promise<void>
  /** Toggle LAN beaconing; persists. Off = silent on hostile networks. */
  setDiscovery(enabled: boolean): Promise<void>

  // ---------- v3 rendezvous (optional Internet-scale discovery) ----------

  /**
   * Turn rendezvous participation on or off; persists. Enabling requires a
   * handle and service URL (from `config`, or already in settings). Disabling
   * stops publishing presence and never touches the local identity (V3 §8).
   */
  setRendezvous(enabled: boolean, config?: { baseUrl?: string; handle?: string }): Promise<void>
  /** Current participation state. Safe to call when disabled. */
  getRendezvousState(): RendezvousStatusView
  /** Exact-handle lookup. null = nobody by that handle is currently connectable. */
  searchHandle(handle: string): Promise<HandleSearchResult | null>
  /** "I'm looking for <handle>" — asks the service to notify them (V3 §11). */
  requestIntroduction(handle: string): Promise<{ requestId: string; expiresAt: number }>
  /** Introduction requests awaiting this user's Accept/Ignore. */
  listIntroductionRequests(): IntroductionRequestView[]
  /**
   * Answer a pending request. Accepting releases our address to that requester
   * and dials nothing by itself — it means "willing to attempt communication",
   * never "verified" (V3 §13).
   */
  respondIntroduction(requestId: string, accept: boolean): Promise<void>

  shutdown(): Promise<void>
}

/** Transport-provided link security, reported honestly by the UI. */
export type LinkSecurity = "none" | "transport"

/**
 * Data-at-rest security of local storage (vision §13), reported honestly:
 *   "none"       — plaintext files, chosen explicitly (--plaintext)
 *   "device-key" — standard tier: AEAD-encrypted with a key stored on this
 *                  device; no typing, defeats partial file leaks only
 *   "passphrase" — protective tier: DEK wrapped by Argon2id(passphrase);
 *                  lose it and the data is unrecoverable
 */
export type StorageSecurity = "none" | "device-key" | "passphrase"

export type Unsubscribe = () => void

// ---------- persistence ports ----------
// Implemented by src/core/state/persistence.ts over data/local/.

export interface IdentityStore {
  load(): Promise<NodeIdentity | null>
  save(identity: NodeIdentity, secret: IdentitySecret): Promise<void>
  /**
   * Read the secret backing this identity. Optional so in-memory and test stores
   * stay valid without it; features that need key material (v3 rendezvous
   * signing) degrade gracefully rather than assuming it is there.
   */
  loadSecret?(): Promise<IdentitySecret | null>
}

/** Opaque key material. v0.1 stores raw; never leaves data/local/. */
export interface IdentitySecret {
  /** Hex-encoded private seed material backing the nodeId. */
  readonly seedHex: string
  /**
   * v2: long-term X25519 private key for the encrypted transport (hex).
   * Optional so pre-v2 identity files load; generated on next boot if absent.
   */
  readonly identityPrivHex?: string
}

export interface ConversationStore {
  append(peerId: string, message: ChatMessage): Promise<void>
  loadAll(peerId: string): Promise<ChatMessage[]>
  /** Remove messages strictly older than cutoffMs; returns how many were removed. */
  deleteBefore?(peerId: string, cutoffMs: number): Promise<number>
}

export interface PeerRegistryStore {
  upsert(peer: PeerInfo): Promise<void>
  list(): Promise<PeerInfo[]>
}

/** Local preferences store (v2). Implemented by src/core/state/settings.ts. */
export interface SettingsStore {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

// ---------- transport port ----------
// The ONLY networking abstraction. Implementations live in src/network/.

export interface TransportEvents {
  onPeerStatus(callback: (peer: PeerInfo) => void): Unsubscribe
  onMessage(callback: (peerId: string, content: string, receivedAt: number) => void): Unsubscribe
  onError(callback: (scope: ErrorScope, message: string) => void): Unsubscribe
}

export interface P2PTransport extends TransportEvents, AsyncDisposable {
  /** Security capabilities of this implementation; omit when unencrypted. */
  readonly security?: TransportSecurity
  /** Begin listening for inbound connections. Returns the bound port. */
  start(options: { port?: number; identity: NodeIdentity }): Promise<number>
  stop(): Promise<void>

  /** Dial a remote node. Resolves once the handshake identifies the peer. */
  dial(address: string): Promise<PeerInfo>
  drop(peerId: string): Promise<void>

  /** Deliver a text payload to a connected peer. Rejects if not connected. */
  send(peerId: string, content: string): Promise<void>

  /**
   * Measure current round-trip latency to a connected peer.
   * Optional: implementations without latency measurement may omit it.
   */
  measureLatency?(peerId: string): Promise<number | null>

  /**
   * Send a relationship-level control op inside the secure channel.
   * Optional: transports without a control channel simply don't negotiate.
   * Carries any ControlWire (retention / room / voice).
   */
  sendControl?(peerId: string, control: ControlWire): Promise<void>
  /** Subscribe to control ops from peers. Optional, paired with sendControl. */
  onControl?(callback: (peerId: string, control: ControlWire) => void): Unsubscribe

  /**
   * Send one realtime voice frame inside the secure channel. Fire-and-forget:
   * implementations must never wait or retry for audio (vision §19).
   * Optional: transports without voice frames simply don't carry audio yet.
   */
  sendVoiceFrame?(peerId: string, meta: VoiceFrameMeta, payload: Uint8Array): void
  /** Subscribe to inbound voice frames. Optional, paired with sendVoiceFrame. */
  onVoiceFrame?(callback: (fromPeerId: string, meta: VoiceFrameMeta, payload: Uint8Array) => void): Unsubscribe
}

/**
 * The part of a transport that can cross NAT.
 *
 * Two machines behind home routers cannot dial each other, so the connection
 * has to be arranged rather than opened: both sides send at the same moment and
 * each one's outbound packet props the door for the other's. That needs two
 * things the ordinary transport port has no room for — an address measured on
 * the socket the peer will actually punch, and a way to start punching as the
 * side that did NOT dial.
 *
 * Optional by design. A build with no traversal simply omits it and every
 * connection stays direct, which is what happened before this existed.
 */
export interface NatTraversal {
  /** The local UDP port peers will punch. */
  readonly port: number
  /** Public address of that port as the internet sees it, once measured. */
  readonly publicCandidate: { host: string; port: number } | null
  /** Plain-language summary of what the NAT does, for when a connection fails. */
  readonly natDetailText: string
  /** Measure the public address. Costs seconds; the caller decides when. */
  discoverPublicCandidate(): Promise<{ address: { host: string; port: number } | null; detail: string }>
  /**
   * Punch toward a peer as the answering side, without dialling.
   *
   * The peer who asked for the introduction opens the handshake; this side only
   * has to be sending at the same time, or neither router opens.
   */
  expect(nodeId: string, candidates: ReadonlyArray<{ host: string; port: number }>): Promise<PeerInfo>
}

/** Envelope metadata for one voice frame (kept tiny; audio rides beside it). */
export interface VoiceFrameMeta {
  roomId: string
  /** Original speaker's nodeId — preserved across relay hops. */
  fromPeerId: string
  /** Monotonic per-sender sequence for loss/reorder detection. */
  seq: number
}

/**
 * Persists per-peer retention-agreement protocol state (theirs / pending /
 * convergence). Implemented plain + vault-wrapped like the settings store.
 */
export interface RetentionStore {
  load(): Promise<Record<string, PeerRetentionState>>
  save(all: Record<string, PeerRetentionState>): Promise<void>
}

/**
 * Security capability advertised by the transport implementation (v1).
 * Lets the app report link security honestly instead of hardcoding labels.
 */
export interface TransportSecurity {
  /** Whether the transport encrypts payloads end-to-end. Raw TCP: false. */
  readonly encrypted: boolean
}
