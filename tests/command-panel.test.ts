// The panel above the input, and the one rule it must never break.
//
// The panel is drawn INSIDE a height budget the caller subtracts from the panes
// above it. The first version sized itself instead, and a six-line preview
// pushed the input line off the bottom of the terminal — so typing "/" hid the
// field you were typing into, which is what "it does not read my input" turned
// out to mean.
//
// Every test here is therefore about the count of lines, not their prose.
import { describe, expect, test } from "bun:test"
import { panelLines, type LogLine } from "../src/ui/command-panel"
import { COMMANDS } from "../src/ui/commands"

const WIDTH = 100
const log = (n: number): LogLine[] =>
  Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, tone: "ok" as const, at: i }))

describe("the height budget is never exceeded", () => {
  test("a preview of every command still fits the budget", () => {
    // There are far more commands than rows. This is the case that broke.
    expect(COMMANDS.length).toBeGreaterThan(7)
    for (const max of [0, 1, 3, 7]) {
      expect(panelLines("/", [], WIDTH, max).length).toBeLessThanOrEqual(max)
    }
  })

  test("a long log still fits the budget", () => {
    for (const max of [0, 1, 3, 7]) {
      expect(panelLines("", log(50), WIDTH, max).length).toBeLessThanOrEqual(max)
    }
  })

  test("a budget of zero draws nothing at all", () => {
    expect(panelLines("/", log(20), WIDTH, 0)).toEqual([])
  })
})

describe("what it chooses to show", () => {
  test("the log shows the NEWEST lines", () => {
    const lines = panelLines("", log(10), WIDTH, 3)
    expect(lines.map((l) => l.text)).toEqual(["line 7", "line 8", "line 9"])
  })

  test("the preview narrows as you type", () => {
    const all = panelLines("/", [], WIDTH, 7).length
    const narrowed = panelLines("/na", [], WIDTH, 7)
    expect(narrowed.length).toBeLessThan(all)
    expect(narrowed[0]!.text).toContain("/name")
  })

  test("a truncated preview says how many it hid, counting the row it replaced", () => {
    // The last row becomes the "and N more" line, so the count has to include
    // the entry that row was going to show — off by one here means the number
    // is a lie.
    const max = 3
    const lines = panelLines("/", [], WIDTH, max)
    expect(lines).toHaveLength(max)
    expect(lines[max - 1]!.text).toContain(`${COMMANDS.length - (max - 1)} more`)
  })

  test("typing something that matches nothing says so, in one line", () => {
    const lines = panelLines("/zzzz", [], WIDTH, 7)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toContain("no command starts with")
  })

  test("a command being typed takes precedence over the log", () => {
    const lines = panelLines("/fi", log(5), WIDTH, 5)
    expect(lines.some((l) => l.text.includes("/find"))).toBe(true)
    expect(lines.some((l) => l.text.startsWith("line"))).toBe(false)
  })

  test("plain text is not treated as a command", () => {
    const lines = panelLines("hello there", log(2), WIDTH, 5)
    expect(lines.map((l) => l.text)).toEqual(["line 0", "line 1"])
  })
})

describe("narrow terminals", () => {
  test("lines are truncated to the width, never wider", () => {
    const wide: LogLine[] = [{ text: "x".repeat(400), tone: "ok", at: 0 }]
    for (const width of [20, 40, 100]) {
      for (const line of panelLines("", wide, width, 5)) {
        expect(line.text.length).toBeLessThanOrEqual(Math.max(8, width - 4))
      }
    }
  })
})
