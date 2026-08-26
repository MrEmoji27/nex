// SETTINGS modal (vision §15/§12): cycle theme + retention with ←/→.
// Retention semantics are stated honestly: local expiry only — your copy,
// not theirs (vision §12 "Recommended initial semantics").
import type { RetentionPolicy, Settings, StorageSecurity } from "../core/contract.ts"
import { colors } from "./theme"
import { THEMES, getTheme } from "./theme"
import { ModalPanel } from "./modal-panel"

const RETENTION_ORDER: RetentionPolicy[] = ["24h", "7d", "forever"]

export const RETENTION_LABELS: Record<RetentionPolicy, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  forever: "Keep permanently",
}

/** Cycle helper shared by the modal and the /theme · /retention commands. */
export function nextIn<T>(list: readonly T[], current: T | undefined, dir: 1 | -1, fallbackIndex = 0): T {
  const idx = current == null ? fallbackIndex : list.indexOf(current)
  const base = idx < 0 ? fallbackIndex : idx
  return list[(base + dir + list.length) % list.length]!
}

export function SettingsModal(props: {
  settings: Settings
  storageSecurity: StorageSecurity
  termWidth: number
  termHeight: number
  onCycleTheme(dir: 1 | -1): void
  onCycleRetention(dir: 1 | -1): void
  onClose(): void
}) {
  const { settings, storageSecurity, termWidth, termHeight, onCycleTheme, onCycleRetention, onClose } = props
  const width = Math.min(56, Math.max(36, termWidth - 8))
  const height = termHeight < 20 ? 9 : 12
  const themeName = getTheme(settings.theme).name

  return (
    <ModalPanel title="Settings" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.textMuted}>THEME      </text>
        <text fg={colors.dim}>{"← "}</text>
        <text fg={colors.heading}>{themeName}</text>
        <text fg={colors.dim}>{" →"}</text>
      </box>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.textMuted}>RETENTION  </text>
        <text fg={colors.dim}>{"← "}</text>
        <text fg={colors.heading}>{RETENTION_LABELS[settings.retention ?? "forever"]}</text>
        <text fg={colors.dim}>{" →"}</text>
      </box>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.textMuted}>{`${" ".repeat(11)}local only — expires YOUR copy, not theirs`}</text>
      </box>
      <box style={{ height: 1 }} />
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.textMuted}>STORAGE    </text>
        {storageSecurity === "passphrase" ? (
          <text fg={colors.success}>PASSPHRASE ENCRYPTED</text>
        ) : storageSecurity === "device-key" ? (
          <text fg={colors.accent}>ENCRYPTED · DEVICE KEY</text>
        ) : (
          <text fg={colors.warning}>NOT ENCRYPTED (--plaintext)</text>
        )}
      </box>
      {storageSecurity === "passphrase" ? (
        <box style={{ flexDirection: "row", height: 1 }}>
          <text fg={colors.warning}>{`${" ".repeat(11)}lose the passphrase = data gone forever`}</text>
        </box>
      ) : null}
      <box style={{ flexGrow: 1 }} />
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.accent}>[←/→] change</text>
        <text fg={colors.textMuted}>   </text>
        <text fg={colors.textMuted}>[Esc] Close</text>
      </box>
    </ModalPanel>
  )
}

export { RETENTION_ORDER }
