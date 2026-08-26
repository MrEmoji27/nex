// Context strip — who you're talking to and over what.
// Renders REAL state only: identity label from handshake/verification,
// security label straight from app.getLinkSecurity(). Never invents ENCRYPTED.
// The leading union miniature is the SAME visual language as the connect
// scene (V3 §18: one language, driven by actual state) — static on purpose.
import type { PeerInfo } from "../core/contract.ts"
import { colors, displayNameOf, identityLabel, securityLabel, statusColor } from "./theme"
import { unionMiniGlyph } from "./union-scene"
import { useChangeFlash } from "./use-tick"

export function ContextStrip(props: {
  peer: PeerInfo | null
  linkSecurity: "none" | "transport"
  /** Listening address shown when no peer is selected; omit segment when unknown. */
  listeningAddress?: string | null
  width: number
}) {
  const { peer, linkSecurity, listeningAddress, width } = props
  const latencyFlash = useChangeFlash(peer?.status === "connected" ? peer?.latencyMs : undefined, 600)
  // TOFU pin confirmed: the identity segment blinks once when a link settles
  // into `identified` (first meeting -> unknown -> identified on re-handshake).
  const identifiedFlash = useChangeFlash(peer?.identityState === "identified", 700)

  if (!peer) {
    return (
      <box style={{ width, height: 1, paddingLeft: 1 }}>
        <text fg={colors.textMuted}>
          {listeningAddress
            ? `listening on ${listeningAddress} — share it so people can connect`
            : "no conversation selected"}
        </text>
      </box>
    )
  }

  const mismatch = peer.identityState === "mismatch"
  const parts = [
    `${displayNameOf(peer).toUpperCase()} · ${identityLabel(peer)} · DIRECT/TCP`,
    peer.latencyMs != null ? `${Math.round(peer.latencyMs)}ms` : null,
    securityLabel(linkSecurity),
  ].filter((part): part is string => part != null)

  return (
    <box style={{ width, height: 1, flexDirection: "row", paddingLeft: 1 }}>
      <text fg={statusColor(peer.status)}>{`${unionMiniGlyph(peer.status)} `}</text>
      <text
        fg={
          mismatch
            ? colors.danger
            : identifiedFlash
              ? colors.success
              : colors.textMuted
        }
      >
        {parts.join(" · ")}
      </text>
      {mismatch ? (
        <text fg={colors.danger}>{"   do not trust this link"}</text>
      ) : latencyFlash ? (
        <text fg={colors.accent}>{" ●"}</text>
      ) : null}
    </box>
  )
}
