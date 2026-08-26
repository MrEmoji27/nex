// Changelog modal — in-app viewer for doc/CHANGELOG.md.
// Parses the markdown at build/load time and renders a scrollable modal.
import { useEffect, useState } from "react"
import { useKeyboard } from "@opentui/react"
import { colors } from "./theme"
import { ModalPanel } from "./modal-panel"

interface ChangelogEntry {
  version: string
  date?: string
  items: string[]
}

function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let current: ChangelogEntry | null = null

  for (const line of md.split("\n")) {
    const headerMatch = line.match(/^##\s+\[(.+?)\]\s*[—-]\s*(.*)$/)
    if (headerMatch) {
      if (current) entries.push(current)
      const version = headerMatch[1]!.trim()
      const date = headerMatch[2]?.trim() || undefined
      current = {
        version,
        date,
        items: [],
      }
      continue
    }
    if (current && line.startsWith("- ")) {
      current.items.push(line.slice(2).trim())
    }
  }
  if (current) entries.push(current)
  return entries
}

async function loadChangelog(): Promise<ChangelogEntry[]> {
  try {
    const res = await fetch(
      new URL("../../doc/CHANGELOG.md", import.meta.url).toString(),
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const md = await res.text()
    return parseChangelog(md)
  } catch {
    return []
  }
}

function renderEntry(entry: ChangelogEntry, width: number) {
  return (
    <box key={entry.version} style={{ flexDirection: "column" }}>
      <box style={{ flexDirection: "row", height: 1 }}>
        <text fg={colors.accent}>{`▼ ${entry.version}`}</text>
        {entry.date !== undefined && entry.date !== null ? (
          <text fg={colors.textMuted}>{` — ${entry.date}`}</text>
        ) : null}
      </box>
      {entry.items.map((item, i) => (
        <box key={i} style={{ flexDirection: "row", height: 1, paddingLeft: 2 }}>
          <text fg={colors.textMuted}>{"· "}</text>
          <text fg={colors.text}>{item.slice(0, width - 6)}</text>
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
  const [entries, setEntries] = useState<ChangelogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const width = Math.min(76, Math.max(40, termWidth - 8))
  const height = Math.max(12, termHeight - 6)

  useEffect(() => {
    let mounted = true
    loadChangelog()
      .then((entries) => {
        if (mounted) {
          setEntries(entries)
          setLoading(false)
        }
      })
      .catch(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  useKeyboard((key) => {
    if (key.name === "escape") onClose()
  })

  if (loading) {
    return (
      <ModalPanel title="Changelog" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
        <box style={{ flexDirection: "column", paddingTop: 2 }}>
          <text fg={colors.accent}>loading changelog…</text>
        </box>
      </ModalPanel>
    )
  }

  return (
    <ModalPanel title="Changelog" termWidth={termWidth} termHeight={termHeight} width={width} height={height}>
      <scrollbox style={{ height: height - 4, width: "100%" }} scrollY>
        {entries.length === 0 ? (
          <box style={{ flexDirection: "column", paddingTop: 2 }}>
            <text fg={colors.textMuted}>changelog unavailable</text>
          </box>
        ) : (
          entries.map((entry) => renderEntry(entry, width))
        )}
      </scrollbox>
    </ModalPanel>
  )
}