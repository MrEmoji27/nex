// Offscreen repro for the command interface: type, preview, submit, read back.
//
// Written because "buggy, does not read the input properly, shows incorrect
// results" cannot be chased by reading the code — the input renderable, the
// preview and the layout all interact, and only a real render shows what a
// person actually sees.
//
// Run: bun tests/render-commands.tsx
import { testRender } from "@opentui/react/test-utils"
import { createMockApp } from "../src/network/mock-transport"
import { NexTui } from "../src/ui/nex-tui"

const width = 100
const height = 32

const setup = await testRender(<NexTui app={await createMockApp()} />, { width, height })
const { mockInput, flush, captureCharFrame } = setup

const settle = () => Bun.sleep(60)

function show(label: string): void {
  const rows = captureCharFrame().split("\n").slice(0, height)
  console.log(`\n===== ${label} =====`)
  // Only the bottom of the screen matters here: panel, input, footer.
  for (const line of rows.slice(height - 14)) console.log(line.replace(/\s+$/, ""))
}

async function type(text: string): Promise<void> {
  for (const ch of text) {
    await mockInput.typeText(ch)
    await Bun.sleep(5)
  }
  await settle()
  await flush()
}

async function submit(): Promise<void> {
  await mockInput.pressKey("RETURN")
  await settle()
  await flush()
}

try {
  await flush()
  await mockInput.pressKey("RETURN") // home -> shell
  await settle()
  await flush()
  show("shell, empty input")

  await type("/")
  show('after typing "/"  — preview should list commands')

  await type("na")
  show('after "/na"  — preview should narrow to /name')

  await submit()
  show('submitted "/name" — should report the current name')

  await type("/help find")
  show('typed "/help find"')
  await submit()
  show("submitted — should explain /find only")

  await type("/fnd")
  await submit()
  show('submitted "/fnd" — should suggest /find')

  await type("/peers")
  await submit()
  show('submitted "/peers" — should list or say nobody')
} finally {
  setup.renderer.destroy?.()
  process.exit(0)
}
