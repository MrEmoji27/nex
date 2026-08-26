// React state bridge between the NexApp event bus and the UI.
import { useEffect, useMemo, useState } from "react"
import type {
  AppEvent,
  ChatMessage,
  NodeIdentity,
  NodeStatus,
  PeerInfo,
  PeerRetentionState,
  Settings,
  NexApp,
} from "../core/contract.ts"
import { DEFAULT_SETTINGS } from "../core/contract"

export interface NexUiState {
  identity: NodeIdentity
  status: NodeStatus
  peers: Map<string, PeerInfo>
  /** peerId -> conversation, newest message last */
  conversations: Map<string, ChatMessage[]>
  settings: Settings
  /** peerId -> retention-agreement protocol state (theirs / pending / outcome). */
  retention: Map<string, PeerRetentionState>
  lastError: { scope: string; message: string; at: number } | null
  lastNotice: { message: string; at: number } | null
}

export interface ConversationSummary {
  peerId: string
  lastMessage: ChatMessage
  messageCount: number
  /** Inbound messages that arrived after the last local read (0 = none). */
  unread: number
}

export interface NexUi {
  identity: NodeIdentity
  status: NodeStatus
  peers: PeerInfo[]
  conversations: Map<string, ChatMessage[]>
  settings: Settings
  retention: Map<string, PeerRetentionState>
  unreadByPeer: Map<string, number>
  /** Contacts with history, sorted by recency of the newest message (desc). */
  recentConversations: ConversationSummary[]
  lastError: NexUiState["lastError"]
  lastNotice: NexUiState["lastNotice"]
  selectedPeerId: string | null
  selectPeer(peerId: string | null): void
}

function emptyState(identity: NodeIdentity): NexUiState {
  return {
    identity,
    status: "starting",
    peers: new Map(),
    conversations: new Map(),
    settings: { ...DEFAULT_SETTINGS },
    retention: new Map(),
    lastError: null,
    lastNotice: null,
  }
}

/**
 * The contract's `message` event carries no peerId, so on each message event the
 * store reloads every known conversation and adopts whichever one contains the
 * message id. At v0.1 peer counts this is negligible and keeps attribution exact.
 */
export function useNex(app: NexApp): NexUi {
  const [state, setState] = useState<NexUiState>(() => ({
    ...emptyState(app.identity),
    settings: app.getSettings(),
  }))
  const [selectedPeerId, selectPeer] = useState<string | null>(null)

  useEffect(() => {
    let alive = true

    const loadConversations = async (peerIds: string[]) => {
      const results = await Promise.all(
        peerIds.map(async (peerId) => {
          try {
            return [peerId, await app.conversation(peerId)] as const
          } catch {
            return null
          }
        }),
      )
      if (!alive) return
      setState((prev) => {
        const conversations = new Map(prev.conversations)
        let changed = false
        for (const entry of results) {
          if (!entry) continue
          const [peerId, messages] = entry
          conversations.set(peerId, messages)
          changed = true
        }
        return changed ? { ...prev, conversations } : prev
      })
    }

    const unsubscribe = app.emit((event: AppEvent) => {
      switch (event.type) {
        case "identityLoaded":
          setState((prev) => ({ ...prev, identity: event.identity }))
          break
        case "nodeStatus":
          setState((prev) => ({ ...prev, status: event.status }))
          break
        case "peerChanged": {
          setState((prev) => {
            const peers = new Map(prev.peers)
            peers.set(event.peer.peerId, event.peer)
            return { ...prev, peers }
          })
          void loadConversations([event.peer.peerId])
          break
        }
        case "message": {
          // re-sync all conversations; the one containing this message id wins
          setState((prev) => {
            void loadConversations([...prev.peers.keys()])
            return prev
          })
          break
        }
        case "latency": {
          setState((prev) => {
            const existing = prev.peers.get(event.peerId)
            if (!existing) return prev
            const peers = new Map(prev.peers)
            peers.set(event.peerId, { ...existing, latencyMs: event.latencyMs })
            return { ...prev, peers }
          })
          break
        }
        case "settingsChanged":
          setState((prev) => ({ ...prev, settings: event.settings }))
          break
        case "retentionChanged":
          setState((prev) => ({
            ...prev,
            retention: new Map(prev.retention).set(event.peerId, { ...event.state }),
          }))
          break
        case "notice":
          setState((prev) => ({ ...prev, lastNotice: { message: event.message, at: Date.now() } }))
          break
        case "error":
          setState((prev) => ({
            ...prev,
            lastError: { scope: event.scope, message: event.message, at: Date.now() },
          }))
          break
      }
    })

    void (async () => {
      try {
        const peers = await app.listPeers()
        if (!alive) return
        setState((prev) => {
          const nextPeers = new Map(prev.peers)
          for (const peer of peers) nextPeers.set(peer.peerId, peer)
          return { ...prev, peers: nextPeers, status: app.status }
        })
        await loadConversations(peers.map((p) => p.peerId))
      } catch {
        // startup enumeration is best-effort; the bus still drives updates
      }
    })()

    return () => {
      alive = false
      unsubscribe()
    }
  }, [app])

  return useMemo(() => {
    const rank = (peer: PeerInfo) =>
      peer.status === "connected" ? 0 : peer.status === "connecting" || peer.status === "reconnecting" ? 1 : 2
    const peers = [...state.peers.values()].sort(
      (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
    )
    // Unread: inbound messages newer than the last local read of that conversation.
    const unreadByPeer = new Map<string, number>()
    for (const [peerId, messages] of state.conversations) {
      const lastRead = state.settings.lastReadAt?.[peerId] ?? 0
      const unread = messages.filter((m) => m.direction === "in" && m.sentAt > lastRead).length
      if (unread > 0) unreadByPeer.set(peerId, unread)
    }
    const recentConversations = [...state.conversations.entries()]
      .filter(([peerId, messages]) => state.peers.has(peerId) && messages.length > 0)
      .map(([peerId, messages]) => ({
        peerId,
        lastMessage: messages[messages.length - 1]!,
        messageCount: messages.length,
        unread: unreadByPeer.get(peerId) ?? 0,
      }))
      .sort((a, b) => b.lastMessage.sentAt - a.lastMessage.sentAt)
    return {
      identity: state.identity,
      status: state.status,
      peers,
      conversations: state.conversations,
      settings: state.settings,
      retention: state.retention,
      unreadByPeer,
      recentConversations,
      lastError: state.lastError,
      lastNotice: state.lastNotice,
      selectedPeerId,
      selectPeer,
    }
  }, [state, selectedPeerId])
}

/** Reads one conversation from the shared store. */
export function useConversation(
  ui: NexUi,
  peerId: string | null,
): ChatMessage[] {
  return useMemo(
    () => (peerId ? (ui.conversations.get(peerId) ?? []) : []),
    [ui.conversations, peerId],
  )
}
