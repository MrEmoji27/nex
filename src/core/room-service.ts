// Room & voice-channel state machine — pure functions, no I/O.
//
// Model (dream vision §12 extended to N peers; §19 groundwork):
//   - A room is anchored on its HOST's node. There is no server anywhere;
//     the room exists exactly as long as the host keeps it open.
//   - Every hop rides the SAME pairwise encrypted Noise links as chat.
//     Members that reach each other only through the host are star-topology
//     relays — the host re-sends their traffic verbatim, never altering
//     authorship (fromPeerId/fromName always name the ORIGINAL speaker).
//   - Membership snapshots come FROM THE HOST and are merged by union on
//     members (a member never invents state); chat dedupes on (sender, seq).
//   - Voice presence (join/leave/mute/speaking) converges the same way. Audio
//     samples do NOT ride these controls; they use binary voice frames.
//   - Honesty rule (vision §12/§24): every node stores ITS OWN copy of room
//     history under its local caps; nothing here claims remote deletion.
import type {
  ControlWire,
  RoomControl,
  RoomMember,
  RoomView,
  VoiceControl,
} from "./contract"
import { ROOM_MESSAGE_CAP } from "./contract"

/** What the app must DO after a pure transition. */
export interface RoomOutcome {
  /** Replacement view for this room; null = drop the room entirely. */
  next: RoomView | null
  /** Ops to send, each addressed to specific peers (fan-out resolved by caller). */
  replies?: Array<{ toPeerId: string; control: ControlWire }>
  /** Human-readable summary for notices/UI. Factual, no overclaiming. */
  notice?: string
}

/** Everything the machine needs to know about WHO is applying the transition. */
export interface RoomContext {
  selfId: string
  selfName: string
  /** True when self hosts this room. */
  isHost: boolean
  hostPeerId: string
}

function member(peerId: string, name: string, role: RoomMember["role"], now: number): RoomMember {
  return { peerId, name, role, joinedAt: now }
}

/** Fresh host-side view with self as the only member. */
export function newHostedRoom(roomId: string, name: string, ctx: RoomContext, now: number): RoomView {
  return {
    roomId,
    name,
    hostPeerId: ctx.selfId,
    createdAt: now,
    members: [member(ctx.selfId, ctx.selfName, "host", now)],
    messages: [],
    voice: { roomId, state: "idle", participants: [], selfMuted: false },
  }
}

/** Member-side view right after a successful join handshake with the host. */
export function newJoinedRoom(
  roomId: string,
  name: string,
  ctx: RoomContext,
  hostMembers: RoomMember[],
  now: number,
): RoomView {
  const members = hostMembers.length > 0 ? [...hostMembers] : [member(ctx.hostPeerId, "host", "host", now)]
  if (!members.some((m) => m.peerId === ctx.selfId)) {
    members.push(member(ctx.selfId, ctx.selfName, "member", now))
  }
  return {
    roomId,
    name,
    hostPeerId: ctx.hostPeerId,
    createdAt: now,
    members,
    messages: [],
    voice: { roomId, state: "connected", participants: [], selfMuted: false },
  }
}

/** Host's authoritative membership snapshot. */
export function stateControl(view: RoomView, voiceActive: string[]): RoomControl {
  return {
    kind: "room",
    action: "state",
    roomId: view.roomId,
    roomName: view.name,
    hostPeerId: view.hostPeerId,
    members: view.members.map((m) => ({ ...m })),
    voiceActive: [...voiceActive],
  }
}

/** Append one LOCAL line (sender side): optimistic, numbered by our per-room counter. */
export function appendOwnMessage(
  view: RoomView,
  content: string,
  seq: number,
  ctx: RoomContext,
  now: number,
): RoomOutcome {
  const next: RoomView = {
    ...view,
    messages: capMessages([
      ...view.messages,
      { roomId: view.roomId, seq, fromPeerId: ctx.selfId, fromName: ctx.selfName, content, sentAt: now },
    ]),
  }
  return { next }
}

/**
 * Apply one inbound room control to OUR view of the room.
 * `seenSeq` is the highest already-applied chat seq from this sender (0 = none).
 */
export function onRoomControl(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: RoomControl,
  seenSeq: number,
  now: number,
): (RoomOutcome & { seenSeq?: number }) | null {
  switch (control.action) {
    case "state":
      return onState(view, ctx, control)
    case "chat":
      return onChat(view, ctx, control, seenSeq, now)
    case "bye":
      return onBye(view, ctx, control)
    case "close":
      return onClose(view, ctx)
    case "invite":
      // Invitations are consumed by the app layer (creates an invitation entry).
      return null
    case "join":
      return onJoin(view, ctx, control)
    default:
      return null
  }
}

/** Member asked in. Host admits them and fans the authoritative state everywhere. */
function onJoin(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: RoomControl,
): (RoomOutcome & { seenSeq?: number }) | null {
  if (!ctx.isHost || !view || !control.fromPeerId) return null
  const joiner = control.fromPeerId
  if (view.members.some((m) => m.peerId === joiner)) {
    // Already admitted (retransmit): answer with the authoritative snapshot only.
    return {
      next: view,
      replies: [{ toPeerId: joiner, control: stateControl(view, activePeers(view)) }],
    }
  }
  const next: RoomView = {
    ...view,
    members: [
      ...view.members,
      member(joiner, control.fromName ?? joiner.slice(0, 8), "member", Date.now()),
    ],
  }
  const snapshot = stateControl(next, activePeers(next))
  return {
    next,
    notice: `${control.fromName ?? joiner.slice(0, 8)} joined the room`,
    replies: others(ctx, next).map((toPeerId) => ({ toPeerId, control: snapshot })),
  }
}

function onState(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: RoomControl,
): (RoomOutcome & { seenSeq?: number }) | null {
  if (!control.members || !Array.isArray(control.members)) return null

  if (ctx.isHost) {
    // A member echoing our own snapshot back is noise; the host IS the authority.
    return null
  }

  const base: RoomView =
    view ?? {
      roomId: control.roomId,
      name: control.roomName ?? "room",
      hostPeerId: control.hostPeerId ?? ctx.hostPeerId,
      createdAt: now0(control),
      members: [],
      messages: [],
      voice: { roomId: control.roomId, state: "connected", participants: [], selfMuted: false },
    }
  // Union merge keyed by peerId: never lose someone we already see because the
  // host's snapshot raced a join; refresh names/joinedAt from the authority.
  const merged = new Map(base.members.map((m) => [m.peerId, m]))
  for (const incoming of control.members) {
    const existing = merged.get(incoming.peerId)
    merged.set(incoming.peerId, existing ? { ...existing, ...incoming } : { ...incoming })
  }

  const active = new Set(control.voiceActive ?? [])
  const byMemberId = new Map([...merged.values()].map((m) => [m.peerId, m]))
  // Full reconciliation against the host's authority: drop departed speakers,
  // adopt ones who were already in-channel before we arrived.
  const participants = base.voice.participants.filter((p) => active.has(p.peerId))
  for (const peerId of active) {
    if (!participants.some((p) => p.peerId === peerId)) {
      const known = byMemberId.get(peerId)
      participants.push({
        peerId,
        name: known?.name ?? peerId.slice(0, 8),
        muted: false,
        speaking: false,
      })
    }
  }
  const voiceNext: RoomView["voice"] = {
    ...base.voice,
    participants,
  }
  const next: RoomView = {
    ...base,
    name: control.roomName ?? base.name,
    hostPeerId: control.hostPeerId ?? base.hostPeerId,
    members: [...merged.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.peerId.localeCompare(b.peerId)),
    voice: voiceNext,
  }
  return { next }
}

function onChat(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: RoomControl,
  seenSeq: number,
  now: number,
): (RoomOutcome & { seenSeq?: number }) | null {
  if (!view || typeof control.seq !== "number" || !control.content) return null
  if (!control.fromPeerId) return null
  // Per-sender monotonic dedupe: replays and reordered relays apply once.
  if (control.seq <= seenSeq) return null
  const next: RoomView = {
    ...view,
    messages: capMessages([
      ...view.messages,
      {
        roomId: view.roomId,
        seq: control.seq,
        fromPeerId: control.fromPeerId,
        fromName: control.fromName ?? control.fromPeerId.slice(0, 8),
        content: control.content,
        sentAt: control.ts ?? now,
      },
    ]),
  }
  const outcome: RoomOutcome & { seenSeq: number } = { next, seenSeq: control.seq }
  // HOST RELAY: the host forwards the original authorship to every other
  // member (not back to the sender, not to itself).
  if (ctx.isHost) {
    outcome.replies = view.members
      .filter((m) => m.peerId !== ctx.selfId && m.peerId !== control.fromPeerId)
      .map((m) => ({ toPeerId: m.peerId, control }))
  }
  return outcome
}

function onBye(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: RoomControl,
): (RoomOutcome & { seenSeq?: number }) | null {
  if (!view || !control.fromPeerId) return null
  const leaver = control.fromPeerId
  if (!view.members.some((m) => m.peerId === leaver)) return null
  const next: RoomView = {
    ...view,
    members: view.members.filter((m) => m.peerId !== leaver),
    voice: { ...view.voice, participants: view.voice.participants.filter((p) => p.peerId !== leaver) },
  }
  const outcome: RoomOutcome = {
    next,
    notice: `${control.fromName ?? leaver.slice(0, 8)} left the room`,
  }
  if (ctx.isHost) {
    outcome.replies = [
      ...view.members
        .filter((m) => m.peerId !== ctx.selfId && m.peerId !== leaver)
        .map((m) => ({ toPeerId: m.peerId, control: stateControl(next, activePeers(next)) })),
    ]
  }
  return outcome
}

function onClose(view: RoomView | undefined, ctx: RoomContext): RoomOutcome | null {
  if (!view) return null
  // Members drop the room entirely; the host's own close is handled by the app
  // (it initiated it). History was always local-only — it dies with the view.
  if (ctx.isHost) return null
  return { next: null, notice: `room "${view.name}" was closed by the host` }
}

// ---------- voice presence ----------

/** Apply one inbound voice-presence control to our room view. */
export function onVoiceControl(
  view: RoomView | undefined,
  ctx: RoomContext,
  control: VoiceControl,
): (RoomOutcome & { selfStateChanged?: boolean }) | null {
  if (!view) return null
  const about = control.aboutPeerId
  if (!about || about === ctx.selfId) return null
  const participants = [...view.voice.participants]
  const idx = participants.findIndex((p) => p.peerId === about)

  if (control.action === "join") {
    if (idx >= 0) return null
    participants.push({
      peerId: about,
      name: control.aboutName ?? about.slice(0, 8),
      muted: false,
      speaking: false,
    })
  } else if (idx < 0) {
    // leave/mute/speaking for someone we don't track yet: ignore except leave.
    if (control.action === "leave") return null
    return null
  } else if (control.action === "leave") {
    participants.splice(idx, 1)
  } else if (control.action === "mute" || control.action === "unmute") {
    participants[idx] = { ...participants[idx]!, muted: control.action === "mute" }
  } else if (control.action === "speaking") {
    participants[idx] = {
      ...participants[idx]!,
      speaking: control.speaking ?? false,
      lastSpokeAt: control.speaking ? Date.now() : participants[idx]!.lastSpokeAt,
    }
  }

  const next: RoomView = { ...view, voice: { ...view.voice, participants } }
  const outcome: RoomOutcome & { selfStateChanged?: boolean } = { next }
  // HOST RELAY: forward the original speaker's state to every other member.
  if (ctx.isHost) {
    outcome.replies = view.members
      .filter((m) => m.peerId !== ctx.selfId && m.peerId !== about)
      .map((m) => ({ toPeerId: m.peerId, control }))
  }
  return outcome
}

/** Local user joined the voice channel (their OWN view + what to announce). */
export function localVoiceJoin(view: RoomView, ctx: RoomContext): RoomOutcome {
  const participants = view.voice.participants.some((p) => p.peerId === ctx.selfId)
    ? view.voice.participants
    : [
        ...view.voice.participants,
        { peerId: ctx.selfId, name: ctx.selfName, muted: view.voice.selfMuted, speaking: false },
      ]
  const next: RoomView = {
    ...view,
    voice: { ...view.voice, state: "connected", participants },
  }
  const join: VoiceControl = {
    kind: "voice",
    action: "join",
    roomId: view.roomId,
    aboutPeerId: ctx.selfId,
    aboutName: ctx.selfName,
  }
  return {
    next,
    replies: others(ctx, view).map((toPeerId) => ({ toPeerId, control: join })),
  }
}

/** Local user left the voice channel. */
export function localVoiceLeave(view: RoomView, ctx: RoomContext): RoomOutcome {
  const next: RoomView = {
    ...view,
    voice: {
      ...view.voice,
      state: "idle",
      participants: view.voice.participants.filter((p) => p.peerId !== ctx.selfId),
      selfMuted: false,
    },
  }
  const leave: VoiceControl = {
    kind: "voice",
    action: "leave",
    roomId: view.roomId,
    aboutPeerId: ctx.selfId,
  }
  return {
    next,
    replies: others(ctx, view).map((toPeerId) => ({ toPeerId, control: leave })),
  }
}

/** Local mute/unmute. */
export function localVoiceMute(view: RoomView, ctx: RoomContext, muted: boolean): RoomOutcome {
  // Muting implies presence: auto-register self WITHOUT dropping anyone.
  const alreadyIn = view.voice.participants.some((p) => p.peerId === ctx.selfId)
  const participants = alreadyIn
    ? view.voice.participants.map((p) => (p.peerId === ctx.selfId ? { ...p, muted } : p))
    : [...view.voice.participants, { peerId: ctx.selfId, name: ctx.selfName, muted, speaking: false }]
  const next: RoomView = {
    ...view,
    voice: { ...view.voice, selfMuted: muted, participants },
  }
  const control: VoiceControl = {
    kind: "voice",
    action: muted ? "mute" : "unmute",
    roomId: view.roomId,
    aboutPeerId: ctx.selfId,
  }
  return {
    next,
    replies: others(ctx, view).map((toPeerId) => ({ toPeerId, control })),
  }
}

/** Simulated speaking toggle (pipeline-only increment). */
export function localVoiceSpeaking(view: RoomView, ctx: RoomContext, speaking: boolean): RoomOutcome | null {
  if (!view.voice.participants.some((p) => p.peerId === ctx.selfId)) return null
  const participants = view.voice.participants.map((p) =>
    p.peerId === ctx.selfId
      ? { ...p, speaking, lastSpokeAt: speaking ? Date.now() : p.lastSpokeAt }
      : p,
  )
  const next: RoomView = { ...view, voice: { ...view.voice, participants } }
  const control: VoiceControl = {
    kind: "voice",
    action: "speaking",
    roomId: view.roomId,
    aboutPeerId: ctx.selfId,
    speaking,
  }
  return {
    next,
    replies: others(ctx, view).map((toPeerId) => ({ toPeerId, control })),
  }
}

/**
 * A linked peer vanished. Host side: membership is LIVE — the departing member
 * is removed and the rest are told. Member side: only marks the room orphaned
 * when the HOST disappeared (notice; the view stays for the reunion).
 */
export function onPeerLost(view: RoomView, ctx: RoomContext, lostPeerId: string): RoomOutcome | null {
  if (!view.members.some((m) => m.peerId === lostPeerId)) return null
  if (ctx.isHost) {
    const next: RoomView = {
      ...view,
      members: view.members.filter((m) => m.peerId !== lostPeerId),
      voice: { ...view.voice, participants: view.voice.participants.filter((p) => p.peerId !== lostPeerId) },
    }
    const gone = view.members.find((m) => m.peerId === lostPeerId)
    return {
      next,
      notice: `${gone?.name ?? lostPeerId.slice(0, 8)} dropped out`,
      replies: others(ctx, next).map((toPeerId) => ({
        toPeerId,
        control: stateControl(next, activePeers(next)),
      })),
    }
  }
  if (lostPeerId === ctx.hostPeerId) {
    return { next: view, notice: "host link lost — room unreachable until they return" }
  }
  return null
}

/** peerIds currently in the voice channel per a view. */
export function activePeers(view: RoomView): string[] {
  return view.voice.participants.map((p) => p.peerId)
}

function others(ctx: RoomContext, view: RoomView): string[] {
  return view.members.filter((m) => m.peerId !== ctx.selfId).map((m) => m.peerId)
}

function capMessages(messages: RoomView["messages"]): RoomView["messages"] {
  return messages.length > ROOM_MESSAGE_CAP ? messages.slice(messages.length - ROOM_MESSAGE_CAP) : messages
}

function now0(control: RoomControl): number {
  return control.ts ?? Date.now()
}
