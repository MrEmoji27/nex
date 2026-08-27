// Turning CHANGELOG.md into something a terminal can show.
//
// Kept apart from the modal so it can be tested without a renderer. The
// markdown it parses is a published artifact — the website is generated from
// the same file — so a parser that quietly drops half an entry produces an app
// that disagrees with the site about what shipped.
//
// Two things this has to get right, both learned by running it against the real
// file rather than a fixture:
//
//   - Markdown folds long lines, and **emphasis** folds with them. Stripping
//     per line leaves half a pair behind, so text is joined FIRST and cleaned
//     after.
//   - Not every section is a bullet list. The summary of a release is a
//     paragraph, and it is the part a person most wants to read; a parser that
//     only understood bullets showed some releases as empty.

export interface ChangelogSection {
  /** "Summary", "Added", "Fixed"… or "" for text before any heading. */
  label: string
  items: string[]
}

export interface ChangelogEntry {
  version: string
  date?: string
  sections: ChangelogSection[]
}

/** Strip the markdown a terminal cannot render, leaving the words. */
export function plain(text: string): string {
  return text
    .replace(/\[(.+?)\]\((?:.+?)\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

export function parseChangelog(md: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  let entry: ChangelogEntry | null = null
  let section: ChangelogSection | null = null
  /** Raw lines of the item being accumulated; cleaned only when it closes. */
  let open: string[] = []

  const closeItem = () => {
    if (open.length === 0) return
    const text = plain(open.join(" "))
    if (text && section) section.items.push(text)
    open = []
  }
  const sectionFor = (label: string): ChangelogSection => {
    const next: ChangelogSection = { label, items: [] }
    entry!.sections.push(next)
    return next
  }

  for (const raw of md.split("\n")) {
    const line = raw.trimEnd()

    // "## [3.0.0-alpha.3] - 2026-08-27", with either kind of dash.
    const header = line.match(/^##\s+\[(.+?)\]\s*(?:[—-]\s*(.*))?$/)
    if (header) {
      closeItem()
      if (entry) entries.push(entry)
      entry = { version: header[1]!.trim(), date: header[2]?.trim() || undefined, sections: [] }
      section = null
      continue
    }
    if (!entry) continue

    const sub = line.match(/^###\s+(.+)$/)
    if (sub) {
      closeItem()
      section = sectionFor(plain(sub[1]!))
      continue
    }
    // Any other heading, or a horizontal rule, ends the current thought.
    if (/^#{1,6}\s/.test(line) || /^-{3,}$/.test(line)) {
      closeItem()
      continue
    }
    if (!line.trim()) {
      closeItem()
      continue
    }

    if (!section) section = sectionFor("")

    if (/^[-*]\s+/.test(line)) {
      closeItem()
      open.push(line.replace(/^[-*]\s+/, ""))
      continue
    }
    // A folded bullet, or a paragraph such as a release summary. Both are worth
    // keeping and both continue until a blank line.
    open.push(line.replace(/^>\s?/, ""))
  }
  closeItem()
  if (entry) entries.push(entry)

  // Sections that turned out to hold nothing (a heading with only a rule under
  // it) would render as a label with no body.
  for (const e of entries) e.sections = e.sections.filter((s) => s.items.length > 0)
  return entries
}

/** Break one bullet across the available width, on word boundaries. */
export function wrap(text: string, width: number): string[] {
  if (width < 8) return [text.slice(0, Math.max(1, width))]
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`
    else {
      lines.push(line)
      line = word
    }
    // A single word longer than the column is hard-broken rather than left to
    // be clipped to nothing by the renderer.
    while (line.length > width) {
      lines.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line) lines.push(line)
  return lines
}
