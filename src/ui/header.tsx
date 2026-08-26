// Header bar: brand, node identity, status pill.
// Honesty: only STARTING spins (work is actually happening). OFFLINE sits
// static — a spinner on a dead node would imply futile activity.
import type { NodeIdentity, NodeStatus } from "../core/contract.ts"
import { colors, fingerprint } from "./theme"
import { spinnerFrame, useTick } from "./use-tick"

export function Header(props: { identity: NodeIdentity; status: NodeStatus; width: number }) {
  const { identity, status, width } = props
  const starting = status === "starting"
  const tick = useTick(starting, 240)

  const glyph = starting ? spinnerFrame(tick) : status === "online" ? "●" : "○"
  const color = starting ? colors.warning : status === "online" ? colors.success : colors.unverified

  return (
    <box
      style={{
        width,
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text fg={colors.accent}>◈ </text>
      <text fg={colors.heading}>NEX</text>
      <text fg={colors.textMuted}>{` // ${identity.name}`}</text>
      <text fg={colors.textMuted}>{`  ${fingerprint(identity.nodeId)}`}</text>
      <box style={{ flexGrow: 1 }} />
      <text fg={color}>{`${glyph} ${status.toUpperCase()}`}</text>
    </box>
  )
}
