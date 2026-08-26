// Worker B owns this file: Verify modal — side-by-side fingerprint comparison.
// The user compares BOTH fingerprints out-of-band, then confirms or denies.
import type { PeerInfo } from "../core/contract.ts"
import {
  colors,
  displayNameOf,
  fingerprintGroups,
  identityLabel,
} from "./theme"
import { ModalPanel } from "./modal-panel"

export function VerifyModal(props: {
  peer: PeerInfo
  ownNodeId: string
  termWidth: number
  termHeight: number
  onConfirm(peerId: string): void
  onDeny(peerId: string): void
  onCancel(): void
}) {
  const { peer, ownNodeId, termWidth, termHeight, onConfirm, onDeny, onCancel } = props
  const width = Math.min(64, Math.max(40, termWidth - 6))
  const fpHeight = Math.max(2, fingerprintGroups(ownNodeId).length)
  const height = Math.min(termHeight - 2, 10 + fpHeight * 2)
  const name = displayNameOf(peer)

  return (
    <ModalPanel title="Verify identity" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.fg}>{name}</text>
        <text fg={identityGlyphColorSafe(peer)}>{` · ${identityLabel(peer)}`}</text>
      </box>
      <box style={{ height: 1 }} />
      <text fg={colors.dim}>compare these out-of-band (call, meet, trusted chat):</text>
      <box style={{ height: 1 }} />
      {fingerprintGroups(ownNodeId).map((line, i) => (
        <text key={`own-${i}`} fg={colors.highlight}>{`YOU   ${line}`}</text>
      ))}
      <box style={{ height: 1 }} />
      {fingerprintGroups(peer.peerId.replace(/^p-/, "")).map((line, i) => (
        <text key={`peer-${i}`} fg={colors.accent}>{`${name.slice(0, 5).toUpperCase()}  ${line}`}</text>
      ))}
      <box style={{ height: 1 }} />
      {fpHeight <= 4 ? (
        <text fg={colors.dim}>match? confirm. differ? deny — do not talk over it.</text>
      ) : null}
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.online}>[c] Confirm</text>
        <text fg={colors.dim}>   </text>
        <text fg={colors.error}>[d] Deny</text>
        <text fg={colors.dim}>   </text>
        <text fg={colors.dim}>[Esc] Later</text>
      </box>
    </ModalPanel>
  )
}

function identityGlyphColorSafe(peer: PeerInfo): string {
  if (peer.identityState === "mismatch") return colors.error
  if (peer.verified === true) return colors.online
  return colors.connecting
}
