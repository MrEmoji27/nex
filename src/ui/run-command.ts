// What a slash command does.
//
// This used to be a chain of else-ifs inside the interface component, which had
// three consequences worth naming:
//
//   - Nothing could test it. The dispatch was reachable only by rendering a
//     terminal and typing into it, so it was the one part of the app with no
//     cover at all — and it was the part users touch first.
//   - Results went wherever the component happened to put them, which was a
//     four-second truncated line in the footer. Commands appeared to do
//     nothing.
//   - An unrecognised command fell off the end and returned silently.
//
// Everything here reports through `ctx.log`. A command that produces no output
// is a command that looks broken, so every path says something — including the
// ones that fail.

import type { NexApp, PeerInfo, RetentionPolicy, RoomInvitation, RoomView } from "../core/contract.ts"
import type { NetDiagnostics } from "../main/node-app"
import { COMMANDS, DEFAULT_RENDEZVOUS_URL, findCommand, suggest, usage } from "./commands"

export interface CommandContext {
  app: NexApp
  /** Absent in builds without the UDP transport; /net and /stun say so. */
  net?: NetDiagnostics
  selectedPeerId: string | null
  peers: readonly PeerInfo[]
  rooms: readonly RoomView[]
  invitations: readonly RoomInvitation[]
  activeRoom: RoomView | null
  /** Service to use when /rendezvous is given a handle but no URL. */
  rendezvousUrl?: string
  /** Output. Everything the user learns from a command comes through here. */
  log(text: string, tone?: "ok" | "bad"): void
  openModal(kind: "verify" | "settings" | "add-peer"): void
  connectTo(address: string): void
  /** Returns false when no theme matched, so the caller can say so. */
  applyTheme(needle: string): boolean
  toggleVoice(): void
  toggleMute(): void
}

/** Run one line beginning with "/". Never throws. */
export async function runCommand(line: string, ctx: CommandContext): Promise<void> {
  const [head = "", ...rest] = line.slice(1).split(/\s+/)
  const cmd = head.toLowerCase()
  const arg = rest.join(" ").trim()

  if (!cmd) {
    ctx.log("type a command name after the slash — /help lists them")
    return
  }
  if (!findCommand(cmd)) {
    const near = suggest(cmd)
    ctx.log(near ? `no such command "/${cmd}" — did you mean ${usage(near)}?` : `no such command "/${cmd}" — /help lists them`, "bad")
    return
  }

  try {
    await dispatch(cmd, arg, ctx)
  } catch (err) {
    // A command that throws must still say what happened. This is the last
    // line of defence against the silence this module exists to remove.
    ctx.log(`${cmd}: ${err instanceof Error ? err.message : String(err)}`, "bad")
  }
}

async function dispatch(cmd: string, arg: string, ctx: CommandContext): Promise<void> {
  const { app, log } = ctx

  switch (cmd) {
    // ---------- help ----------
    case "help": {
      if (arg) {
        const spec = findCommand(arg.replace(/^\//, "").toLowerCase())
        log(spec ? `${usage(spec)} — ${spec.summary}` : `no such command "${arg}"`, spec ? "ok" : "bad")
        return
      }
      let group = ""
      for (const spec of COMMANDS) {
        if (spec.group !== group) {
          group = spec.group
          log(`— ${group} —`)
        }
        log(`${usage(spec)}  ${spec.summary}`)
      }
      return
    }

    // ---------- finding people ----------
    case "rendezvous": {
      const [mode = "", ...restArgs] = arg.split(/\s+/).filter(Boolean)
      // Either order, and the URL is optional: a handle is the part only the
      // user knows, and making them retype a service address they have already
      // used once is how a working command gets abandoned.
      const givenUrl = restArgs.find((t) => /^https?:\/\//i.test(t))
      const handle = restArgs.find((t) => t !== givenUrl) ?? ""
      const url = givenUrl ?? ctx.rendezvousUrl ?? DEFAULT_RENDEZVOUS_URL
      if (!mode) {
        const state = app.getRendezvousState()
        log(
          state.enabled
            ? `rendezvous ${state.connected ? "connected" : "offline"}${state.handle ? ` as "${state.handle}"` : ""}, ${state.connectable ? "reachable" : "not reachable"}`
            : "rendezvous is off — /rendezvous on <url> <handle>",
        )
        return
      }
      if (mode === "off") {
        await app.setRendezvous(false)
        log("rendezvous off")
        return
      }
      if (mode !== "on" || !handle) {
        log("usage: /rendezvous on <handle> [url]  ·  /rendezvous off", "bad")
        return
      }
      log(`publishing as "${handle}" on ${url}…`)
      await app.setRendezvous(true, { baseUrl: url, handle })
      const state = app.getRendezvousState()
      log(state.connectable ? `published as "${handle}" — people can /find you` : `rendezvous enabled; waiting to publish`)
      return
    }

    case "find": {
      if (!arg) {
        log("usage: /find <handle>", "bad")
        return
      }
      log(`looking for ${arg}…`)
      const found = await app.searchHandle(arg)
      if (!found) {
        log(`nobody is registered as "${arg}"`, "bad")
        return
      }
      log(`${found.handle} is here — ${found.connectable ? "reachable" : "not reachable"}, ${found.nodeId.slice(0, 8)}…`)
      log(`ask for an introduction with /ask ${found.handle}`)
      return
    }

    case "ask": {
      if (!arg) {
        log("usage: /ask <handle>", "bad")
        return
      }
      await app.requestIntroduction(arg)
      log(`asked ${arg} for an introduction — waiting for them to accept`)
      return
    }

    case "accept":
    case "ignore": {
      const pending = app.listIntroductionRequests()
      if (pending.length === 0) {
        log("no introductions waiting", "bad")
        return
      }
      const match = arg ? pending.find((r) => r.requestId === arg || r.requestId.startsWith(arg)) : pending[0]
      if (!match) {
        log(`no introduction matching "${arg}" — ${pending.length} waiting`, "bad")
        return
      }
      const accept = cmd === "accept"
      await app.respondIntroduction(match.requestId, accept)
      log(accept ? `accepted ${match.fromHandle} — connecting directly` : `ignored ${match.fromHandle}`)
      return
    }

    case "invite": {
      const code = await app.createInvite(arg || undefined)
      log(code)
      log("paste that to them; it carries a fingerprint so the first connection is checked")
      return
    }

    case "connect": {
      if (!arg) {
        log("usage: /connect <host:port>", "bad")
        return
      }
      log(`dialling ${arg}…`)
      ctx.connectTo(arg)
      return
    }

    // ---------- people ----------
    case "peers": {
      const connected = ctx.peers.filter((p) => p.status === "connected")
      if (ctx.peers.length === 0) {
        log("nobody yet — /find someone, or /invite to send a code")
        return
      }
      log(`${connected.length} connected of ${ctx.peers.length} known`)
      for (const peer of ctx.peers) {
        const route = ctx.net?.routeOf(peer.peerId)
        log(
          `${peer.displayName ?? peer.name} · ${peer.status}${route ? ` · ${route}` : ""}${peer.latencyMs != null ? ` · ${peer.latencyMs}ms` : ""} · ${peer.peerId.slice(0, 8)}…`,
        )
      }
      return
    }

    case "ping": {
      if (!ctx.selectedPeerId) {
        log("no one selected — pick someone in PEOPLE first", "bad")
        return
      }
      const ms = await app.pingPeer(ctx.selectedPeerId)
      log(ms == null ? "no answer" : `${ms}ms`)
      return
    }

    case "verify": {
      if (!ctx.selectedPeerId) {
        log("no one selected — pick someone in PEOPLE first", "bad")
        return
      }
      ctx.openModal("verify")
      return
    }

    case "trust": {
      if (!ctx.selectedPeerId) {
        log("no one selected — pick someone in PEOPLE first", "bad")
        return
      }
      if (arg !== "on" && arg !== "off") {
        log("usage: /trust on|off", "bad")
        return
      }
      await app.setVerified(ctx.selectedPeerId, arg === "on")
      log(arg === "on" ? "marked verified" : "verification cleared")
      return
    }

    case "rename": {
      if (!ctx.selectedPeerId) {
        log("no one selected — /rename renames a CONTACT; /name renames you", "bad")
        return
      }
      if (!arg) {
        log("usage: /rename <name>", "bad")
        return
      }
      await app.renameContact(ctx.selectedPeerId, arg)
      log(`renamed to "${arg}" — in your copy only`)
      return
    }

    case "disconnect": {
      if (!ctx.selectedPeerId) {
        log("no one selected", "bad")
        return
      }
      await app.disconnect(ctx.selectedPeerId)
      log("disconnected")
      return
    }

    // ---------- your node ----------
    case "name": {
      if (!arg) {
        log(`you are "${app.identity.name}"  ·  ${app.identity.nodeId.slice(0, 8)}…`)
        return
      }
      await app.setDisplayName(arg)
      log(`you are now "${arg}" — peers see this when they meet you`)
      return
    }

    case "net": {
      if (!ctx.net) {
        log("this build has no UDP transport wired", "bad")
        return
      }
      const mapped = ctx.net.publicCandidate
      log(`local udp port ${ctx.net.udpPort} · public ${mapped ? `${mapped.host}:${mapped.port}` : "unknown — run /stun"}`)
      log(ctx.net.natDetail)
      const connected = ctx.peers.filter((p) => p.status === "connected")
      if (connected.length === 0) {
        log("no connections to route yet")
        return
      }
      for (const peer of connected) {
        log(`${peer.displayName ?? peer.name} over ${ctx.net.routeOf(peer.peerId) ?? "unknown"}`)
      }
      return
    }

    case "stun": {
      if (!ctx.net) {
        log("this build has no UDP transport wired", "bad")
        return
      }
      log("measuring…")
      const report = await ctx.net.measure()
      log(report.address ? `the internet sees you at ${report.address.host}:${report.address.port}` : "no STUN server answered", report.address ? "ok" : "bad")
      log(report.detail)
      return
    }

    case "retention": {
      if (!["24h", "7d", "forever"].includes(arg)) {
        log("usage: /retention 24h|7d|forever", "bad")
        return
      }
      await app.setRetention(arg as RetentionPolicy)
      log(`messages kept: ${arg}`)
      return
    }

    case "theme": {
      if (!arg) {
        ctx.openModal("settings")
        return
      }
      // Called once and remembered: applyTheme changes the theme, so asking it
      // twice to build one message would cycle two steps.
      const applied = ctx.applyTheme(arg)
      log(applied ? `theme: ${arg}` : `unknown theme "${arg}" — /themes`, applied ? "ok" : "bad")
      return
    }

    case "themes": {
      ctx.openModal("settings")
      return
    }

    // ---------- rooms & voice ----------
    case "room": {
      const [roomName = "", inviteList = ""] = arg.split(":").map((part) => part.trim())
      if (!roomName) {
        log("usage: /room <name>[:peer,peer]", "bad")
        return
      }
      const ids: string[] = []
      for (const token of inviteList.split(",").map((t) => t.trim()).filter(Boolean)) {
        const peer = ctx.peers.find((p) => p.peerId === token || p.name === token || p.displayName === token)
        if (!peer) {
          log(`unknown peer "${token}" — /peers lists them`, "bad")
          continue
        }
        ids.push(peer.peerId)
      }
      const room = await app.createRoom(roomName, ids)
      log(`room "${room.name}" hosted (${room.roomId})${ids.length ? `, ${ids.length} invited` : ""}`)
      return
    }

    case "join": {
      const invitation = ctx.invitations.find((i) => i.roomId === arg || i.roomName === arg)
      if (!invitation) {
        log(ctx.invitations.length === 0 ? "no invitations — wait for a host to invite you" : `no invitation matching "${arg}"`, "bad")
        return
      }
      const room = await app.joinRoom(invitation.roomId)
      log(`joined "${room.name}"`)
      return
    }

    case "rooms": {
      if (ctx.rooms.length === 0) {
        log("no rooms — host one with /room <name>")
        return
      }
      for (const room of ctx.rooms) {
        const voice = room.voice.participants.length
        log(`${room.roomId} · ${room.name} · ${room.members.length} member${room.members.length === 1 ? "" : "s"}${voice ? ` · ${voice} in voice` : ""}`)
      }
      return
    }

    case "say": {
      if (!ctx.activeRoom) {
        log("no active room — /rooms, then /join", "bad")
        return
      }
      if (!arg) {
        log("usage: /say <text>", "bad")
        return
      }
      await app.sendRoomMessage(ctx.activeRoom.roomId, arg)
      return
    }

    case "leave": {
      const target = ctx.rooms.find((r) => r.roomId === arg || r.name === arg)
      if (!target) {
        log("usage: /leave <id|name>", "bad")
        return
      }
      await app.leaveRoom(target.roomId)
      log(`left "${target.name}"`)
      return
    }

    case "close": {
      const target = ctx.rooms.find((r) => r.roomId === arg || r.name === arg)
      if (!target) {
        log("usage: /close <id|name>", "bad")
        return
      }
      await app.closeRoom(target.roomId)
      log(`closed "${target.name}" for everyone`)
      return
    }

    case "voice": {
      if (!ctx.activeRoom) {
        log("no active room — host one with /room <name>", "bad")
        return
      }
      ctx.toggleVoice()
      return
    }

    case "mute": {
      if (!ctx.activeRoom) {
        log("no active room — host one with /room <name>", "bad")
        return
      }
      ctx.toggleMute()
      return
    }

    default:
      // Unreachable: the registry check in runCommand already rejected it.
      log(`"/${cmd}" is listed but not implemented`, "bad")
  }
}
