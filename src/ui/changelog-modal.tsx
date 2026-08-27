// Changelog modal — in-app viewer for the published CHANGELOG.md.
//
// The markdown is imported, not fetched. It used to be read at runtime from
// `doc/CHANGELOG.md` through `new URL(..., import.meta.url)`, which was wrong
// twice over: `doc/` is not shipped by the installer, so an installed build
// showed "changelog unavailable" and nothing else — and `doc/CHANGELOG.md` was
// a stale development copy while the root CHANGELOG.md is the one that is
// published and kept in step with the website.
//
// A build-time import ends both problems at once. Bun embeds the text in the
// compiled binary, so there is no file to locate at runtime, no failure mode
// that depends on where the app was installed, and no second copy to drift.
import changelogMarkdown from "../../CHANGELOG.md" with { type: "text" }
import { useKeyboard } from "@opentui/react"
import { parseChangelog, wrap, type ChangelogEntry } from "./changelog-parse"
import { colors } from "./theme"
import { ModalPanel } from "./modal-panel"

const ENTRIES: ChangelogEntry[] = parseChangelog(changelogMarkdown)

function renderEntry(entry: ChangelogEntry, width: number) {
  const textWidth = width - 8
  return (
    <box key={entry.version} style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.accent}>{`▼ ${entry.version}`}</text>
        {entry.date ? <text fg={colors.textMuted}>{` — ${entry.date}`}</text> : null}
      </box>
      {entry.sections.map((section, s) => (
        <box key={s} style={{ flexDirection: "column" }}>
          {section.label ? (
            <box style={{ flexDirection: "row", height: 1, paddingLeft: 2 }}>
              <text fg={colors.textMuted}>{section.label}</text>
            </box>
          ) : null}
          {section.items.map((item, i) =>
            wrap(item, textWidth).map((line, l) => (
              <box key={`${i}-${l}`} style={{ flexDirection: "row", height: 1, paddingLeft: 4 }}>
                <text fg={colors.textMuted}>{l === 0 ? "· " : "  "}</text>
                <text fg={colors.text}>{line}</text>
              </box>
            )),
          )}
        </box>
      ))}
      <box style={{ height: 1 }} />
    </box>
  )
}

export function ChangelogModal(props: {
  termWidth: number
  termHeight: number
  onClose(): void
}) {
  const { termWidth, termHeight, onClose } = props
  const width = Math.min(76, Math.max(40, termWidth - 8))
  const height = Math.max(12, termHeight - 6)

  useKeyboard((key) => {
    if (key.name === "escape") onClose()
  })

  return (
    <ModalPanel title="Changelog" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
      <scrollbox style={{ height: height - 4, width: "100%" }} scrollY>
        {ENTRIES.length === 0 ? (
          <box style={{ flexDirection: "column", paddingTop: 2 }}>
            <text fg={colors.textMuted}>changelog unavailable</text>
          </box>
        ) : (
          ENTRIES.map((entry) => renderEntry(entry, width))
        )}
      </scrollbox>
    </ModalPanel>
  )
}
