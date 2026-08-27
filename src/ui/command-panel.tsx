// The strip directly above the input line.
//
// It does two jobs, and both answer the same complaint: you could not see what
// the commands were, and you could not see what they did.
//
//   - While a command is being typed, it previews what matches.
//   - Otherwise it shows what the last few commands actually said.
//
// Command results used to go to the footer: one line, truncated to whatever was
// left after the keymap, in red, for four seconds. From the outside that is
// indistinguishable from a command doing nothing — which is how it was
// reported.
//
// The caller decides how tall this is, and must subtract that height from the
// panes above. The first version let the panel grow on its own and pushed the
// INPUT LINE off the bottom of the terminal, so typing "/" made the thing you
// were typing into disappear.
import { colors, truncate } from "./theme"
import { matchCommands, usage } from "./commands"

/** One line of command output, oldest first. */
export interface LogLine {
  text: string
  tone: "ok" | "bad"
  at: number
}

export interface PanelLine {
  text: string
  tone: "ok" | "bad" | "hint"
}

/**
 * Exactly the lines to draw, at most `max` of them.
 *
 * Preview takes the FIRST matches (alphabetical by registry order, which is
 * "what a new node needs first"); the log takes the LAST lines, because the
 * newest output is the one being read.
 */
export function panelLines(
  draft: string,
  log: readonly LogLine[],
  width: number,
  max: number,
): PanelLine[] {
  if (max <= 0) return []
  const room = Math.max(8, width - 4)

  if (draft.startsWith("/")) {
    const typed = draft.slice(1).split(/\s+/)[0] ?? ""
    const matches = matchCommands(typed)
    if (matches.length === 0) {
      return [{ text: `no command starts with "${typed}" — /help lists them`, tone: "hint" }]
    }
    const shown = matches.slice(0, max)
    const lines: PanelLine[] = shown.map((spec) => ({
      text: `${pad(usage(spec), 26)}${truncate(spec.summary, Math.max(8, room - 26))}`,
      tone: "hint",
    }))
    const rest = matches.length - shown.length
    if (rest > 0 && lines.length === max) {
      lines[max - 1] = { text: `…and ${rest + 1} more — keep typing, or /help`, tone: "hint" }
    }
    return lines
  }

  return log.slice(-max).map((line) => ({
    text: truncate(line.text, room),
    tone: line.tone,
  }))
}

export function CommandPanel(props: { lines: readonly PanelLine[]; width: number }) {
  const { lines, width } = props
  if (lines.length === 0) return null
  return (
    <box
      style={{
        width,
        height: lines.length,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: colors.surface,
      }}
    >
      {lines.map((line, i) => (
        <box key={i} style={{ height: 1, flexDirection: "row" }}>
          <text fg={line.tone === "bad" ? colors.error : line.tone === "hint" ? colors.accent : colors.dim}>
            {line.tone === "bad" ? "! " : line.tone === "hint" ? "  " : "· "}
          </text>
          <text fg={line.tone === "bad" ? colors.error : line.tone === "hint" ? colors.textMuted : colors.text}>
            {line.text}
          </text>
        </box>
      ))}
    </box>
  )
}

function pad(text: string, to: number): string {
  return text.length >= to ? `${text.slice(0, to - 1)} ` : text + " ".repeat(to - text.length)
}
