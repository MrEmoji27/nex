// The in-app changelog, parsed from the file that actually ships.
//
// This is checked against the REAL CHANGELOG.md rather than a fixture, because
// the failure being guarded against is not "the parser has a bug" — it is "the
// app and the website disagree about what shipped". The website is generated
// from the same file. A fixture would keep passing while the real file grew a
// heading shape this parser silently drops.
import { describe, expect, test } from "bun:test"
import changelogMarkdown from "../CHANGELOG.md" with { type: "text" }
import { parseChangelog, plain, wrap } from "../src/ui/changelog-parse"

const entries = parseChangelog(changelogMarkdown)

describe("the published changelog", () => {
  test("the markdown is embedded at build time, not read from disk", () => {
    // The old modal fetched doc/CHANGELOG.md at runtime. doc/ is not shipped by
    // the installer, so an installed build could only ever show "changelog
    // unavailable". An import cannot fail that way.
    expect(typeof changelogMarkdown).toBe("string")
    expect(changelogMarkdown.length).toBeGreaterThan(1000)
  })

  test("every release in the file is parsed", () => {
    const versions = entries.map((e) => e.version)
    // Sampled across the file's history so a change to any one heading style
    // is caught, not just the newest.
    expect(versions).toContain("3.0.0-alpha.3")
    expect(versions).toContain("3.0.0-alpha.2")
    expect(versions).toContain("2.0.0-alpha.7")
    expect(versions).toContain("1.0.0")
    expect(versions.length).toBeGreaterThanOrEqual(10)
  })

  test("the newest release keeps its version, date and sections", () => {
    // Deliberately not pinned to a version: this asserts the shape of whatever
    // is newest, so cutting a release does not break the parser's test. An
    // earlier version of this test named alpha.3 and failed the moment alpha.4
    // was written — which said nothing about the parser.
    const latest = entries[0]!
    expect(latest.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(latest.sections.length).toBeGreaterThan(0)
    expect(latest.sections.map((s) => s.label)).toContain("Summary")
  })

  test("a release with a limits section keeps it", () => {
    // alpha.3 is the release whose honest headline is what does NOT work yet.
    // An app showing only "Added" would be making a claim the notes do not.
    const nat = entries.find((e) => e.version === "3.0.0-alpha.3")!
    const labels = nat.sections.map((s) => s.label)
    expect(labels).toContain("Added")
    expect(labels).toContain("Fixed")
    expect(labels).toContain("Known limits")
  })

  test("no release parses to nothing", () => {
    // A version heading followed by no readable bullets means the file grew a
    // shape this parser does not understand.
    for (const entry of entries) {
      const items = entry.sections.flatMap((s) => s.items)
      expect({ version: entry.version, items: items.length }).toEqual({
        version: entry.version,
        items: items.length,
      })
      expect(items.length).toBeGreaterThan(0)
    }
  })

  test("a bullet folded across lines is joined, not truncated", () => {
    const nat = entries.find((e) => e.version === "3.0.0-alpha.3")!
    const limits = nat.sections.find((s) => s.label === "Known limits")!
    const unproven = limits.items.find((i) => i.startsWith("NAT traversal is unproven"))
    expect(unproven).toBeTruthy()
    // The source folds this item over three lines; reading only the first would
    // stop at "one" and lose the point of the sentence.
    expect(unproven).toContain("private address")
    expect(unproven).not.toContain("\n")
  })
})

describe("markdown a terminal cannot render", () => {
  test("bold, code and links become their words", () => {
    expect(plain("**NAT traversal is unproven.** Everything so far")).toBe(
      "NAT traversal is unproven. Everything so far",
    )
    expect(plain("run `nex headless` first")).toBe("run nex headless first")
    expect(plain("see [the runbook](https://example.com/x)")).toBe("see the runbook")
  })

  test("no asterisks or backticks survive into the rendered items", () => {
    for (const entry of entries) {
      for (const item of entry.sections.flatMap((s) => s.items)) {
        expect(item).not.toContain("**")
        expect(item).not.toContain("`")
      }
    }
  })
})

describe("wrapping to the terminal", () => {
  test("lines stay inside the column", () => {
    for (const line of wrap("a".repeat(10) + " " + "b".repeat(30) + " short", 20)) {
      expect(line.length).toBeLessThanOrEqual(20)
    }
  })

  test("words are kept whole when they fit", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
  })

  test("a word longer than the column is broken rather than lost", () => {
    // Left whole it would be clipped to nothing by the renderer, which reads as
    // a missing line rather than a long one.
    expect(wrap("x".repeat(25), 10)).toEqual(["xxxxxxxxxx", "xxxxxxxxxx", "xxxxx"])
  })

  test("every real changelog item wraps inside a narrow terminal", () => {
    for (const entry of entries) {
      for (const item of entry.sections.flatMap((s) => s.items)) {
        for (const line of wrap(item, 32)) expect(line.length).toBeLessThanOrEqual(32)
      }
    }
  })
})
