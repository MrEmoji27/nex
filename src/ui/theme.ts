// Shared UI tokens, theme registry, and formatting helpers.
//
// v2 (vision §15): themes are token sets. Components read color keys
// (`colors.fg`, `colors.accent`, …) through a proxy bound to the ACTIVE theme,
// so a switch re-colors everything on the next render without touching call sites.
import type { IdentityState, NodeStatus, PeerStatus } from "../core/contract.ts"

/**
 * Canonical theme tokens (vision §15) plus the two border tones every panel
 * needs. Legacy component-facing aliases (fg/dim/highlight/…) are derived.
 */
export interface ThemeTokens {
  background: string
  surface: string
  surfaceActive: string
  border: string
  borderActive: string
  text: string
  textMuted: string
  accent: string
  success: string
  warning: string
  danger: string
  verified: string
  unverified: string
  identity: string
  messageSelf: string
  /** Heading/name emphasis tone (legacy alias: highlight). */
  heading: string
  /** Readable ink for text placed ON accent backgrounds (inverse elements). */
  onAccent: string
  messagePeer: string
}

export interface Theme {
  id: string
  name: string
  tokens: ThemeTokens
}

export const DEFAULT_THEME_ID = "nex-dark"

const DEFINITIONS: Theme[] = [
  {
    id: "nex-dark",
    name: "Nex Dark",
    tokens: {
      background: "#16161e",
      surface: "#1a1b26",
      surfaceActive: "#1f2335",
      border: "#33394a",
      borderActive: "#4a5578",
      text: "#cfd2d6",
      textMuted: "#5f6672",
      accent: "#7aa2f7",
      success: "#9ece6a",
      warning: "#e0af68",
      danger: "#f7768e",
      verified: "#9ece6a",
      unverified: "#565f89",
      identity: "#7aa2f7",
      messageSelf: "#c0caf5",
      heading: "#c0caf5",
      onAccent: "#101014",
      messagePeer: "#7aa2f7",
    },
  },
  {
    id: "nex-light",
    name: "Nex Light",
    tokens: {
      background: "#f5f5f7",
      surface: "#ffffff",
      surfaceActive: "#e4e6ee",
      border: "#c8ccd8",
      borderActive: "#8891ab",
      text: "#33363f",
      textMuted: "#8a90a3",
      accent: "#4265d6",
      success: "#3f7d2f",
      warning: "#a06a12",
      danger: "#c23b52",
      verified: "#3f7d2f",
      unverified: "#9aa0b0",
      identity: "#4265d6",
      messageSelf: "#1f2230",
      heading: "#1f2230",
      onAccent: "#ffffff",
      messagePeer: "#4265d6",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    tokens: {
      background: "#1a1b26",
      surface: "#16161e",
      surfaceActive: "#24283b",
      border: "#292e42",
      borderActive: "#3d4a72",
      text: "#a9b1d6",
      textMuted: "#565f89",
      accent: "#7aa2f7",
      success: "#9ece6a",
      warning: "#e0af68",
      danger: "#f7768e",
      verified: "#73daca",
      unverified: "#565f89",
      identity: "#bb9af7",
      messageSelf: "#c0caf5",
      heading: "#c0caf5",
      onAccent: "#101014",
      messagePeer: "#7aa2f7",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    tokens: {
      background: "#1e1e2e",
      surface: "#181825",
      surfaceActive: "#313244",
      border: "#45475a",
      borderActive: "#585b70",
      text: "#cdd6f4",
      textMuted: "#6c7086",
      accent: "#89b4fa",
      success: "#a6e3a1",
      warning: "#f9e2af",
      danger: "#f38ba8",
      verified: "#a6e3a1",
      unverified: "#6c7086",
      identity: "#94e2d5",
      messageSelf: "#cba6f7",
      heading: "#cba6f7",
      onAccent: "#11111b",
      messagePeer: "#89b4fa",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    tokens: {
      background: "#282828",
      surface: "#1d2021",
      surfaceActive: "#3c3836",
      border: "#504945",
      borderActive: "#665c54",
      text: "#ebdbb2",
      textMuted: "#928374",
      accent: "#83a598",
      success: "#b8bb26",
      warning: "#fe8019",
      danger: "#fb4934",
      verified: "#b8bb26",
      unverified: "#928374",
      identity: "#8ec07c",
      messageSelf: "#fabd2f",
      heading: "#fabd2f",
      onAccent: "#1d2021",
      messagePeer: "#83a598",
    },
  },
  {
    id: "nord",
    name: "Nord",
    tokens: {
      background: "#2e3440",
      surface: "#292e39",
      surfaceActive: "#3b4252",
      border: "#434c5e",
      borderActive: "#4c566a",
      text: "#eceff4",
      textMuted: "#7b88a1",
      accent: "#81a1c1",
      success: "#a3be8c",
      warning: "#ebcb8b",
      danger: "#bf616a",
      verified: "#a3be8c",
      unverified: "#7b88a1",
      identity: "#8fbcbb",
      messageSelf: "#88c0d0",
      heading: "#88c0d0",
      onAccent: "#242933",
      messagePeer: "#81a1c1",
    },
  },
]

/** Ordered registry for cycling UIs; ids are stable settings keys. */
export const THEMES: readonly Theme[] = DEFINITIONS

export function getTheme(id: string | undefined): Theme {
  return DEFINITIONS.find((t) => t.id === id) ?? DEFINITIONS[0]!
}

/** Component-facing palette: canonical tokens + historical alias keys. */
type Palette = ThemeTokens & {
  fg: string
  dim: string
  highlight: string
  online: string
  connecting: string
  offline: string
  error: string
  selectedBg: string
}

function resolvePalette(themeId: string): Palette {
  const t = getTheme(themeId).tokens
  return {
    ...t,
    fg: t.text,
    dim: t.textMuted,
    highlight: t.heading,
    online: t.success,
    connecting: t.warning,
    offline: t.unverified,
    error: t.danger,
    selectedBg: t.surfaceActive,
  }
}

let activeId = DEFAULT_THEME_ID
let resolved = resolvePalette(activeId)

/** Switch the active theme; unknown/undefined ids keep the current one. */
export function setActiveTheme(id: string | undefined): void {
  if (!id || !DEFINITIONS.some((t) => t.id === id)) return
  activeId = id
  resolved = resolvePalette(id)
}

export function getActiveThemeId(): string {
  return activeId
}

/**
 * Live palette: reads through to the active theme on every access.
 * Historical keys (fg, dim, highlight, online, connecting, offline, error,
 * selectedBg) keep their meaning; canonical token names work too.
 */
export const colors = new Proxy({} as Palette, {
  get: (_target, key: string) => Reflect.get(resolved, key),
})

// Motion-state glyphs come from ONE vocabulary: the half-pie spin family
// exported by use-tick (SPINNER_FRAMES = ◐◓◑◒). Live panes animate through the
// frames; static surfaces pin one frame from the SAME set, so a state never
// wears two different symbols. (reconnecting used to be ↻ here while the
// people pane spun ◐◓◑◒ — two glyphs for one meaning.)
const STATUS_GLYPH: Record<PeerStatus, string> = {
  connected: "●",
  connecting: "◐",
  authenticating: "◑",
  reconnecting: "◒",
  discovered: "○",
  offline: "○",
}

export function statusGlyph(status: PeerStatus): string {
  return STATUS_GLYPH[status]
}

export function statusColor(status: PeerStatus): string {
  switch (status) {
    case "connected":
      return colors.success
    case "connecting":
    case "authenticating":
      return colors.warning
    case "reconnecting":
      return colors.danger
    case "discovered":
    case "offline":
      return colors.unverified
  }
}

export function nodeStatusGlyph(status: NodeStatus): string {
  switch (status) {
    case "online":
      return "●"
    case "starting":
      return "◐"
    case "offline":
      return "○"
  }
}

export function nodeStatusColor(status: NodeStatus): string {
  switch (status) {
    case "online":
      return colors.success
    case "starting":
      return colors.warning
    case "offline":
      return colors.unverified
  }
}

/**
 * Identity mark per peer row: ✓ verified, · identified, ? unknown,
 * ✗ mismatch. Derived from real contract state only.
 */
export function identityGlyph(peer: { verified?: boolean; identityState?: IdentityState }): string {
  if (peer.verified === true) return "✓"
  if (peer.identityState === "mismatch") return "✗"
  if (peer.identityState === "identified") return "·"
  return "?"
}

export function identityGlyphColor(peer: { verified?: boolean; identityState?: IdentityState }): string {
  if (peer.verified === true) return colors.success
  if (peer.identityState === "mismatch") return colors.danger
  if (peer.identityState === "identified") return colors.accent
  return colors.unverified
}

/** Context-strip identity label from real state (honest, no invention). */
export function identityLabel(peer: {
  verified?: boolean
  identityState?: IdentityState
}): string {
  if (peer.verified === true) return "VERIFIED ID"
  if (peer.identityState === "mismatch") return "ID MISMATCH"
  if (peer.identityState === "identified") return "IDENTIFIED"
  return "UNVERIFIED"
}

export function securityLabel(linkSecurity: "none" | "transport"): string {
  return linkSecurity === "transport" ? "ENCRYPTED" : "NO ENCRYPTION"
}

/** The name a person goes by in this UI: local rename wins over wire name. */
export function displayNameOf(peer: { name: string; displayName?: string }): string {
  return peer.displayName ?? peer.name
}

/** "7F3A91C2..." -> "7F3A 91C2" */
export function fingerprint(nodeId: string): string {
  const head = nodeId.slice(0, 8).toUpperCase()
  return head.replace(/(.{4})(.{4})/, "$1 $2")
}

/** Full nodeId wrapped into space-grouped hex quads for human comparison. */
export function fingerprintGroups(nodeId: string, perLine = 8): string[] {
  const hex = nodeId.toUpperCase().replace(/[^0-9A-F]/g, "")
  const groups: string[] = []
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.slice(i, i + 4))
  }
  const lines: string[] = []
  for (let i = 0; i < groups.length; i += perLine) {
    lines.push(groups.slice(i, i + perLine).join(" "))
  }
  return lines.length > 0 ? lines : [nodeId.toUpperCase()]
}

/** "p-ab12ef34" -> "ab12ef34" */
export function shortId(peerId: string): string {
  return peerId.replace(/^p-/, "").slice(0, 8)
}

export function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + "…"
}

/** Compact relative age for conversation rows: "just now", "2m", "3h", "2d". */
export function relTime(unixMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - unixMs) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function fmtTime(unixMs: number): string {
  const d = new Date(unixMs)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
