// HOME screen (vision §5): orientation point at launch — who's here, what's new,
// what needs attention. Social hierarchy first; network details stay in the app shell.
import type { NodeIdentity, NodeStatus, PeerInfo } from "../core/contract.ts"
import type { ConversationSummary } from "./use-nex"
import { APP_VERSION } from "../version"
import { useChangeFlash, useTick, animsEnabled } from "./use-tick"
import { clamp01, easeOutCubic, revealText } from "./anim"
import { useRef } from "react"
import {
  colors,
  displayNameOf,
  fingerprint,
  identityGlyph,
  identityGlyphColor,
  nodeStatusColor,
  nodeStatusGlyph,
  relTime,
  statusColor,
  statusGlyph,
  truncate,
} from "./theme"

// ─── Wordmark (V3 §30) ────────────────────────────────────────────────────
// ASCII-forward means DRAWN on the cell lattice, not pasted from a FIGlet
// font. These rectangles are the SAME construction as the site wordmark
// (web/components/site/wordmark.tsx: N_CELLS / E_CELLS / X_CELLS on 20-unit
// cells — one-cell stems, staircase diagonals, baseline caret after the X),
// rasterized onto the character grid. One drawing, two media, one product.
// The previous hero was DOS Rebel FIGlet output — exactly the generic paste
// §30 warns against. Change the cell data together in both files.
type LatticeCell = readonly [x: number, y: number, w: number, h: number]

/** N — two stems with a three-step staircase between them. */
const N_CELLS: LatticeCell[] = [
  [0, 0, 1, 7], [4, 0, 1, 7],
  [1, 1, 1, 2], [2, 3, 1, 2], [3, 5, 1, 2],
]
/** E — one stem, three square-cut arms; the middle arm is one cell short. */
const E_CELLS: LatticeCell[] = [
  [0, 0, 1, 7],
  [1, 0, 4, 1], [1, 3, 3, 1], [1, 6, 4, 1],
]
/** X — two mirrored staircases crossing on the centre cell. */
const X_CELLS: LatticeCell[] = [
  [0, 0, 1, 2], [4, 0, 1, 2],
  [1, 2, 1, 1], [3, 2, 1, 1],
  [2, 3, 1, 1],
  [1, 4, 1, 1], [3, 4, 1, 1],
  [0, 5, 1, 2], [4, 5, 1, 2],
]
const LETTERS = [N_CELLS, E_CELLS, X_CELLS] as const
const LATTICE_COLS = 21 // 3×5-letter cells, 2-cell gaps, 1 trailing caret column
const LATTICE_ROWS = 7

function rasterizeLattice(charsPerCell: 1 | 2): string[] {
  const grid: boolean[][] = Array.from({ length: LATTICE_ROWS }, () =>
    new Array<boolean>(LATTICE_COLS).fill(false),
  )
  let dx = 0
  for (const letter of LETTERS) {
    for (const [x, y, w, h] of letter) {
      for (let cy = y; cy < y + h; cy++) {
        for (let cx = x; cx < x + w; cx++) grid[cy]![cx + dx] = true
      }
    }
    dx += 7 // 5-wide letter + 2-cell gap
  }
  grid[LATTICE_ROWS - 1]![LATTICE_COLS - 1] = true // baseline caret, as on the site
  return grid.map((rowCells) =>
    rowCells
      .map((on) => (on ? "█" : " ").repeat(charsPerCell))
      .join("")
      .replace(/\s+$/, ""),
  )
}

const WORDMARK_LATTICE = rasterizeLattice(2)       // ██ per cell — ≥48 columns
const WORDMARK_LATTICE_TIGHT = rasterizeLattice(1) // █ per cell — 28..47 columns

/** Tiny footer signature (Cyberlarge, trimmed): the quiet brand line. */
const FOOTER_MARK_ROWS = [`_______ _______ _     _`, `|______ |______/ |_____|`]

/**
 * Hero rows for this terminal — drives the shimmer sweep and the row budget.
 * Height-aware: a short terminal always gets the two-row mark so the page can
 * never overflow its box (the old code picked the hero by width alone and let
 * an 8-row FIGlet eat pages it did not fit).
 */
function wordmarkFor(width: number, height: number): string[] {
  if (height < 12) return FOOTER_MARK_ROWS
  if (width >= 48) return WORDMARK_LATTICE
  if (width >= 28) return WORDMARK_LATTICE_TIGHT
  return FOOTER_MARK_ROWS
}

/**
 * Boot reveal (the signature moment): a wave of brightness sweeps down the
 * wordmark once, then the tagline types itself in, and everything settles
 * static. Wall-clock anchored; the shared clock only forces repaints and is
 * released the moment the reveal completes. Reduced motion skips straight to
 * the settled state — same information, zero frames.
 */
const SWEEP_MS = 620
const TAGLINE_TEXT = " direct · encrypted · no server"
const TAGLINE_MS = 460
const REVEAL_TOTAL = SWEEP_MS + 120 + TAGLINE_MS

function useBootReveal(rows: number): {
  wordmarkColor: (row: number) => string
  tagline: string
} {
  const motion = animsEnabled()
  const startedAtRef = useRef(Date.now())
  const elapsed = motion ? Date.now() - startedAtRef.current : Number.MAX_SAFE_INTEGER
  const done = elapsed >= REVEAL_TOTAL
  useTick(motion && !done, 70)

  const wavefront = (elapsed / SWEEP_MS) * (rows + 2) - 1
  const wordmarkColor = (row: number): string => {
    if (!motion || done) return colors.accent
    const d = wavefront - row
    if (d < 0) return colors.textMuted
    if (d < 1) return colors.heading
    return colors.accent
  }
  const tagline = motion
    ? revealText(TAGLINE_TEXT, easeOutCubic(clamp01((elapsed - SWEEP_MS - 120) / TAGLINE_MS)))
    : TAGLINE_TEXT
  return { wordmarkColor, tagline }
}

export function HomeScreen(props: {
  identity: NodeIdentity
  status: NodeStatus
  peers: PeerInfo[]
  recentConversations: ConversationSummary[]
  /** Changelog headline when the current version was not seen yet. */
  whatsNew: string | null
  width: number
  height: number
  onContinue(): void
  onAddPeer(): void
  /** Called when the version chip is clicked. */
  onVersionClick(): void
}) {
  const { identity, status, peers, recentConversations, whatsNew, width, height } = props
  const rows = wordmarkFor(width, height)
  const heroCount = rows.length
  const { wordmarkColor, tagline } = useBootReveal(heroCount)
  const online = peers.filter((p) => p.status === "connected")
  // Presence register: the section header blips once when the online set changes.
  const presenceBlip = useChangeFlash(online.length, 600)
  const pendingVerification = peers.filter(
    (p) => p.identityState !== undefined && !p.verified && p.identityState !== "mismatch",
  )
  const mismatched = peers.filter((p) => p.identityState === "mismatch")

  const activity: Array<{ text: string; tone: string }> = []
  activity.push({
    text: `${online.length} ${online.length === 1 ? "peer" : "peers"} online · ${pendingVerification.length} pending verification`,
    tone: colors.textMuted,
  })
  if (mismatched.length > 0) {
    activity.push({
      text: `ID MISMATCH on ${mismatched.map(displayNameOf).join(", ")} — do not trust that link`,
      tone: colors.danger,
    })
  }
  if (whatsNew) activity.push({ text: whatsNew, tone: colors.accent })

  // ── Row accounting ─────────────────────────────────────────────────────
  // Root cause of the home/footer collision, fixed structurally: the old
  // layout derived its list budget from a fudge constant ("-10") and rendered
  // every section unconditionally, so on terminals shorter than ~30 rows the
  // page's natural height exceeded this component's box and bled INTO the
  // shell footer's row — two texts drawn into the same cells. Now every block
  // declares its cost and renders only while it fits. Allocation priority:
  // hero, signature, PEOPLE (social hierarchy first), ACTIVITY (carries the
  // ID-mismatch warning — all-or-nothing so a warning is never cut
  // mid-line), welcome, tagline, RECENT.
  const left = { rows: height }
  const take = (cost: number): void => {
    left.rows -= cost
  }

  take(/* padding-top */ 1 + heroCount + /* accent bar */ 1)
  const hasSignature = left.rows >= 2
  if (hasSignature) take(2)

  const hasPeople = left.rows >= 4 // lead blank + header + ≥1 body row + trail blank
  const peopleBody = hasPeople
    ? online.length === 0
      ? 1
      : Math.max(1, Math.min(online.length, left.rows - 3))
    : 0
  if (hasPeople) take(peopleBody + 3)

  const activityCost = activity.length + 1
  const hasActivity = left.rows >= activityCost
  if (hasActivity) take(activityCost)

  const hasWelcome = left.rows >= 2 // lead blank + greeting
  if (hasWelcome) take(2)

  const hasTagline = left.rows >= 1
  if (hasTagline) take(1)

  const hasRecent = left.rows >= 3 // header + ≥1 body row + trail blank
  const recentBody = hasRecent
    ? recentConversations.length === 0
      ? 1
      : Math.max(1, Math.min(recentConversations.length, left.rows - 2))
    : 0
  if (hasRecent) take(recentBody + 2)
  // Anything left is absorbed by the flexGrow spacer above the signature.

  // ── Footer signature geometry ──────────────────────────────────────────
  // The mark column and the keys/identity column get a real 2-cell gutter;
  // previously they sat flush (`|_____|you are ◈ …`) and below ~74 columns
  // the 46-char key-hint row wrapped straight through the identity line —
  // the visible "two texts in shared cells". The decorative mark now yields
  // entirely unless BOTH rows provably fit side by side; the identity line
  // sheds its fingerprint before it would ever push the status off-row.
  const PAD_LEFT = 2
  const GUTTER = 2
  const MARK_COLS = FOOTER_MARK_ROWS[0]!.length + 1 // rows are 23 wide; keep 1 cell slack
  const KEYS_FULL = "[Enter] Continue   [a] Add Peer   [s] Settings"
  const KEYS_TIGHT = "[Enter] Continue [a] Add Peer [s] Settings"
  const markShown =
    hasSignature &&
    width - PAD_LEFT - MARK_COLS - GUTTER >= KEYS_FULL.length &&
    width >= 28 // never twin the two-row mark that is already serving as hero
  const rightWidth = width - PAD_LEFT - (markShown ? MARK_COLS + GUTTER : 0)
  const keysLine = rightWidth >= KEYS_FULL.length ? KEYS_FULL : KEYS_TIGHT

  const idHead = `you are ◈ ${identity.name}`
  const idFp = ` · ${fingerprint(identity.nodeId)}`
  const idStatus = `${nodeStatusGlyph(status)} ${status.toUpperCase()}`
  const showFp = idHead.length + idFp.length + idStatus.length + 3 <= rightWidth
  const keysText = truncate(keysLine, Math.max(12, rightWidth))

  return (
    <box style={{ width, height, flexDirection: "column", paddingLeft: 2, paddingTop: 1 }}>
      {/* Wordmark with boot shimmer */}
      {rows.map((row, i) => (
        <text key={`wm-${i}`} fg={wordmarkColor(i)}>{row}</text>
      ))}
      {/* Aggressive accent bar under wordmark — the hero line */}
      <box style={{ height: 1, backgroundColor: colors.accent }}>
        <text fg={colors.onAccent}>{"▄".repeat(Math.max(4, width - 4))}</text>
      </box>
      {/* Tagline (types in once at boot) + inverted version chip */}
      {hasTagline ? (
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={colors.textMuted}>{tagline}</text>
          <box style={{ flexGrow: 1 }} />
          <box
            style={{ flexDirection: "row", height: 1, backgroundColor: colors.accent }}
            onMouseDown={props.onVersionClick}
          >
            <text fg={colors.onAccent}>{` v${APP_VERSION} `}</text>
          </box>
        </box>
      ) : null}
      {hasWelcome ? (
        <>
          <box style={{ height: 1 }} />
          <text fg={colors.heading}>{`Welcome back, ${identity.name}.`}</text>
        </>
      ) : null}

      {/* PEOPLE ONLINE with accent prefix block */}
      {hasPeople ? (
        <>
          <box style={{ height: 1 }} />
          <box style={{ flexDirection: "row", height: 1 }}>
            <text fg={presenceBlip ? colors.accent : colors.dim}>{"▌"}</text>
            <text fg={presenceBlip ? colors.accent : colors.dim}>{" PEOPLE ONLINE"}</text>
          </box>
          {online.length === 0 ? (
            <text fg={colors.textMuted}>no one here yet — press a to add someone</text>
          ) : (
            online.slice(0, peopleBody).map((peer) => (
              <box key={peer.peerId} style={{ flexDirection: "row", height: 1 }} onMouseDown={() => props.onContinue()}>
                <text fg={statusColor(peer.status)}>{`${statusGlyph(peer.status)} `}</text>
                <text fg={colors.text}>
                  {displayNameOf(peer)}
                </text>
                <box style={{ flexGrow: 1 }} />
                {unreadFor(peer.peerId, recentConversations) > 0 ? (
                  <text fg={colors.accent}>{`●${unreadFor(peer.peerId, recentConversations)} `}</text>
                ) : null}
                <text fg={identityGlyphColor(peer)}>{identityGlyph(peer)}</text>
              </box>
            ))
          )}
        </>
      ) : null}

      {/* RECENT with prefix */}
      {hasRecent ? (
        <>
          <box style={{ flexDirection: "row", height: 1 }}>
            <text fg={colors.accent}>{"▌"}</text>
            <text fg={colors.dim}> RECENT</text>
          </box>
          {recentConversations.length === 0 ? (
            <text fg={colors.textMuted}>no conversations yet — say hi from the shell</text>
          ) : (
            recentConversations.slice(0, recentBody).map((entry) => {
              const peer = peers.find((p) => p.peerId === entry.peerId)
              const name = truncate(peer ? displayNameOf(peer) : entry.peerId, 16)
              const preview = truncate(entry.lastMessage.content, Math.max(6, Math.floor(width * 0.4)))
              return (
                <box key={entry.peerId} style={{ flexDirection: "row", height: 1 }}>
                  <text fg={entry.unread > 0 ? colors.text : colors.textMuted}>
                    {name}
                  </text>
                  <text fg={colors.textMuted}>{` ${preview}`}</text>
                  <box style={{ flexGrow: 1 }} />
                  {entry.unread > 0 ? <text fg={colors.accent}>{`●${entry.unread} `}</text> : null}
                  <text fg={colors.textMuted}>{relTime(entry.lastMessage.sentAt)}</text>
                </box>
              )
            })
          )}
          <box style={{ height: 1 }} />
        </>
      ) : null}

      {/* ACTIVITY with prefix */}
      {hasActivity ? (
        <>
          <box style={{ flexDirection: "row", height: 1 }}>
            <text fg={colors.accent}>{"◆"}</text>
            <text fg={colors.dim}> ACTIVITY</text>
          </box>
          {activity.map((line, i) => (
            <text key={`act-${i}`} fg={line.tone}>
              {truncate(line.text, Math.max(12, width - 4))}
            </text>
          ))}
        </>
      ) : null}
      <box style={{ flexGrow: 1 }} />

      {/* Footer signature: mark + gutter + keys/identity, all budget-checked */}
      {hasSignature ? (
        <box style={{ flexDirection: "row", height: FOOTER_MARK_ROWS.length }}>
          {markShown ? (
            <>
              {/* 24-col box for 23-char rows: never measure to exact box width
                  (exact-fit multi-span rows soft-wrap on OpenTUI layout passes). */}
              <box style={{ width: MARK_COLS, flexDirection: "column" }}>
                {FOOTER_MARK_ROWS.map((row, i) => (
                  <text key={`fm-${i}`} fg={colors.dim}>{row}</text>
                ))}
              </box>
              {/* Real gutter — the two columns never share a visual cell */}
              <box style={{ width: GUTTER }} />
            </>
          ) : null}
          <box style={{ flexGrow: 1, flexDirection: "column", justifyContent: "flex-end" }}>
            <box style={{ flexDirection: "row", height: 1 }}>
              {rightWidth >= keysLine.length ? (
                <>
                  <text fg={colors.accent}>[Enter]</text>
                  <text fg={colors.text}> Continue</text>
                  <text fg={colors.textMuted}>{keysLine === KEYS_FULL ? "   " : " "}</text>
                  <text fg={colors.success}>[a]</text>
                  <text fg={colors.text}> Add Peer</text>
                  <text fg={colors.textMuted}>{keysLine === KEYS_FULL ? "   " : " "}</text>
                  <text fg={colors.warning}>[s]</text>
                  <text fg={colors.text}> Settings</text>
                </>
              ) : (
                <text fg={colors.dim}>{keysText}</text>
              )}
            </box>
            <box style={{ flexDirection: "row", height: 1 }}>
              {showFp ? (
                <>
                  <text fg={colors.textMuted}>{`${idHead}${idFp} · `}</text>
                  <text fg={nodeStatusColor(status)}>{idStatus}</text>
                </>
              ) : (
                <>
                  <text fg={colors.textMuted}>
                    {truncate(idHead, Math.max(4, rightWidth - idStatus.length - 3))}
                  </text>
                  <text fg={nodeStatusColor(status)}>{` · ${idStatus}`}</text>
                </>
              )}
            </box>
          </box>
        </box>
      ) : null}
    </box>
  )
}

function unreadFor(peerId: string, entries: ConversationSummary[]): number {
  return entries.find((e) => e.peerId === peerId)?.unread ?? 0
}
