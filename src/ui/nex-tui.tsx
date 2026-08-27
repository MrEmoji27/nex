// OpenTUI React interface: home screen + social shell.
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  IntroductionRequestView,
  NexApp,
  PeerInfo,
  RetentionPolicy,
  RoomInvitation,
  RoomView,
} from "../core/contract.ts"
import type { NetDiagnostics } from "../main/node-app"
import { Header } from "./header"
import { PeoplePane } from "./people-pane"
import { ChatPane } from "./chat-pane"
import { ContextStrip } from "./context-strip"
import { InputLine, Footer } from "./input-line"
import { AddPeerModal } from "./add-peer-modal"
import type { ConnectStage } from "./add-peer-modal"
import { VerifyModal } from "./verify-modal"
import { HomeScreen } from "./home-screen"
import { SettingsModal, RETENTION_ORDER, nextIn } from "./settings-modal"
import { ChangelogModal } from "./changelog-modal"
import { CommandPanel, panelLines, type LogLine } from "./command-panel"
import { runCommand } from "./run-command"
import { VoiceStrip } from "./voice-strip"
import { MotionScope, animsEnabled } from "./use-tick"
import { setActiveTheme, THEMES, getTheme, colors } from "./theme"
import { APP_VERSION } from "../version"
import { useConversation, useNex } from "./use-nex"

type Focus = "people" | "input"
type Screen = "home" | "app"
type Modal =
  | null
  | { kind: "add-peer" }
  | { kind: "verify"; peerId: string }
  | { kind: "settings" }

export function NexTui(props: { app: NexApp; net?: NetDiagnostics }) {
  const { app, net } = props
  const ui = useNex(app)
  const { identity, status, peers, recentConversations, lastError, settings } = ui
  const { width, height } = useTerminalDimensions()

  const [screen, setScreen] = useState<Screen>("home")
  const [focus, setFocus] = useState<Focus>("input")
  const [modal, setModal] = useState<Modal>(null)
  const [connectBusy, setConnectBusy] = useState(false)
  // Real dial progress for the union scene: the bus reports `authenticating`
  // when the noise handshake starts; anything before that is "dialing".
  const [connectStage, setConnectStage] = useState<ConnectStage>("dialing")
  // Peers already known when the current dial started. An `authenticating`
  // event from one of THEM is a background re-handshake of some other link,
  // not progress of the node being dialed — claiming it would be dishonest.
  const dialKnownIdsRef = useRef<Set<string> | null>(null)
  const [linkedName, setLinkedName] = useState<string | null>(null)
  const [connectError, setConnectError] = useState<string | null>(null)
  /** Transient user-facing notice (bad command, etc.), shown in red on the footer. */
  const [notice, setNotice] = useState<string | null>(null)
  /** What is being typed, so the panel above the input can preview commands. */
  const [draft, setDraft] = useState("")
  /**
   * What commands actually said, kept on screen.
   *
   * The footer was the wrong home for this: one truncated line for four
   * seconds, which reads as nothing happening at all.
   */
  const [commandLog, setCommandLog] = useState<LogLine[]>([])
  // Registered by InputLine so panes can hand a typed character to the field.
  const forwardCharRef = useRef<((ch: string) => void) | null>(null)
  const noticeTimerRef = useRef<Timer | undefined>(undefined)

  /** Command output. Stays until pushed off by newer lines. */
  const log = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    setCommandLog((prev) => [...prev, { text, tone, at: Date.now() }].slice(-24))
  }, [])

  const flashNotice = useCallback((message: string, ms = 4_000) => {
    setNotice(message)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => setNotice(null), ms)
  }, [])

  // ---------- rooms & voice surfaces ----------
  // Mirrors of the app-level room state, driven by the event bus (same pattern
  // as retention). Kept here so use-nex stays conversation-focused.
  const [rooms, setRooms] = useState<RoomView[]>([])
  const [invitations, setInvitations] = useState<RoomInvitation[]>([])
  // Neighbors heard via LAN beacon / intro (alpha.7) — polled lightly because
  // they arrive as events but also expire silently.
  const [discovered, setDiscovered] = useState(() => app.listDiscovered())
  /** Introductions waiting on a human. Someone has to be able to /accept them. */
  const [introductions, setIntroductions] = useState<IntroductionRequestView[]>([])
  useEffect(() => {
    setRooms(app.listRooms())
    setInvitations(app.listInvitations())
    return app.emit((event) => {
      if (event.type === "roomChanged") {        setRooms((prev) => {
          const next = prev.filter((r) => r.roomId !== event.room.roomId)
          next.push(event.room)
          return next
        })
      } else if (event.type === "roomClosed") {
        setRooms((prev) => prev.filter((r) => r.roomId !== event.roomId))
      } else if (event.type === "roomInvitation") {
        setInvitations((prev) => [...prev.filter((i) => i.roomId !== event.invitation.roomId), event.invitation])
        flashNotice(`${event.invitation.hostName} invites you to "${event.invitation.roomName}" — /join`)
      } else if (event.type === "voiceChanged") {
        setRooms((prev) =>
          prev.map((r) => (r.roomId === event.voice.roomId ? { ...r, voice: event.voice } : r)),
        )
      } else if (event.type === "discoveredSeen") {
        setDiscovered(app.listDiscovered())
        if (event.peer.source === "lan") {
          flashNotice(`${event.peer.name} appeared nearby — see PEOPLE ◦ NEARBY`)
        } else {
          flashNotice(`${event.peer.viaName ?? "a friend"} introduced ${event.peer.name}`)
        }
      } else if (event.type === "discoveredLost") {
        setDiscovered(app.listDiscovered())
      } else if (event.type === "introductionRequested") {
        setIntroductions(app.listIntroductionRequests())
        // Held on screen longer than a status blip: this one has to be read and
        // answered, and the id is the argument.
        flashNotice(
          `${event.request.fromHandle} is looking for you — /accept ${event.request.requestId.slice(0, 8)}`,
          20_000,
        )
      } else if (event.type === "introductionAnswered") {
        setIntroductions(app.listIntroductionRequests())
      } else if (event.type === "rendezvousChanged") {
        const { connected, connectable, handle } = event.state
        if (connectable && handle) flashNotice(`rendezvous: published as "${handle}"`)
        else if (connected) flashNotice("rendezvous: connected, nothing published yet")
      } else if (
        event.type === "peerChanged" &&
        event.peer.status === "authenticating" &&
        !dialKnownIdsRef.current?.has(event.peer.peerId)
      ) {
        // Feeds the union scene's honest staging while a dial is in flight —
        // but only for a peer the dial could have produced (see ref above).
        setConnectStage("authenticating")
      }
    })
  }, [app, flashNotice])

  // Theme follows persisted settings (vision §15); proxy re-colors on re-render.
  useEffect(() => {
    setActiveTheme(settings.theme)
  }, [settings.theme])

  const whatsNew =
    settings.lastSeenVersion === APP_VERSION
      ? null
      : `NEW IN ${APP_VERSION} — home · themes · message retention`

  const selectedPeerId = ui.selectedPeerId
  const selectedPeer = useMemo(
    () => peers.find((p) => p.peerId === selectedPeerId) ?? null,
    [peers, selectedPeerId],
  )
  const messages = useConversation(ui, selectedPeerId)
  const linkSecurity = useMemo(() => app.getLinkSecurity(), [app])
  const storageSecurity = useMemo(() => app.getStorageSecurity(), [app])
  const peersById = useMemo(() => {
    const map = new Map<string, PeerInfo>()
    for (const peer of peers) map.set(peer.peerId, peer)
    return map
  }, [peers])

  // Two-pane shell everywhere: PEOPLE | CHAT. Narrow terminals swap the chat
  // column in place of people while typing (single visible pane <64 cols).
  const layout = useMemo(() => {
    if (width >= 64) {
      return {
        mode: "two-pane" as const,
        peopleWidth: Math.max(22, Math.min(30, Math.floor(width * 0.26))),
      }
    }
    return { mode: "narrow" as const, peopleWidth: 0 }
  }, [width])
  const narrow = layout.mode === "narrow"

  // Short terminals collapse the context strip first; previews follow suit.
  const showContextStrip = height >= 20
  const showPreviews = height >= 20

  // Auto-select the first peer so chat is never empty on boot; keep selection valid.
  useEffect(() => {
    if (!selectedPeerId && peers.length > 0) {
      ui.selectPeer(peers[0]!.peerId)
    } else if (selectedPeerId && !peers.some((p) => p.peerId === selectedPeerId)) {
      ui.selectPeer(peers[0]?.peerId ?? null)
    }
  }, [peers, selectedPeerId, ui])

  // Periodic latency probe of the selected peer while it is connected.
  const selectedId = selectedPeer?.peerId ?? null
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    const probe = async () => {
      try {
        await app.pingPeer(selectedId)
      } catch {
        // failures surface through the bus; keep probing silently
      }
    }
    void probe()
    const timer = setInterval(() => {
      if (alive) void probe()
    }, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [app, selectedId])

  // Empty-selection strip segment: NEX_PORT when provided (dev harness);
  // the contract exposes no port accessor, so omit the segment otherwise.
  const listeningAddress = useMemo(
    () => (process.env.NEX_PORT ? `127.0.0.1:${process.env.NEX_PORT}` : null),
    [],
  )

  // Sitting in an open conversation counts as reading it: inbound messages for
  // the selected peer clear their own badge (screen app, nothing modal).
  useEffect(() => {
    if (screen !== "app" || !selectedId) return
    if ((ui.unreadByPeer.get(selectedId) ?? 0) > 0) {
      void app.markConversationRead(selectedId).catch(() => {})
    }
  }, [app, screen, selectedId, ui.unreadByPeer])

  const openChatWith = useCallback(
    (peerId: string) => {
      ui.selectPeer(peerId)
      setModal(null)
      setScreen("app")
      setFocus("input")
      void app.markConversationRead(peerId).catch(() => {})
    },
    [app, ui],
  )

  const continueToApp = useCallback(() => {
    if (settings.lastSeenVersion !== APP_VERSION) {
      void app.markVersionSeen(APP_VERSION).catch(() => {})
    }
    setModal(null)
    setScreen("app")
    setFocus("input")
  }, [app, settings.lastSeenVersion])

  const cycleTheme = useCallback(
    (dir: 1 | -1) => {
      const next = nextIn(THEMES.map((t) => t.id), getTheme(settings.theme).id, dir, 0)
      cycleThemeById(next)
    },
    [settings.theme],
  )

  const cycleThemeById = useCallback(
    (id: string) => {
      setActiveTheme(id)
      void app.setTheme(id).catch(() => {})
    },
    [app],
  )

  const cycleRetention = useCallback(
    (dir: 1 | -1) => {
      const next = nextIn(RETENTION_ORDER, settings.retention ?? "forever", dir, 2)
      void app.setRetention(next as RetentionPolicy).catch(() => {})
    },
    [app, settings.retention],
  )

  const send = useCallback(
    async (content: string) => {
      if (!selectedPeerId) return
      try {
        await app.sendMessage(selectedPeerId, content)
      } catch {
        // failures already surface through the bus; keep the UI alive
      }
    },
    [app, selectedPeerId],
  )

  const connectTo = useCallback(
    async (address: string) => {
      setConnectBusy(true)
      setConnectError(null)
      // Remember which peers are already known so that subsequent
      // `peerChanged` `authenticating` events for other links don't
      // falsely advance the dial's connect stage (dream vision §17 —
      // honest staging of the dialed node only).
      dialKnownIdsRef.current = new Set(
        peers.map((p) => p.peerId).filter(Boolean)
      )
      setConnectStage("dialing")
      try {
        const peer = await app.connectTo(address)
        // Union-formed beat: let the success state register before the modal
        // dissolves (dream vision §17 — transitions should be readable).
        // T5 correction: this went through the consolidated motion switch —
        // an earlier fix only added the import, the call sites kept raw env
        // checks that missed NO_MOTION=1.
        if (animsEnabled()) {
          setLinkedName(peer.displayName ?? peer.name)
          await Bun.sleep(800)
          setLinkedName(null)
        }
        openChatWith(peer.peerId)
        return true
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setConnectBusy(false)
      }
    },
    [app, openChatWith],
  )

  const decideVerification = useCallback(
    (peerId: string, verified: boolean) => {
      void app.setVerified(peerId, verified).finally(() => {
        setModal(null)
        setFocus("input")
      })
    },
    [app],
  )

  const verifyTarget =
    modal?.kind === "verify" ? peers.find((p) => p.peerId === modal.peerId) ?? null : null

  // ---------- voice actions ----------
  // One active room surface for now (multi-room switching is a later step):
  // the most recently changed room, which is also what /rooms reports first.
  const activeRoom = rooms.length > 0 ? rooms[rooms.length - 1]! : null
  const selfId = identity.nodeId
  const selfInVoice = activeRoom?.voice.participants.some((p) => p.peerId === selfId) ?? false

  const toggleVoice = useCallback(() => {
    if (!activeRoom) {
      flashNotice("no rooms — host one with /room <name>")
      return
    }
    const joining = !activeRoom.voice.participants.some((p) => p.peerId === selfId)
    void app
      .setVoiceActive(activeRoom.roomId, joining)
      .then(() => flashNotice(joining ? "joined the voice channel" : "left the voice channel"))
      .catch((err: Error) => flashNotice(`voice: ${err.message}`))
  }, [app, activeRoom, flashNotice, selfId])

  const toggleMute = useCallback(() => {
    if (!activeRoom || !selfInVoice) {
      flashNotice("not in a voice channel — press c or /voice")
      return
    }
    const muted = !activeRoom.voice.selfMuted
    void app
      .setVoiceMuted(activeRoom.roomId, muted)
      .then(() => flashNotice(muted ? "muted" : "unmuted"))
      .catch((err: Error) => flashNotice(`mute: ${err.message}`))
  }, [app, activeRoom, flashNotice, selfId, selfInVoice])

  // Commands remain for power users; plain text always sends.
  const handleSubmit = useCallback(
    (value: string) => {
      if (value.startsWith("/")) {
        // Dispatch lives in run-command.ts so it can be tested without a
        // terminal, and so every result reports through one place.
        void runCommand(value, {
          app,
          net,
          selectedPeerId,
          peers,
          rooms,
          invitations,
          activeRoom: activeRoom ?? null,
          // Whatever this node used last wins over the built-in default, so
          // someone running their own service types the URL once.
          rendezvousUrl: settings.rendezvous?.baseUrl,
          log,
          openModal: (kind) => {
            if (kind === "verify" && selectedPeerId) setModal({ kind: "verify", peerId: selectedPeerId })
            else if (kind === "settings") setModal({ kind: "settings" })
            else if (kind === "add-peer") setModal({ kind: "add-peer" })
          },
          connectTo: (address) => void connectTo(address),
          applyTheme: (needle) => {
            const lower = needle.toLowerCase()
            const match =
              THEMES.find((t) => t.id === lower || t.name.toLowerCase().startsWith(lower)) ??
              THEMES.find((t) => t.name.toLowerCase().includes(lower))
            if (match) cycleThemeById(match.id)
            return Boolean(match)
          },
          toggleVoice,
          toggleMute,
        })
        return
      }

      // Room chat follows voice presence: while you're IN the room's voice
      // channel, plain text talks to the room (you're "in" it, Discord-like);
      // otherwise plain text keeps going to the selected peer. /say is always
      // available for explicit room messaging.
      if (activeRoom && selfInVoice) {
        void app
          .sendRoomMessage(activeRoom.roomId, value)
          .catch((err: Error) => flashNotice(`room: ${err.message}`))
        return
      }
      if (!selectedPeerId) {
        // Previously this returned quietly, which looked exactly like a broken
        // Enter key. Same lesson as unknown commands: say something.
        flashNotice("no one selected — /find someone, or press a to add them")
        return
      }
      void send(value)
    },
    [
      activeRoom,
      app,
      settings.rendezvous?.baseUrl,
      connectTo,
      cycleThemeById,
      flashNotice,
      invitations,
      log,
      net,
      peers,
      rooms,
      selectedPeerId,
      selfInVoice,
      send,
      toggleMute,
      toggleVoice,
    ],
  )

  const lastSentRef = useRef<string | undefined>(undefined)
  const handleRecall = useCallback(() => lastSentRef.current, [])
  const handleSubmitWithRecall = useCallback(
    (value: string) => {
      lastSentRef.current = value
      handleSubmit(value)
    },
    [handleSubmit],
  )

  // Message-first: printable typing while a pane holds focus jumps to the input,
  // carrying the typed character along so none of it is lost.
  const jumpToInput = useCallback((sequence: string | undefined) => {
    if (!sequence || sequence.length !== 1 || sequence.charCodeAt(0) < 32) return
    setFocus("input")
    forwardCharRef.current?.(sequence)
  }, [])

  // Focus order skips conversations outside the wide layout.
  const focusOrder: Focus[] = ["people", "input"]

  const quittingRef = useRef(false)
  useKeyboard((key) => {
    if (key.eventType !== "press") return

    // Guarded Ctrl+C shutdown (unchanged v0.x pattern).
    if (key.ctrl && key.name === "c") {
      if (quittingRef.current) return
      quittingRef.current = true
      void (async () => {
        try {
          await app.shutdown()
        } finally {
          process.exit(0)
        }
      })()
      return
    }

    // Modal scope swallows everything except its own keys.
    if (modal) {
      if (key.name === "escape") {
        setModal(null)
        setFocus("input")
      } else if (modal.kind === "settings") {
        if (key.name === "left") cycleTheme(-1)
        else if (key.name === "right") cycleTheme(1)
        else if (key.name === "up") cycleRetention(1)
        else if (key.name === "down") cycleRetention(-1)
      } else if (modal.kind === "verify" && verifyTarget) {
        if (key.name === "c") decideVerification(verifyTarget.peerId, true)
        else if (key.name === "d") decideVerification(verifyTarget.peerId, false)
      }
      return
    }

    // HOME screen: orientation first, continue into the social shell.
    if (screen === "home") {
      if (key.name === "return") continueToApp()
      else if (key.name === "a") setModal({ kind: "add-peer" })
      else if (key.name === "s") setModal({ kind: "settings" })
      return
    }

    if (key.name === "tab") {
      const idx = focusOrder.indexOf(focus)
      const direction = key.shift ? -1 : 1
      const next = (idx + direction + focusOrder.length) % focusOrder.length
      setFocus(focusOrder[next]!)
      return
    }

    // Back out to HOME from the shell, whatever pane holds focus.
    if (key.name === "escape") {
      setScreen("home")
      return
    }

    if (focus === "people") {
      if (key.name === "a") {
        setModal({ kind: "add-peer" })
      } else if (key.name === "v" && selectedPeerId) {
        setModal({ kind: "verify", peerId: selectedPeerId })
      } else if (key.name === "down" || key.name === "j") {
        moveSelection(peers.map((p) => p.peerId), selectedPeerId, 1, ui.selectPeer)
      } else if (key.name === "up" || key.name === "k") {
        moveSelection(peers.map((p) => p.peerId), selectedPeerId, -1, ui.selectPeer)
      } else if (key.name === "return") {
        // Enter opens the person's chat (in narrow mode this swaps the column).
        setFocus("input")
      } else if (key.name === "c") {
        // Voice channel toggles live on pane focus so typing "c"/"m" in the
        // input is never intercepted; input users have /voice and /mute.
        toggleVoice()
      } else if (key.name === "m") {
        toggleMute()
      } else {
        jumpToInput(key.sequence)
      }
      return
    }

    // Pending retention proposal: [a]/[r] answer it from any shell focus.
    const pendingProposal = selectedPeerId ? ui.retention.get(selectedPeerId)?.pendingIn : undefined
    if (pendingProposal && (key.name === "a" || key.name === "r")) {
      const accept = key.name === "a"
      void app
        .respondRetentionProposal(selectedPeerId!, accept)
        .then(() => flashNotice(accept ? "proposal accepted — shared window widened" : "proposal declined"))
        .catch((err: Error) => flashNotice(`retention: ${err.message}`))
      return
    }

    // input focus: typing lands in the field directly.
  })

  function moveSelection(
    ids: string[],
    currentId: string | null,
    delta: 1 | -1,
    select: (id: string | null) => void,
  ): void {
    if (ids.length === 0) return
    const idx = ids.indexOf(currentId ?? "")
    const next = idx < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, idx + delta))
    select(ids[next]!)
  }

  // Layout budget: 1 header + 3 input + 1 footer; context strip when shown.
  // The panel above the input is drawn from this, and its height comes OUT of
  // the panes. Letting it size itself pushed the input line off the bottom of
  // the terminal, so typing "/" hid the field being typed into.
  const panelBudget = Math.max(0, Math.min(7, height - 14))
  const panel = panelLines(draft, commandLog, width, panelBudget)
  const paneHeight = Math.max(4, height - (showContextStrip ? 6 : 5) - panel.length)

  const home = screen === "home"
  const hint = lastError
    ? `err/${lastError.scope}: ${lastError.message}`
    : status === "online"
      ? "online — direct links only, no server"
      : `node ${status}…`
  // whatsNew is NOT repeated here: on HOME it already appears verbatim in the
  // ACTIVITY list, in context and in full. Echoing it in the footer too meant
  // the same sentence twice on one screen — the copy truncated to fit the key
  // budget read as corrupted output jammed against the key hints.
  const footerHint = notice ?? hint
  const footerKeys = home
    ? "enter continue · a add peer · s settings"
    : "/help commands · tab chat · c voice · s settings"

  // Entrance choreography (dream vision §17): the shell settles in
  // left-to-right beats — people, chat. One-shot on mount; inert under the
  // consolidated motion switch (NEX_NO_ANIM / NEX_NO_MOTION / NO_MOTION).
  // T5 correction: an earlier fix claimed these were switched to animsEnabled()
  // but only the import ever landed; the raw env checks skipped NO_MOTION.
  const [revealStep, setRevealStep] = useState(() => (animsEnabled() ? 0 : 2))
  useEffect(() => {
    if (!animsEnabled()) return
    if (revealStep === 0) {
      const t = setTimeout(() => setRevealStep(1), 90)
      const t2 = setTimeout(() => setRevealStep(2), 180)
      return () => {
        clearTimeout(t)
        clearTimeout(t2)
      }
    }
  }, [revealStep])
  const reveal = (step: number): boolean => revealStep < step

  const chatPane = (
    <ChatPane
      peer={selectedPeer}
      messages={messages}
      height={paneHeight}
      width={narrow ? width : width - layout.peopleWidth}
      agreement={selectedPeerId ? (ui.retention.get(selectedPeerId) ?? null) : null}
      mineRetention={ui.settings.retention ?? "forever"}
      settle={reveal(2)}
    />
  )

  // Voice channel strip: Discord-style participant row under the chat panes.
  // Hidden entirely when no room exists; shows join state, mute, speaking rings.
  const voiceStrip =
    !home && activeRoom ? <VoiceStrip room={activeRoom} selfId={selfId} width={width} /> : null

  // Changelog modal state
  const [showChangelog, setShowChangelog] = useState(false)

  return (
    <box
      style={{ width, height, flexDirection: "column", backgroundColor: colors.background }}
    >
      {/* Modal coverage suspends every animation beneath it (perf + honesty:
          covered surfaces stop repainting instead of ticking unseen). */}
      <MotionScope suspended={modal !== null}>
        <Header identity={identity} status={status} width={width} />
        <box style={{ flexDirection: "row", height: 1, backgroundColor: colors.border }}>
          <text fg={colors.border}>{"─".repeat(width)}</text>
        </box>
      {home ? (
        <HomeScreen
          identity={identity}
          status={status}
          peers={peers}
          recentConversations={recentConversations}
          whatsNew={whatsNew}
          width={width}
          height={Math.max(4, height - 3)}
          onContinue={() => continueToApp()}
          onAddPeer={() => setModal({ kind: "add-peer" })}
          onVersionClick={() => setShowChangelog(true)}
        />
      ) : (
        <>
          <box style={{ flexDirection: "row", height: paneHeight, backgroundColor: colors.surface }}>
            {narrow && focus !== "people" ? (
              chatPane
            ) : (
              <>
                <PeoplePane
                  peers={peers}
                  selectedPeerId={selectedPeerId}
                  focused={focus === "people"}
                  width={narrow ? width : layout.peopleWidth}
                  height={paneHeight}
                  unreadByPeer={ui.unreadByPeer}
                  discovered={discovered}
                  settle={reveal(1)}
                  onAddPeer={() => setModal({ kind: "add-peer" })}
                  onSelect={(peerId) => openChatWith(peerId)}
                  onConnectDiscovered={(peerId) => {
                    void app.connectDiscovered(peerId).catch((err: Error) => flashNotice(`connect: ${err.message}`))
                  }}
                />
                {chatPane}
              </>
            )}
          </box>
          {showContextStrip ? (
            <ContextStrip
              peer={selectedPeer}
              linkSecurity={linkSecurity}
              listeningAddress={listeningAddress}
              width={width}
            />
          ) : null}
          {voiceStrip}
          <CommandPanel lines={panel} width={width} />
          <InputLine
            focused={focus === "input"}
            width={width}
            disabled={!selectedPeer}
            onSubmit={handleSubmitWithRecall}
            onRecallLast={handleRecall}
            onDraft={setDraft}
            registerForwardChar={(fn) => {
              forwardCharRef.current = fn
            }}
          />
        </>
      )}
      <Footer hint={footerHint} error={notice} keys={footerKeys} width={width} />
      </MotionScope>

      {modal?.kind === "add-peer" ? (
        <MotionScope suspended={false}>
          <AddPeerModal
            termWidth={width}
            termHeight={height}
            busy={connectBusy}
            stage={connectStage}
            error={connectError}
            linkedName={linkedName}
            onConnect={(address) => void connectTo(address)}
            onCancel={() => {
              setModal(null)
              setFocus("input")
            }}
          />
        </MotionScope>
      ) : null}
      {modal?.kind === "verify" && verifyTarget ? (
        <VerifyModal
          peer={verifyTarget}
          ownNodeId={identity.nodeId}
          termWidth={width}
          termHeight={height}
          onConfirm={(peerId) => decideVerification(peerId, true)}
          onDeny={(peerId) => decideVerification(peerId, false)}
          onCancel={() => {
            setModal(null)
            setFocus("input")
          }}
        />
      ) : null}
      {modal?.kind === "settings" ? (
        <SettingsModal
          settings={settings}
          storageSecurity={storageSecurity}
          termWidth={width}
          termHeight={height}
          onCycleTheme={cycleTheme}
          onCycleRetention={cycleRetention}
          onClose={() => {
            setModal(null)
            setFocus("input")
          }}
        />
      ) : null}
      {showChangelog ? (
        <ChangelogModal
          termWidth={width}
          termHeight={height}
          onClose={() => setShowChangelog(false)}
        />
      ) : null}
    </box>
  )
}
