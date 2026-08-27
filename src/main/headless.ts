// Headless stdin/stdout node.
// Same app factory as the TUI (real core when merged, mock fallback), no terminal UI.
// Lines on stdin are messages to the selected/first connected peer; output is JSON lines.
// CLI flags override env: --name/-n, --port/-p, --data-dir/-d, --mock
//
// `runHeadless(options)` is the embeddable entry (used by the compiled `nex`
// binary); running this file directly still works for repo development.
import type { NetDiagnostics } from "./node-app"
import type { NexApp, Unsubscribe } from "../core/contract.ts"
import { parseArgs } from "./args"

/** Options accepted by runHeadless — a superset of NodeOptions' common fields. */
export interface HeadlessOptions {
  name?: string
  port?: number
  dataDir?: string
  passphrase?: string
  plaintext?: boolean
  mock?: boolean
}

async function loadApp(
  opts: HeadlessOptions,
): Promise<{ app: NexApp; mock: boolean; boundPort?: number | null; storage?: string; net?: NetDiagnostics }> {
  const PORT = opts.port ?? 42001
  if (opts.mock) {
    const { createMockApp } = await import("../network/mock-transport")
    return { app: await createMockApp({ port: PORT, name: opts.name }), mock: true }
  }
  const { createNodeApp } = await import("./node-app")
  const { app, port, storageSecurity, net } = await createNodeApp({
    name: opts.name,
    port: PORT,
    dataDir: opts.dataDir,
    passphrase: opts.passphrase,
    plaintext: opts.plaintext === true,
  })
  return { app, mock: false, boundPort: port, storage: storageSecurity, net }
}

function out(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

/** The full stdin/stdout loop; refs hold mutable selections across handlers. */
interface HeadlessLoop {
  app: NexApp
  mock: boolean
  boundPort?: number | null
  storage?: string
  net?: NetDiagnostics
  port: number
  selectedPeerIdRef: { current: string | null }
  selectedRoomIdRef: { current: string | null }
}

/** Repo-dev entry: parse argv and run the loop (mirrors the old script behavior). */
async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs([...argv])
  const merged: HeadlessOptions = {
    name: args.name ?? process.env.NEX_NAME,
    port: args.port ?? (process.env.NEX_PORT ? Number(process.env.NEX_PORT) : undefined),
    dataDir: args.dataDir ?? process.env.NEX_DATA_DIR,
    passphrase: args.passphrase ?? process.env.NEX_PASSPHRASE,
    plaintext: args.plaintext || process.env.NEX_PLAINTEXT === "1",
    mock: args.mock || process.env.NEX_MOCK === "1",
  }
  await runHeadless(merged)
}

export async function runHeadless(opts: HeadlessOptions): Promise<void> {
  const PORT = opts.port ?? 42001
  const { app, mock, boundPort, storage, net } = await loadApp(opts)
  await runHeadlessLoop({
    app,
    mock,
    boundPort,
    storage,
    net,
    port: PORT,
    selectedPeerIdRef: { current: null },
    selectedRoomIdRef: { current: null },
  })
}

async function runHeadlessLoop(loop: HeadlessLoop): Promise<void> {
  const { app, mock, boundPort, storage, net, port: PORT } = loop
  let selectedPeerId = loop.selectedPeerIdRef.current

  out({
    event: "ready",
    name: app.identity.name,
    nodeId: app.identity.nodeId,
    status: app.status,
    port: boundPort ?? PORT,
    mock,
    storage: storage ?? "plain",
  })
  out({
    event: "hint",
    text: mock
      ? "mock mode: messages go to the scripted echo peer"
      : `listening on port ${boundPort ?? PORT} - from another node run: /connect localhost:${boundPort ?? PORT}, or type here after someone connects in`,
  })

  const unsubscribe: Unsubscribe = app.emit((event) => {
    switch (event.type) {
      case "peerChanged":
        out({ event: "peer", peer: event.peer })
        break
      case "message":
        out({
          event: "message",
          direction: event.message.direction,
          content: event.message.content,
          sentAt: event.message.sentAt,
          state: event.message.state,
        })
        break
      case "nodeStatus":
        out({ event: "status", status: event.status })
        break
      case "retentionChanged":
        out({
          event: "retention",
          peerId: event.peerId,
          mine: event.mine,
          theirs: event.state.theirs ?? null,
          pendingIn: event.state.pendingIn ?? null,
          pendingOut: event.state.pendingOut ?? null,
          lastAction: event.state.lastAction ?? null,
        })
        break
      case "notice":
        out({ event: "notice", scope: event.scope, message: event.message })
        break
      case "roomChanged": {
        const r = event.room
        out({
          event: "room",
          roomId: r.roomId,
          name: r.name,
          hostPeerId: r.hostPeerId,
          members: r.members.map((m) => `${m.name}${m.role === "host" ? "*" : ""}`),
          voice: `${r.voice.participants.length} in channel${r.voice.selfMuted ? " (muted)" : ""}`,
          lastMessages: r.messages.slice(-3).map((m) => `${m.fromName}: ${m.content}`),
        })
        break
      }
      case "roomClosed":
        out({ event: "room-closed", roomId: event.roomId, reason: event.reason })
        break
      case "roomInvitation":
        out({
          event: "invitation",
          roomId: event.invitation.roomId,
          roomName: event.invitation.roomName,
          from: event.invitation.hostName,
          hint: "/join " + event.invitation.roomId,
        })
        break
      case "voiceChanged":
        out({
          event: "voice",
          roomId: event.voice.roomId,
          state: event.voice.state,
          participants: event.voice.participants.map(
            (p) => `${p.name}${p.muted ? "(muted)" : p.speaking ? "(speaking)" : ""}`,
          ),
        })
        break
      case "discoveredSeen":
        out({
          event: "discovered",
          peerId: event.peer.peerId,
          name: event.peer.name,
          address: event.peer.address,
          source: event.peer.source,
          via: event.peer.viaName ?? null,
        })
        break
      case "discoveredLost":
        out({ event: "discovered-lost", peerId: event.peerId })
        break
      case "rendezvousChanged":
        // CONNECTED and CONNECTABLE are reported separately on purpose (V3 §7);
        // collapsing them into one "online" would be inventing presence.
        out({
          event: "rendezvous",
          enabled: event.state.enabled,
          connected: event.state.connected,
          connectable: event.state.connectable,
          handle: event.state.handle,
          expiresAt: event.state.expiresAt,
        })
        break
      case "introductionRequested":
        out({
          event: "introduction-request",
          requestId: event.request.requestId,
          fromHandle: event.request.fromHandle,
          fromNodeId: event.request.fromNodeId,
          expiresAt: event.request.expiresAt,
          hint: `/accept ${event.request.requestId} | /ignore ${event.request.requestId}`,
        })
        break
      case "introductionAnswered":
        out({ event: "introduction-answered", requestId: event.requestId, accept: event.accept })
        break
      case "error":
        out({ event: "error", scope: event.scope, message: event.message })
        break
      case "identityLoaded":
        break
    }
  })

  const peers = await app.listPeers()
  selectedPeerId = peers.find((p) => p.status === "connected")?.peerId ?? peers[0]?.peerId ?? null
  /** Room whose voice channel we're in; plain text goes to the ROOM when set. */
  let selectedRoomId: string | null = null

  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      void handleLine(line)
    }
  })

  async function handleLine(line: string): Promise<void> {
    if (line === "/quit" || line === "/exit") {
      await shutdown()
      return
    }
    if (line.startsWith("/connect ")) {
      const address = line.slice("/connect ".length).trim()
      try {
        const peer = await app.connectTo(address)
        selectedPeerId = peer.peerId
        out({ event: "connected", peerId: peer.peerId, name: peer.name, address })
      } catch (err) {
        out({ event: "error", scope: "transport", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line === "/net") {
      // What the connection path actually did. A NAT failure and an
      // application bug look the same from outside — the peer just never
      // connects — so this reports the parts that can be observed.
      if (!net) {
        out({ event: "net", available: false, reason: "this build has no UDP transport wired" })
        return
      }
      const peers = await app.listPeers()
      out({
        event: "net",
        available: true,
        udpPort: net.udpPort,
        publicCandidate: net.publicCandidate ? `${net.publicCandidate.host}:${net.publicCandidate.port}` : null,
        nat: net.natDetail,
        peers: peers.map((p) => ({ peerId: p.peerId, name: p.name, status: p.status, transport: net.routeOf(p.peerId) })),
      })
      return
    }
    if (line === "/stun") {
      if (!net) {
        out({ event: "stun", available: false })
        return
      }
      const report = await net.measure()
      out({
        event: "stun",
        available: true,
        udpPort: net.udpPort,
        address: report.address ? `${report.address.host}:${report.address.port}` : null,
        detail: report.detail,
      })
      return
    }
    if (line.startsWith("/peers")) {
      for (const peer of await app.listPeers()) {
        out({ event: "peer", peer })
      }
      return
    }
    if (line === "/disconnect") {
      if (!selectedPeerId) {
        out({ event: "error", scope: "transport", message: "no peer selected" })
        return
      }
      await app.disconnect(selectedPeerId)
      out({ event: "disconnected", peerId: selectedPeerId })
      return
    }
    if (line === "/ping") {
      if (!selectedPeerId) {
        out({ event: "error", scope: "messaging", message: "no peer selected; use /connect host:port" })
        return
      }
      const rttMs = await app.pingPeer(selectedPeerId)
      out({ event: "latency", peerId: selectedPeerId, rttMs })
      return
    }
    if (line.startsWith("/trust ")) {
      const arg = line.slice("/trust ".length).trim()
      if (!selectedPeerId || (arg !== "on" && arg !== "off")) {
        out({ event: "error", scope: "messaging", message: "usage: /trust on|off" })
        return
      }
      await app.setVerified(selectedPeerId, arg === "on")
      out({ event: "verified", peerId: selectedPeerId, verified: arg === "on" })
      return
    }
    if (line.startsWith("/verify ")) {
      const arg = line.slice("/verify ".length).trim()
      if (!selectedPeerId || (arg !== "yes" && arg !== "no")) {
        out({ event: "error", scope: "messaging", message: "usage: /verify yes|no" })
        return
      }
      await app.setVerified(selectedPeerId, arg === "yes")
      out({ event: "verified", peerId: selectedPeerId, verified: arg === "yes" })
      return
    }
    if (line.startsWith("/rename ")) {
      const newName = line.slice("/rename ".length).trim()
      if (!selectedPeerId) {
        out({ event: "error", scope: "messaging", message: "no peer selected; use /connect host:port" })
        return
      }
      const peerBefore = (await app.listPeers()).find((p) => p.peerId === selectedPeerId)
      await app.renameContact(selectedPeerId, newName)
      const applied = (await app.listPeers()).find((p) => p.peerId === selectedPeerId)
      out({ event: "renamed", peerId: selectedPeerId, from: peerBefore?.name, to: applied?.displayName ?? applied?.name })
      return
    }
    if (line.startsWith("/retention ")) {
      const arg = line.slice("/retention ".length).trim()
      if (arg !== "24h" && arg !== "7d" && arg !== "forever") {
        out({ event: "error", scope: "messaging", message: "usage: /retention 24h|7d|forever" })
        return
      }
      await app.setRetention(arg)
      out({ event: "retention-set", policy: arg })
      return
    }
    if (line.startsWith("/answer ")) {
      const arg = line.slice("/answer ".length).trim()
      if (!selectedPeerId || (arg !== "yes" && arg !== "no")) {
        out({ event: "error", scope: "messaging", message: "usage: /answer yes|no (pending retention proposal)" })
        return
      }
      await app.respondRetentionProposal(selectedPeerId, arg === "yes")
      out({ event: "answered", peerId: selectedPeerId, accept: arg === "yes" })
      return
    }
    // ---------- rooms & voice ----------
    if (line.startsWith("/room ")) {
      const arg = line.slice("/room ".length).trim()
      const [roomName = "", inviteList = ""] = arg.split(":").map((part) => part.trim())
      if (!roomName) {
        out({ event: "error", scope: "messaging", message: 'usage: /room <name>[:peerName,peerName] — e.g. /room lounge:roshan' })
        return
      }
      const all = await app.listPeers()
      const ids: string[] = []
      for (const token of inviteList.split(",").map((t) => t.trim()).filter(Boolean)) {
        const peer = all.find((p) => p.peerId === token || p.name === token || p.displayName === token)
        if (!peer) {
          out({ event: "error", scope: "rooms", message: `unknown peer "${token}" — see /peers` })
          return
        }
        ids.push(peer.peerId)
      }
      try {
        const room = await app.createRoom(roomName, ids)
        out({ event: "room-hosted", roomId: room.roomId, name: room.name, invited: ids.length })
      } catch (err) {
        out({ event: "error", scope: "rooms", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line.startsWith("/join")) {
      const arg = line.slice("/join".length).trim()
      const invitation = app.listInvitations().find((i) => i.roomId === arg || i.roomName === arg)
      if (!invitation) {
        out({ event: "error", scope: "rooms", message: "no such invitation (see /invites)" })
        return
      }
      try {
        const room = await app.joinRoom(invitation.roomId)
        selectedRoomId = room.roomId
        out({ event: "joined", roomId: room.roomId, name: room.name })
      } catch (err) {
        out({ event: "error", scope: "rooms", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line === "/rooms") {
      const rooms = app.listRooms()
      if (rooms.length === 0) out({ event: "rooms", text: "none — host one with /room <name>" })
      for (const room of app.listRooms()) {
        out({
          event: "room",
          roomId: room.roomId,
          name: room.name,
          members: room.members.map((m) => `${m.name}${m.role === "host" ? "*" : ""}`),
          voice: room.voice.participants.map((p) => p.name),
        })
      }
      return
    }
    if (line === "/invites") {
      const invites = app.listInvitations()
      if (invites.length === 0) out({ event: "invitations", text: "none pending" })
      for (const invitation of invites) {
        out({ event: "invitation", roomId: invitation.roomId, roomName: invitation.roomName, from: invitation.hostName })
      }
      return
    }
    // ---------- discovery ----------
    if (line.startsWith("/invite")) {
      const arg = line.slice("/invite".length).trim()
      // "/invite"          -> print MY nex:// code to share
      // "/invite nex://…"  -> redeem a code someone sent
      if (arg.startsWith("nex://")) {
        try {
          const peer = await app.redeemInvite(arg)
          selectedPeerId = peer.peerId
          out({ event: "redeemed", peerId: peer.peerId, name: peer.displayName ?? peer.name })
        } catch (err) {
          out({ event: "error", scope: "transport", message: String(err instanceof Error ? err.message : err) })
        }
      } else {
        const host = arg || undefined
        const code = await app.createInvite(host)
        out({
          event: "your-invite",
          code,
          hint: "send this line to a friend; they run /invite <code>",
        })
      }
      return
    }
    // ---------- v3 rendezvous ----------
    if (line === "/rendezvous" || line.startsWith("/rendezvous ")) {
      const arg = line.slice("/rendezvous".length).trim()
      if (!arg) {
        const state = app.getRendezvousState()
        out({
          event: "rendezvous",
          enabled: state.enabled,
          connected: state.connected,
          connectable: state.connectable,
          handle: state.handle,
          expiresAt: state.expiresAt,
        })
        return
      }
      const [verb, ...rest] = arg.split(/\s+/)
      try {
        if (verb === "off") {
          await app.setRendezvous(false)
          out({ event: "rendezvous-set", enabled: false })
        } else if (verb === "on") {
          const [url, handle] = rest
          await app.setRendezvous(true, { baseUrl: url, handle })
          out({ event: "rendezvous-set", enabled: true, baseUrl: url ?? null, handle: handle ?? null })
        } else {
          out({ event: "error", scope: "rendezvous", message: "usage: /rendezvous [on <url> <handle> | off]" })
        }
      } catch (err) {
        out({ event: "error", scope: "rendezvous", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line.startsWith("/find ")) {
      const handle = line.slice("/find ".length).trim()
      try {
        const found = await app.searchHandle(handle)
        if (!found) {
          // A miss and a hit are indistinguishable at the wire level by design;
          // say "not connectable", never "no such user".
          out({ event: "find", handle, found: false, text: `${handle} is not currently connectable` })
          return
        }
        out({
          event: "find",
          found: true,
          handle: found.handle,
          nodeId: found.nodeId,
          connectable: found.connectable,
          capabilities: found.capabilities,
          // No address: search never carries one, and will not until they accept.
          hint: `/ask ${found.handle}`,
        })
      } catch (err) {
        out({ event: "error", scope: "rendezvous", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line.startsWith("/ask ")) {
      const handle = line.slice("/ask ".length).trim()
      try {
        const res = await app.requestIntroduction(handle)
        out({ event: "introduction-sent", handle, requestId: res.requestId, expiresAt: res.expiresAt })
      } catch (err) {
        out({ event: "error", scope: "rendezvous", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line === "/requests") {
      const pending = app.listIntroductionRequests()
      if (pending.length === 0) out({ event: "requests", text: "no one is looking for you" })
      for (const r of pending) {
        out({
          event: "requests",
          requestId: r.requestId,
          fromHandle: r.fromHandle,
          fromNodeId: r.fromNodeId,
          expiresAt: r.expiresAt,
        })
      }
      return
    }
    if (line.startsWith("/accept ") || line.startsWith("/ignore ")) {
      const accept = line.startsWith("/accept ")
      const requestId = line.slice(8).trim()
      try {
        await app.respondIntroduction(requestId, accept)
        out({ event: "introduction-answered", requestId, accept })
      } catch (err) {
        out({ event: "error", scope: "rendezvous", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line === "/nearby") {
      const found = app.listDiscovered()
      if (found.length === 0) out({ event: "nearby", text: "no one discovered yet" })
      for (const d of found) {
        out({
          event: "nearby",
          name: d.name,
          address: d.address,
          source: d.source,
          via: d.viaName ?? null,
          hint: `/connect ${d.address}`,
        })
      }
      return
    }
    if (line.startsWith("/vouch ")) {
      // /vouch <toName> <otherName>: tell `to` about `other`
      const [toToken = "", otherToken = ""] = line.slice("/vouch ".length).trim().split(/\s+/)
      if (!toToken || !otherToken) {
        out({ event: "error", scope: "rooms", message: "usage: /vouch <connectedPeer> <otherPeer>" })
        return
      }
      const all = await app.listPeers()
      const find = (token: string) =>
        all.find((p) => p.peerId === token || p.name === token || p.displayName === token)
      const to = find(toToken)
      const other = find(otherToken)
      if (!to || !other) {
        out({ event: "error", scope: "rooms", message: "unknown peer name(s); see /peers" })
        return
      }
      try {
        await app.introduceTo(to.peerId, other.peerId)
        out({ event: "vouched", to: to.name, about: other.displayName ?? other.name })
      } catch (err) {
        out({ event: "error", scope: "rooms", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line.startsWith("/say ")) {
      const roomsNow = app.listRooms()
      const target =
        roomsNow.find((r) => r.roomId === selectedRoomId) ?? roomsNow[roomsNow.length - 1]
      if (!target) {
        out({ event: "error", scope: "rooms", message: "no room to talk in (/room or /join first)" })
        return
      }
      selectedRoomId = target.roomId
      await app.sendRoomMessage(target.roomId, line.slice("/say ".length).trim())
      return
    }
    if (line.startsWith("/leave ")) {
      const arg = line.slice("/leave ".length).trim()
      const target = app.listRooms().find((r) => r.roomId === arg || r.name === arg)
      if (!target) {
        out({ event: "error", scope: "rooms", message: "usage: /leave <roomId|name>" })
        return
      }
      await app.leaveRoom(target.roomId)
      if (selectedRoomId === target.roomId) selectedRoomId = null
      out({ event: "left", roomId: target.roomId, name: target.name })
      return
    }
    if (line.startsWith("/close ")) {
      const arg = line.slice("/close ".length).trim()
      const target = app.listRooms().find((r) => r.roomId === arg || r.name === arg)
      if (!target) {
        out({ event: "error", scope: "rooms", message: "usage: /close <roomId|name> (host only)" })
        return
      }
      try {
        await app.closeRoom(target.roomId)
        if (selectedRoomId === target.roomId) selectedRoomId = null
        out({ event: "closed", roomId: target.roomId, name: target.name })
      } catch (err) {
        out({ event: "error", scope: "rooms", message: String(err instanceof Error ? err.message : err) })
      }
      return
    }
    if (line.startsWith("/voice ")) {
      const arg = line.slice("/voice ".length).trim()
      const roomsNow = app.listRooms()
      const target =
        roomsNow.find((r) => r.roomId === selectedRoomId) ??
        (arg === "off" ? null : roomsNow[roomsNow.length - 1])
      if (!target || (arg !== "on" && arg !== "off")) {
        out({ event: "error", scope: "rooms", message: "join a room first (/room or /join), then: /voice on|off" })
        return
      }
      await app.setVoiceActive(target.roomId, arg === "on")
      selectedRoomId = target.roomId
      out({ event: "voice-toggled", roomId: target.roomId, name: target.name, active: arg === "on" })
      return
    }
    if (line.startsWith("/mute ")) {
      const arg = line.slice("/mute ".length).trim()
      if (!selectedRoomId || (arg !== "on" && arg !== "off")) {
        out({ event: "error", scope: "rooms", message: "in voice first, then: /mute on|off" })
        return
      }
      await app.setVoiceMuted(selectedRoomId, arg === "on")
      out({ event: "mute-toggled", roomId: selectedRoomId, muted: arg === "on" })
      return
    }
    // Plain text routes to the ROOM while THIS node sits in its voice channel
    // (Discord-like presence semantics); otherwise to the selected peer.
    const voicedRoom = app
      .listRooms()
      .find((r) => r.voice.participants.some((p) => p.peerId === app.identity.nodeId))
    if (voicedRoom) {
      if (line.startsWith("/")) {
        out({ event: "error", scope: "messaging", message: `unknown command ${line.split(" ")[0]}` })
        return
      }
      await app.sendRoomMessage(voicedRoom.roomId, line)
      return
    }
    // plain text -> message to the selected (or first connected) peer
    if (!selectedPeerId) {
      const peers = await app.listPeers()
      selectedPeerId = peers.find((p) => p.status === "connected")?.peerId ?? null
    }
    if (!selectedPeerId) {
      out({ event: "error", scope: "messaging", message: "no peer selected; use /connect host:port" })
      return
    }
    try {
      await app.sendMessage(selectedPeerId, line)
    } catch (err) {
      out({ event: "error", scope: "messaging", message: String(err instanceof Error ? err.message : err) })
    }
  }

  let shuttingDown = false
  async function shutdown(): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    unsubscribe()
    await app.shutdown().catch(() => {})
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  process.stdin.on("end", () => void shutdown())
}

// Repo-dev entry: `bun run src/main/headless.ts` still behaves as before.
const isDirectRun =
  typeof Bun !== "undefined" &&
  Array.isArray(Bun.argv) &&
  Bun.argv[1] !== undefined &&
  /headless\.tsx?$/.test(Bun.argv[1].replace(/\\/g, "/"))
if (isDirectRun || (typeof process !== "undefined" && process.env["NEX_HEADLESS_MAIN"] === "1")) {
  const cliArgs = typeof process !== "undefined" ? process.argv.slice(2) : []
  main(cliArgs).catch((err) => {
    console.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
