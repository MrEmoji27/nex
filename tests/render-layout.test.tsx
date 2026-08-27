// The interface fits the terminal.
//
// This exists because the same mistake was made twice in one day. The command
// preview pushed the input line off the bottom of the screen; the fix for that
// was a height budget; adding the status line then pushed the input box's
// closing border off the bottom, because the budget was not updated. Neither
// was visible in the code — both were obvious the moment something was drawn.
//
// So every assertion here is about the FRAME, not the component tree: the last
// row of a terminal is the one that tells you whether the layout lied.
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { createMockApp } from "../src/network/mock-transport"
import { NexTui } from "../src/ui/nex-tui"

// 80x24 is the size that exposed all of this and the one nothing was rendering.
const SIZES = [
  { width: 80, height: 24 },
  { width: 100, height: 30 },
  { width: 120, height: 40 },
  { width: 64, height: 20 },
]

async function frameAt(size: { width: number; height: number }, typed?: string) {
  const setup = await testRender(<NexTui app={await createMockApp()} />, size)
  const { mockInput, flush, captureCharFrame } = setup
  await flush()
  await mockInput.pressKey("RETURN") // home -> shell
  await Bun.sleep(60)
  if (typed) {
    await mockInput.typeText(typed)
    await Bun.sleep(60)
  }
  await flush()
  const rows = captureCharFrame().split("\n").slice(0, size.height)
  return rows.map((r) => r.replace(/\s+$/, ""))
}

describe("the shell fits its terminal", () => {
  for (const size of SIZES) {
    test(`the input box closes at ${size.width}x${size.height}`, async () => {
      const rows = await frameAt(size)
      const last = rows.filter((r) => r.length > 0).at(-1) ?? ""
      // The bottom border of the input box. If the layout overflows, this row
      // is off-screen and the app looks like it is missing its input.
      expect(last).toContain("└")
      expect(last).toContain("┘")
    }, 20_000)

    test(`nothing is wider than the terminal at ${size.width}x${size.height}`, async () => {
      const rows = await frameAt(size)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(size.width)
    }, 20_000)
  }

  test("the command preview does not push the input away", async () => {
    // Typing "/" adds rows above the input. They have to come out of the panes,
    // not off the bottom of the screen.
    const rows = await frameAt({ width: 80, height: 24 }, "/")
    const last = rows.filter((r) => r.length > 0).at(-1) ?? ""
    expect(last).toContain("┘")
    expect(rows.some((r) => r.includes("/rendezvous"))).toBe(true)
  }, 20_000)
})

describe("the panels are closed boxes", () => {
  test("the conversation panel has a right-hand edge", async () => {
    // It did not, at any width: flexGrow overflowed by one column and the
    // closing border was drawn off-screen, so the main panel of the app looked
    // half-rendered.
    const rows = await frameAt({ width: 80, height: 24 })
    const top = rows.find((r) => r.includes("┌─PEOPLE"))
    expect(top).toBeTruthy()
    expect(top!.endsWith("┐")).toBe(true)
  }, 20_000)
})

describe("the status line is always there", () => {
  test("it names you and says whether you are findable", async () => {
    const rows = await frameAt({ width: 80, height: 24 })
    const status = rows.find((r) => r.includes("published"))
    expect(status).toBeTruthy()
  }, 20_000)
})
