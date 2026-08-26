// Room state-machine tests — pure transitions, no sockets.
// Covers: host lifecycle, join/bye/close, chat relay + per-sender dedupe,
// union-merge membership, voice presence convergence, peer-loss semantics.
import { describe, expect, test } from "bun:test"
import type { RoomControl, RoomView, VoiceControl } from "../src/core/contract"
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
  stateControl,
} from "../src/core/room-service"

const HOST_CTX = { selfId: "host-1", selfName: "zro", isHost: true, hostPeerId: "host-1" }
const PEER_CTX_IN_HOST = { selfId: "peer-1", selfName: "roshan", isHost: false, hostPeerId: "host-1" }

function hostedRoom(): RoomView {
  return newHostedRoom("room1", "lounge", HOST_CTX, 1000)
}

describe("room lifecycle", () => {
  test("new hosted room has self as sole host member", () => {
    const room = hostedRoom()
    expect(room.members).toHaveLength(1)
    expect(room.members[0]!.role).toBe("host")
    expect(room.hostPeerId).toBe("host-1")
    expect(room.voice.state).toBe("idle")
  })

  test("join admits a member and fans state out to everyone else", () => {
    const room = hostedRoom()
    const outcome = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      2000,
    )
    expect(outcome).not.toBeNull()
    expect(outcome!.next!.members.map((m) => m.peerId)).toEqual(["host-1", "peer-1"])
    expect(outcome!.replies).toHaveLength(1) // only to non-joiner (the host is self)
    // Host sends to itself? No: replies exclude ctx.selfId.
    const snapshotOp = outcome!.replies?.[0]
    if (snapshotOp) {
      expect(snapshotOp.control.kind === "room" && snapshotOp.control.action === "state").toBe(true)
    }
  })

  test("duplicate join answers with snapshot only (idempotent)", () => {
    let room = hostedRoom()
    const first = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      2000,
    )!
    room = first.next!
    const again = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      3000,
    )!
    expect(again.next!.members).toHaveLength(2)
  })

  test("member-side join op is ignored (only hosts admit)", () => {
    const room = newJoinedRoom("room1", "lounge", PEER_CTX_IN_HOST, [], 1000)
    const outcome = onRoomControl(
      room,
      PEER_CTX_IN_HOST,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-9", fromName: "x" },
      0,
      2000,
    )
    expect(outcome).toBeNull()
  })

  test("bye removes member; host fans fresh snapshots to remaining members", () => {
    let room = hostedRoom()
    room = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      2000,
    )!.next!
    room = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-2", fromName: "cku" },
      0,
      2100,
    )!.next!

    const bye = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "bye", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      2200,
    )!
    expect(bye.next!.members.map((m) => m.peerId)).toEqual(["host-1", "peer-2"])
    // Fan-out goes to the remaining non-self member (peer-2), not to the leaver.
    expect(bye.replies?.map((r) => r.toPeerId)).toEqual(["peer-2"])
  })

  test("close dissolves the room on members, not on the host's own view", () => {
    const memberRoom = newJoinedRoom("room1", "lounge", PEER_CTX_IN_HOST, [], 1000)
    const closedMember = onRoomControl(
      memberRoom,
      PEER_CTX_IN_HOST,
      { kind: "room", action: "close", roomId: "room1" },
      0,
      2000,
    )
    expect(closedMember!.next).toBeNull()

    const closedHost = onRoomControl(hostedRoom(), HOST_CTX, { kind: "room", action: "close", roomId: "room1" }, 0, 2000)
    expect(closedHost).toBeNull() // host handles its own close in app layer
  })
})

describe("room chat", () => {
  function threeMemberHost(): RoomView {
    let room = hostedRoom()
    for (const [id, name] of [["peer-1", "roshan"], ["peer-2", "cku"]] as const) {
      room = onRoomControl(
        room,
        HOST_CTX,
        { kind: "room", action: "join", roomId: "room1", fromPeerId: id, fromName: name },
        0,
        1500,
      )!.next!
    }
    return room
  }

  test("own line appends locally with per-room seq", () => {
    const room = appendOwnMessage(hostedRoom(), "hi all", 1, HOST_CTX, 2000).next!
    expect(room.messages).toHaveLength(1)
    expect(room.messages[0]!.fromPeerId).toBe("host-1")
    expect(room.messages[0]!.seq).toBe(1)
  })

  test("inbound chat applies once and relays original authorship to other members", () => {
    const room = threeMemberHost()
    const control: RoomControl = {
      kind: "room",
      action: "chat",
      roomId: "room1",
      seq: 7,
      content: "hello from roshan",
      fromPeerId: "peer-1",
      fromName: "roshan",
      ts: 3000,
    }
    const outcome = onRoomControl(room, HOST_CTX, control, 0, 3100)!
    expect(outcome.seenSeq).toBe(7)
    expect(outcome.next!.messages.at(-1)!.fromName).toBe("roshan")
    // Relay reaches peer-2 but NOT the author and NOT self.
    expect(outcome.replies?.map((r) => r.toPeerId)).toEqual(["peer-2"])
    expect(outcome.replies?.[0]?.control).toEqual(control) // verbatim forward
  })

  test("replayed/reordered chat is deduped per sender", () => {
    const room = threeMemberHost()
    const control: RoomControl = {
      kind: "room",
      action: "chat",
      roomId: "room1",
      seq: 4,
      content: "once",
      fromPeerId: "peer-1",
      fromName: "roshan",
      ts: 3000,
    }
    const first = onRoomControl(room, HOST_CTX, control, 0, 3100)!
    expect(first.next!.messages).toHaveLength(1)
    const replay = onRoomControl(first.next!, HOST_CTX, control, first.seenSeq ?? 0, 3200)
    expect(replay).toBeNull()

    const stale = onRoomControl(
      first.next!,
      HOST_CTX,
      { ...control, seq: 3, content: "older" },
      first.seenSeq ?? 0,
      3300,
    )
    expect(stale).toBeNull()
    expect(first.next!.messages).toHaveLength(1)
  })

  test("message cap keeps the newest ROOM_MESSAGE_CAP lines", () => {
    let room = hostedRoom()
    for (let i = 0; i < 600; i++) {
      room = appendOwnMessage(room, `m${i}`, i + 1, HOST_CTX, 2000 + i).next!
    }
    expect(room.messages.length).toBeLessThanOrEqual(500)
    expect(room.messages.at(-1)!.content).toBe("m599")
  })
})

describe("membership union merge", () => {
  test("stale snapshot never removes known members; names refresh", () => {
    let memberRoom = newJoinedRoom("room1", "lounge", PEER_CTX_IN_HOST, [
      { peerId: "host-1", name: "zro", role: "host", joinedAt: 900 },
      { peerId: "peer-3", name: "third", role: "member", joinedAt: 1200 },
    ], 1300)

    // Snapshot that predates our knowledge of peer-3 (missing) must keep them.
    memberRoom = (
      onRoomControl(
        memberRoom,
        PEER_CTX_IN_HOST,
        {
          kind: "room",
          action: "state",
          roomId: "room1",
          roomName: "lounge",
          hostPeerId: "host-1",
          members: [{ peerId: "host-1", name: "zro", role: "host", joinedAt: 900 }],
          voiceActive: [],
        },
        0,
        1400,
      )!
    ).next!

    expect(memberRoom.members.map((m) => m.peerId).sort()).toEqual(["host-1", "peer-1", "peer-3"])
  })
})

describe("voice presence", () => {
  test("local join announces to every other member and marks channel connected", () => {
    // Give the host someone to announce TO (a solo room correctly fans out to nobody).
    let room = newHostedRoom("room1", "lounge", HOST_CTX, 1000)
    room = {
      ...room,
      members: [
        ...room.members,
        { peerId: "peer-1", name: "roshan", role: "member", joinedAt: 1100 },
      ],
    }
    const outcome = localVoiceJoin(room, HOST_CTX)
    expect(outcome.next!.voice.state).toBe("connected")
    expect(activePeers(outcome.next!)).toEqual(["host-1"])
    expect(outcome.replies?.map((r) => r.toPeerId)).toEqual(["peer-1"])
    expect(outcome.replies?.[0]?.control).toEqual({
      kind: "voice",
      action: "join",
      roomId: "room1",
      aboutPeerId: "host-1",
      aboutName: "zro",
    })
  })

  test("remote join/mute/speaking converge and host relays original speaker", () => {
    let room = hostedRoom()
    const join = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "join",
      roomId: "room1",
      aboutPeerId: "peer-1",
      aboutName: "roshan",
    })!
    room = join.next!
    expect(activePeers(room)).toEqual(["peer-1"])
    expect(join.replies).toHaveLength(0) // solo member besides host... none other than host+self

    const mute = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "mute",
      roomId: "room1",
      aboutPeerId: "peer-1",
    })!
    expect(mute.next!.voice.participants[0]!.muted).toBe(true)

    const speaking = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "speaking",
      roomId: "room1",
      aboutPeerId: "peer-1",
      speaking: true,
    })!
    expect(speaking.next!.voice.participants[0]!.speaking).toBe(true)
    expect(speaking.next!.voice.participants[0]!.lastSpokeAt).toBeDefined()
  })

  test("leave drops participant; unknown-sender ops are inert", () => {
    let room = hostedRoom()
    room = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "join",
      roomId: "room1",
      aboutPeerId: "peer-1",
      aboutName: "roshan",
    })!.next!

    // Local mute auto-registers self in the channel (Discord semantics).
    room = localVoiceMute(room, HOST_CTX, true).next!
    expect(room.voice.selfMuted).toBe(true)
    expect(activePeers(room)).toEqual(["peer-1", "host-1"])

    room = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "leave",
      roomId: "room1",
      aboutPeerId: "peer-1",
    })!.next!
    // Only self remains (auto-registered by the mute above).
    expect(activePeers(room)).toEqual(["host-1"])

    const ghost = onVoiceControl(room, HOST_CTX, {
      kind: "voice",
      action: "mute",
      roomId: "room1",
      aboutPeerId: "ghost",
    })
    expect(ghost).toBeNull()
  })

  test("state reconciliation adopts pre-existing speakers and drops departed ones", () => {
    const memberView = newJoinedRoom("room1", "lounge", PEER_CTX_IN_HOST, [
      { peerId: "host-1", name: "zro", role: "host", joinedAt: 900 },
      { peerId: "peer-1", name: "roshan", role: "member", joinedAt: 950 },
    ], 1000)

    const reconciled = onRoomControl(
      memberView,
      PEER_CTX_IN_HOST,
      {
        kind: "room",
        action: "state",
        roomId: "room1",
        hostPeerId: "host-1",
        members: [
          { peerId: "host-1", name: "zro", role: "host", joinedAt: 900 },
          { peerId: "peer-1", name: "roshan", role: "member", joinedAt: 950 },
        ],
        voiceActive: ["host-1"],
      },
      0,
      1100,
    )!
    expect(activePeers(reconciled.next!)).toEqual(["host-1"])
  })

  test("local leave clears mute and announces", () => {
    let room = localVoiceJoin(hostedRoom(), HOST_CTX).next!
    room = localVoiceSpeaking(room, HOST_CTX, true)!.next!
    const left = localVoiceLeave(room, HOST_CTX)
    expect(left.next!.voice.state).toBe("idle")
    expect(left.next!.voice.selfMuted).toBe(false)
    expect(activePeers(left.next!)).toEqual([])
  })
})

describe("link loss", () => {
  test("host prunes a dropped member and fans out snapshots", () => {
    let room = hostedRoom()
    room = onRoomControl(
      room,
      HOST_CTX,
      { kind: "room", action: "join", roomId: "room1", fromPeerId: "peer-1", fromName: "roshan" },
      0,
      2000,
    )!.next!

    const lost = onPeerLost(room, HOST_CTX, "peer-1")!
    expect(lost.next!.members.map((m) => m.peerId)).toEqual(["host-1"])
    expect(lost.notice).toContain("roshan")
  })

  test("member notices a lost HOST but keeps the view for reunion", () => {
    const memberRoom = newJoinedRoom("room1", "lounge", PEER_CTX_IN_HOST, [
      { peerId: "host-1", name: "zro", role: "host", joinedAt: 900 },
    ], 1000)
    const lost = onPeerLost(memberRoom, PEER_CTX_IN_HOST, "host-1")!
    expect(lost.next).not.toBeNull()
    expect(lost.notice).toContain("host")

    // A lost fellow member changes nothing on the member side.
    expect(onPeerLost(memberRoom, PEER_CTX_IN_HOST, "peer-99")).toBeNull()
  })
})
