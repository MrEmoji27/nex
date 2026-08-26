// Add Peer modal — host:port entry, Enter=Connect, Esc=Cancel.
// The connect flow hosts the union scene centrepiece (V3 §17/§18): the phase
// follows REAL progress only — dialing reaches, an authenticating link proves
// identity, and the bridge closes exclusively when the app reports connected.
import { useEffect, useRef } from "react"
import type { InputRenderable } from "@opentui/core"
import { colors } from "./theme"
import { dotsFrame, spinnerFrame, useTick, animsEnabled } from "./use-tick"
import { seekBar } from "./anim"
import { UnionScene } from "./union-scene"
import type { UnionPhase } from "./union-scene"
import { ModalPanel } from "./modal-panel"

/** Real connect progress, fed by the app's event bus (never guessed). */
export type ConnectStage = "dialing" | "authenticating"

export function AddPeerModal(props: {
  termWidth: number
  termHeight: number
  busy: boolean
  error: string | null
  /** Real handshake progress while busy (peerChanged events). */
  stage?: ConnectStage
  /** Set right after a successful dial; the modal shows the settle state. */
  linkedName?: string | null
  onConnect(address: string): void
  onCancel(): void
}) {
  const { termWidth, termHeight, busy, error, stage, linkedName, onConnect, onCancel } = props
  const inputRef = useRef<InputRenderable | null>(null)
  const width = Math.min(52, Math.max(30, termWidth - 8))
  // Tiny terminals keep the classic compact modal; there is no room for drama.
  const roomy = termHeight >= 20
  const height = roomy ? 13 : 7

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const settling = !!linkedName
  const motion = animsEnabled()
  const tick = useTick(busy || !!settling, busy ? 130 : 320)

  // Scene phase mirrors reality only. No authenticating claim without the
  // bus reporting one; no closed bridge before `connected`.
  const phase: UnionPhase = settling
    ? { kind: "formed" }
    : busy
      ? stage === "authenticating"
        ? { kind: "acknowledging" }
        : { kind: "reaching", caption: "connecting" }
      : error
        ? { kind: "apart", caption: "no answer · both autonomous" }
        : { kind: "apart", caption: "two autonomous nodes" }

  if (!roomy) {
    return (
      <ModalPanel title="Add a peer" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
        <box style={{ height: 1 }}>
          <text fg={colors.dim}>{settling ? "secure channel established:" : "address of the node to reach:"}</text>
        </box>
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={settling ? colors.success : colors.accent}>&gt; </text>
          {settling ? (
            <text fg={colors.success}>{`✓ ${linkedName}`}</text>
          ) : (
            <input
              ref={inputRef}
              focused={true}
              placeholder="host:port   e.g. 192.168.1.20:42001"
              textColor={colors.fg}
              style={{ flexGrow: 1 }}
              onSubmit={(value: unknown) => {
                const text = typeof value === "string" ? value : inputRef.current?.value ?? ""
                if (!busy) onConnect(text.trim())
              }}
            />
          )}
        </box>
        <box style={{ height: 1 }} />
        <box style={{ flexDirection: "row", height: 1 }}>
          {settling ? (
            <text fg={colors.success}>{`◉ union formed${animsEnabled() ? dotsFrame(tick) : ""}`}</text>
          ) : busy ? (
            <text fg={colors.warning}>{`connecting ${spinnerFrame(tick)}${animsEnabled() ? dotsFrame(tick) : ""}`}</text>
          ) : (
            <text fg={colors.online}>[Enter] Connect</text>
          )}
          <text fg={colors.dim}>   </text>
          {settling ? null : <text fg={colors.error}>[Esc] Cancel</text>}
        </box>
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={colors.error}>{error && !settling ? truncateErr(error, width - 4) : ""}</text>
        </box>
      </ModalPanel>
    )
  }

  return (
    <ModalPanel title="Add a peer" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
      <box style={{ height: 1 }}>
        <text fg={colors.dim}>{settling ? "secure channel established:" : "address of the node to reach:"}</text>
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={settling ? colors.success : colors.accent}>&gt; </text>
        {settling ? (
          <text fg={colors.success}>{`✓ ${linkedName}`}</text>
        ) : (
          <input
            ref={inputRef}
            focused={true}
            placeholder="host:port   e.g. 192.168.1.20:42001"
            textColor={colors.fg}
            style={{ flexGrow: 1 }}
            onSubmit={(value: unknown) => {
              const text = typeof value === "string" ? value : inputRef.current?.value ?? ""
              if (!busy) onConnect(text.trim())
            }}
          />
        )}
      </box>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row", justifyContent: "center", height: 3 }}>
        <UnionScene phase={phase} width={width - 6} />
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        {settling ? (
          <text fg={colors.success}>{`linked — opening conversation${motion ? dotsFrame(tick) : ""}`}</text>
        ) : busy ? (
          // The scene caption one row up already names the stage ("connecting…"
          // / "proving identity…"); repeating it here doubled the same words in
          // two rhythms. The bar alone carries the "work happening" signal.
          <text fg={colors.warning}>
            {motion ? `[${seekBar(width - 26, Math.floor(tick * 1.5))}]` : "…"}
          </text>
        ) : (
          <>
            <text fg={colors.online}>[Enter] Connect</text>
            <text fg={colors.dim}>   </text>
            <text fg={colors.error}>[Esc] Cancel</text>
          </>
        )}
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.error}>{error && !settling ? truncateErr(error, width - 4) : ""}</text>
      </box>
    </ModalPanel>
  )
}

function truncateErr(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}
