// Offscreen render smoke for the v2 UI: home → shell → settings modal → theme cycle.
// Run: bun tests/render-smoke.tsx
import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/react/test-utils"
import { createMockApp } from "../src/network/mock-transport"
import { NexTui } from "../src/ui/nex-tui"

const width = 100
const height = 32

const setup = await testRender(<NexTui app={await createMockApp()} />, { width, height })
const { renderer, mockInput, flush, captureCharFrame } = setup

function show(label: string): void {
  const frame = captureCharFrame()
  // Frames embed a trailing newline per row — split, don't width-slice.
  const rows = frame.split("\n").slice(0, height)
  console.log(`\n===== ${label} =====`)
  for (const line of rows) console.log(line.replace(/\s+$/, ""))
}

const settle = () => Bun.sleep(50)

try {
  await flush()
  show("HOME")

  await mockInput.pressKey("RETURN")
  await settle()
  await flush()
  show("APP SHELL (after Enter)")

  // Back out to HOME, then open Settings from there.
  await mockInput.pressKey("ESCAPE")
  await settle()
  await flush()
  show("BACK TO HOME (Esc)")

  await mockInput.pressKey("s")
  await settle()
  await flush()
  show("SETTINGS MODAL (s)")

  await mockInput.pressKey("ARROW_RIGHT")
  await settle()
  await flush()
  show("THEME cycled RIGHT (Nex Dark -> Nex Light)")

  await mockInput.pressKey("ARROW_DOWN")
  await settle()
  await flush()
  show("RETENTION cycled DOWN (forever -> 24h)")

  await mockInput.pressKey("ESCAPE")
  await settle()
  await flush()
  show("MODAL CLOSED (Esc)")

  renderer.destroy()
} catch (err) {
  renderer.destroy()
  throw err
}
