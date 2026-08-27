// The strip directly above the input line.
//
// It does two jobs, and both are answers to the same complaint: you could not
// see what the commands were, and you could not see what they did.
//
//   - While a command is being typed, it previews what matches.
//   - Otherwise it shows what the last few commands actually said.
//
// Command results used to go to the footer: one line, truncated to whatever was
// left after the keymap, in red, for four seconds. From the outside that is
// indistinguishable from a command doing nothing at all — which is exactly how
// it was reported.
import { colors, truncate } from "./theme"
import { matchCommands, usage, type CommandSpec } from "./commands"

/** One line of command output, oldest first. */
export interface LogLine {
  text: string
  tone: "ok" | "bad"
  at: number
}

const MAX_PREVIEW = 6
const MAX_LOG = 6

export function CommandPanel(props: {
  /** Current input text; drives the preview when it starts with "/". */
  draft: string
  log: readonly LogLine[]
  width: number
}) {
  const { draft, log, width } = props
  const typing = draft.startsWith("/")

  if (typing) {
    const typed = draft.slice(1).split(/\s+/)[0] ?? ""
    const matches = matchCommands(typed)
    return <Preview typed={typed} matches={matches} width={width} />
  }
  if (log.length === 0) return null
  return <Log log={log.slice(-MAX_LOG)} width={width} />
}

function Preview(props: { typed: string; matches: CommandSpec[]; width: number }) {
  const { typed, matches, width } = props
  const shown = matches.slice(0, MAX_PREVIEW)
  const rest = matches.length - shown.length

  return (
    <box
      style={{
        width,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: colors.surface,
      }}
    >
      {shown.length === 0 ? (
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={colors.textMuted}>{`no command starts with "${typed}"`}</text>
        </box>
      ) : (
        shown.map((spec) => (
          <box key={spec.name} style={{ height: 1, flexDirection: "row" }}>
            <text fg={colors.accent}>{pad(usage(spec), 26)}</text>
            <text fg={colors.textMuted}>{truncate(spec.summary, Math.max(8, width - 30))}</text>
          </box>
        ))
      )}
      {rest > 0 ? (
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={colors.dim}>{`  +${rest} more — keep typing, or /help`}</text>
        </box>
      ) : null}
    </box>
  )
}

function Log(props: { log: readonly LogLine[]; width: number }) {
  const { log, width } = props
  return (
    <box
      style={{
        width,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: colors.surface,
      }}
    >
      {log.map((line, i) => (
        <box key={`${line.at}-${i}`} style={{ height: 1, flexDirection: "row" }}>
          <text fg={line.tone === "bad" ? colors.error : colors.dim}>{line.tone === "bad" ? "! " : "· "}</text>
          <text fg={line.tone === "bad" ? colors.error : colors.text}>
            {truncate(line.text, Math.max(8, width - 4))}
          </text>
        </box>
      ))}
    </box>
  )
}

function pad(text: string, to: number): string {
  return text.length >= to ? `${text.slice(0, to - 1)} ` : text + " ".repeat(to - text.length)
}
