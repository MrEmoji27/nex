// PEOPLE pane — contacts with presence + identity marks.
import { useEffect, useRef, useState } from "react"
import type { PeerInfo, PeerStatus } from "../core/contract.ts"
import {
  colors,
  displayNameOf,
  identityGlyph,
  identityGlyphColor,
  statusColor,
  statusGlyph,
  truncate,
} from "./theme"
import { animsEnabled, useChangeFlash, useTick, spinnerFrame } from "./use-tick"

const LINK_UP_MS = 650
const LINK_DOWN_MS = 450

type LinkFlash = "up" | "down" | null

function nextLinkFlash(before: PeerStatus, after: PeerStatus): LinkFlash {
  if (!animsEnabled() || before === after) return null
  const becameLive =
    after === "connected" && (before === "connecting" || before === "authenticating" || before === "reconnecting")
  if (becameLive) return "up"
  const dropped =
    before === "connected" && (after === "reconnecting" || after === "offline")
  if (dropped) return "down"
  return null
}

/**
 * One row of the people list. Owns its lifecycle flash so the union
 * transition is visible exactly when it happens (dream vision §17/§18):
 * link-up glows the row, link-down pulses it in the alarm tone.
 */
function PeerRow(props: {
  peer: PeerInfo
  selected: boolean
  focused: boolean
  tick: number
  badgeColor: string | undefined
  unread: number | undefined
  onSelect(peerId: string): void
}) {
  const { peer, selected, focused, tick, badgeColor, unread, onSelect } = props
  const prevStatus = useRef<PeerStatus>(peer.status)
  const [flashUntil, setFlashUntil] = useState<{ kind: LinkFlash; at: number } | null>(null)

  useEffect(() => {
    const kind = nextLinkFlash(prevStatus.current, peer.status)
    prevStatus.current = peer.status
    if (kind) setFlashUntil({ kind, at: Date.now() + (kind === "up" ? LINK_UP_MS : LINK_DOWN_MS) })
  }, [peer.status])

  const flashActive = !!flashUntil && Date.now() < flashUntil.at
  const flashKind = flashActive ? flashUntil!.kind : null
  // Repaints while a flash window is open; inert otherwise.
  useTick(flashActive, 90)

  const spinning =
    peer.status === "connecting" || peer.status === "authenticating" || peer.status === "reconnecting"
  const isActiveSelection = selected && focused
  const background = isActiveSelection
    ? colors.accent
    : flashKind === "up"
      ? colors.success
      : flashKind === "down"
        ? colors.danger
        : undefined
  const textColor = isActiveSelection ? colors.onAccent : selected ? colors.heading : colors.text
  const glyphColor = isActiveSelection ? colors.onAccent : colors.textMuted

  return (
    <box
      style={{ flexDirection: "row", height: 1, backgroundColor: background }}
      onMouseDown={() => onSelect(peer.peerId)}
    >
      <text fg={statusColor(peer.status)}>
        {spinning ? `${spinnerFrame(tick)} ` : `${statusGlyph(peer.status)} `}
      </text>
      <text fg={textColor}>
        {displayNameOf(peer)}
      </text>
      <box style={{ flexGrow: 1 }} />
      {unread ? <text fg={isActiveSelection ? colors.onAccent : badgeColor}>{`●${unread} `}</text> : null}
      <text fg={isActiveSelection ? colors.onAccent : identityGlyphColor(peer)}>{identityGlyph(peer)}</text>
    </box>
  )
}

export function PeoplePane(props: {
  peers: PeerInfo[]
  selectedPeerId: string | null
  focused: boolean
  width: number
  height: number
  /** peerId -> unread inbound count (v2 home/recent model). */
  unreadByPeer?: Map<string, number>
  /** Extra section rendered below people (merged recents in narrow layouts). */
  extra?: import("react").ReactNode
  /** Neighbors heard via LAN beacon / intro — not connected yet (alpha.7). */
  discovered?: import("../core/contract").DiscoveredPeer[]
  /** Entrance choreography: true until the shell's stagger reaches this pane. */
  settle?: boolean
  onAddPeer(): void
  onSelect(peerId: string): void
  onConnectDiscovered?(peerId: string): void
}) {
  const { peers, selectedPeerId, focused, width, height, unreadByPeer, extra, discovered, settle, onAddPeer, onSelect, onConnectDiscovered } = props
  // border rows + the "+ Add Peer" action row
  const rows = Math.max(0, height - 3)

  const pending = peers.some(
    (p) => p.status === "connecting" || p.status === "authenticating" || p.status === "reconnecting",
  )
  const tick = useTick(pending)
  // Unread badge: STATIC accent while mail waits. A badge is a persistent
  // state, and persistent states settle calm (dream vision §19) — pulsing
  // forever kept a timer alive whenever ANY unread existed, contradicting the
  // zero-idle-cost rule the clock registry is built on. Attention is drawn at
  // the MOMENT mail arrives: a bounded 900ms glow via useChangeFlash, then the
  // badge holds still. Zero timers once the window closes.
  const totalUnread = peers.reduce((sum, p) => sum + (unreadByPeer?.get(p.peerId) ?? 0), 0)
  const badgeFlash = useChangeFlash(totalUnread, 900)
  const badgeColor = badgeFlash ? colors.heading : colors.accent

  // Window follows the selection so keyboard navigation never loses the cursor.
  const selectedIndex = Math.max(
    0,
    peers.findIndex((p) => p.peerId === selectedPeerId),
  )
  const windowStart =
    peers.length <= rows ? 0 : Math.min(Math.max(0, selectedIndex - (rows - 1)), peers.length - rows)
  const visible = peers.slice(windowStart, windowStart + rows)
  const overflowed = peers.length > visible.length

  // Peer arrival beat: the NEARBY header blips while the discovered set grows
  // or shrinks — something genuinely changed out there.
  const nearbyCount = discovered?.length ?? 0
  const nearbyBlip = useChangeFlash(nearbyCount, 700)

  return (
    <box
      style={{
        width,
        height,
        paddingLeft: 1,
        backgroundColor: colors.surface,
      }}
      border={true}
      borderStyle={focused ? "double" : "single"}
      borderColor={settle ? colors.dim : focused ? colors.accent : colors.border}
      title={
        overflowed ? `PEOPLE ${windowStart + 1}-${windowStart + visible.length}/${peers.length}` : "PEOPLE"
      }
      titleColor={settle ? colors.dim : focused ? colors.accent : colors.dim}
    >
      <box style={{ flexGrow: 1, flexDirection: "column" }}>
        {peers.length === 0 && (discovered?.length ?? 0) === 0 ? (
          <text fg={colors.textMuted}>no one yet — press a to add someone</text>
        ) : (
          <>
            {visible.map((peer) => (
              <PeerRow
                key={peer.peerId}
                peer={peer}
                selected={peer.peerId === selectedPeerId}
                focused={focused}
                tick={tick}
                badgeColor={badgeColor}
                unread={unreadByPeer?.get(peer.peerId)}
                onSelect={onSelect}
              />
            ))}
            {(discovered?.length ?? 0) > 0 ? (
              <>
                <text fg={nearbyBlip ? colors.accent : colors.dim}> ◦ NEARBY</text>
                {discovered!.slice(0, 4).map((d) => {
                  // One row per neighbor, always: the label is truncated to the
                  // pane's inner width. Unbounded, it soft-wraps and shoves the
                  // whole list down the grid.
                  const label = `◦ ${d.name.slice(0, 12)}${d.source === "intro" ? ` via ${d.viaName ?? "?"}` : ""}  [enter=connect]`
                  const inner = Math.max(8, width - 3)
                  return (
                    <box key={d.peerId} style={{ flexDirection: "row" }} onMouseDown={() => onConnectDiscovered?.(d.peerId)}>
                      <text fg={colors.textMuted}>{truncate(label, inner)}</text>
                    </box>
                  )
                })}
              </>
            ) : null}
          </>
        )}
      </box>
      <box style={{ flexDirection: "row", height: 1 }} onMouseDown={onAddPeer}>
        <text fg={focused ? colors.accent : colors.dim}>+ Add Peer</text>
      </box>
    </box>
  )
}
