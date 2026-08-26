// CHAT pane — the active conversation.
import { useEffect, useRef, useState } from "react"
import type { ChatMessage, PeerInfo, PeerRetentionState, RetentionPolicy } from "../core/contract.ts"
import { effectiveRetention } from "../core/contract"
import { colors, displayNameOf, fmtTime, identityGlyph } from "./theme"
import { animsEnabled, dotsFrame, useTick } from "./use-tick"

const STATE_MARK: Record<ChatMessage["state"], string> = {
  queued: "…",
  sent: "",
  failed: " ✗",
}

const RENDER_CAP = 500

function messageColor(message: ChatMessage): string {
  if (message.state === "failed") return colors.danger
  return message.direction === "in" ? colors.messagePeer : colors.messageSelf
}

/**
 * Arrival flash: the newest row lights up briefly whenever a message lands —
 * stronger and longer for inbound (something happened out there), a quick
 * blink for outbound (your send was registered).
 */
function useArrivalFlash(messages: ChatMessage[], scopeKey: string | null): { id: string; active: boolean } {
  const lastIdRef = useRef<string | null>(null)
  const primedRef = useRef(false)
  const [flash, setFlash] = useState<{ id: string; until: number } | null>(null)

  // Conversation switches re-prime: restoring a history never counts as arrival.
  useEffect(() => {
    primedRef.current = false
    lastIdRef.current = null
    setFlash(null)
  }, [scopeKey])

  useEffect(() => {
    const last = messages[messages.length - 1]
    if (!last) return
    if (!primedRef.current) {
      // First render of a restored history: record position, never flash.
      primedRef.current = true
      lastIdRef.current = last.id
      return
    }
    if (last.id !== lastIdRef.current) {
      lastIdRef.current = last.id
      setFlash({ id: last.id, until: Date.now() + (last.direction === "in" ? 650 : 420) })
    }
  }, [messages])

  const flashing = !!flash && Date.now() < flash.until
  // Drives re-renders while a flash window is open; inert otherwise.
  useTick(!!flash)
  return { id: flash?.id ?? "", active: flashing }
}

/** One muted line under the chat title: the relationship's keep-window, honestly. */
function RetentionLine(props: {
  peer: PeerInfo
  agreement: PeerRetentionState | null
  mine: RetentionPolicy
}) {
  const { peer, agreement, mine } = props
  const name = displayNameOf(peer)
  if (agreement?.pendingIn) {
    return (
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <text fg={colors.accent}>{`⇅ ${name} proposes keeping messages ${agreement.pendingIn} — `}</text>
        <text fg={colors.accent}>[a]ccept</text>
        <text fg={colors.textMuted}> or </text>
        <text fg={colors.accent}>[r]eject</text>
        <text fg={colors.textMuted}>(each node deletes its own copies)</text>
      </box>
    )
  }
  const theirs = agreement?.theirs
  const shared = effectiveRetention(mine, theirs)
  const pending = agreement?.pendingOut
  const parts = [
    `keep · you ${mine}`,
    theirs ? `${name} ${theirs}` : `${name}: unknown`,
    `shared ${shared}`,
  ]
  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <text fg={colors.dim}>{parts.join(" · ")}</text>
      {pending ? <text fg={colors.warning}>{` · proposed ${pending}, awaiting reply`}</text> : null}
      {agreement?.lastAction === "reject" && !pending ? (
        <text fg={colors.danger}>{` · they declined a wider window`}</text>
      ) : null}
    </box>
  )
}

export function ChatPane(props: {
  peer: PeerInfo | null
  messages: ChatMessage[]
  height: number
  /** Relationship-level retention state for the open conversation. */
  agreement?: PeerRetentionState | null
  mineRetention?: RetentionPolicy
  /** Entrance choreography: true until the shell's stagger reaches this pane. */
  settle?: boolean
}) {
  const { peer, messages, height, agreement, mineRetention, settle } = props
  const arrival = useArrivalFlash(peer ? messages : [], peer?.peerId ?? null)
  // Outbound queue: dots tick while a send is genuinely in flight, then the
  // mark resolves to its static state. Inert (and honest) otherwise.
  const hasQueued = messages.some((m) => m.direction === "out" && m.state === "queued")
  const queueTick = useTick(hasQueued && animsEnabled(), 320)
  const queuedMark = ` ${animsEnabled() ? dotsFrame(queueTick) : STATE_MARK.queued}`
  const scrollHeight = Math.max(1, height - 3) // border rows + title line
  // Full history stays on disk; the pane renders a generous recent window.
  const renderable = messages.slice(Math.max(0, messages.length - RENDER_CAP))
  const title = peer ? `${displayNameOf(peer).toUpperCase()} ${identityGlyph(peer)}` : "CHAT"

  const borderColor = settle ? colors.dim : colors.borderActive

  return (
    <box
      style={{
        flexGrow: 1,
        height,
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: colors.surface,
      }}
      border={true}
      borderStyle="single"
      borderColor={borderColor}
      title={title}
      titleColor={peer ? (settle ? colors.dim : colors.heading) : colors.dim}
    >
      {!peer ? (
        <box style={{ flexDirection: "column", paddingTop: 1 }}>
          <text fg={colors.textMuted}>no conversation selected</text>
          <text fg={colors.dim}>tab → people · j/k move · enter opens · a adds someone</text>
        </box>
      ) : messages.length === 0 ? (
        <box style={{ flexDirection: "column", paddingTop: 1, flexGrow: 1 }}>
          {mineRetention ? <RetentionLine peer={peer} agreement={agreement ?? null} mine={mineRetention} /> : null}
          <text fg={colors.textMuted}>{`say hi to ${displayNameOf(peer)} —`}</text>
          <text fg={colors.textMuted}>{`just type below and press enter. link is end-to-end shape-checked on both sides.`}</text>
        </box>
      ) : (
        <scrollbox
          style={{ height: scrollHeight, width: "100%" }}
          stickyScroll
          stickyStart="bottom"
          scrollY
          scrollbarOptions={{ showArrows: false }}
        >
          {mineRetention ? <RetentionLine peer={peer} agreement={agreement ?? null} mine={mineRetention} /> : null}
          {renderable.map((message) => {
            const speaker =
              message.direction === "in" ? displayNameOf(peer) : "YOU"
            const flashing = arrival.active && message.id === arrival.id
            return (
              <box
                key={message.id}
                style={{
                  flexDirection: "row",
                  flexShrink: 0,
                  backgroundColor: flashing ? colors.surfaceActive : undefined,
                }}
              >
                <text fg={colors.textMuted}>{`${fmtTime(message.sentAt)} `}</text>
                <text
                  fg={message.direction === "in" ? colors.messagePeer : colors.messageSelf}
                >
                  {speaker}
                </text>
                <text fg={messageColor(message)}>
                  {` > ${message.content}${message.state === "queued" ? queuedMark : STATE_MARK[message.state]}`}
                </text>
              </box>
            )
          })}
        </scrollbox>
      )}
    </box>
  )
}
