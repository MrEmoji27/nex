// TUI entrypoint.
// CLI flags override env: --name/-n, --port/-p, --data-dir/-d, --mock
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { NexApp } from "../core/contract.ts"
import { NexTui } from "../ui/nex-tui"
import { parseArgs } from "./args"

const args = parseArgs(process.argv.slice(2))
const MOCK_ENV = process.env.NEX_MOCK ?? "0"

async function loadApp(): Promise<{ app: NexApp; mock: boolean }> {
  if (args.mock || MOCK_ENV === "1") {
    const { createMockApp } = await import("../network/mock-transport")
    return { app: await createMockApp(), mock: true }
  }
  const { createNodeApp } = await import("./node-app")
  const { app, storageSecurity } = await createNodeApp({
    name: args.name ?? process.env.NEX_NAME,
    port: args.port ?? (process.env.NEX_PORT ? Number(process.env.NEX_PORT) : undefined),
    dataDir: args.dataDir ?? process.env.NEX_DATA_DIR,
    passphrase: args.passphrase ?? process.env.NEX_PASSPHRASE,
    plaintext: args.plaintext || process.env.NEX_PLAINTEXT === "1",
  })
  void storageSecurity
  return { app, mock: false }
}

async function main() {
  const { app } = await loadApp().catch((err) => {
    console.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let exited = false

  const shutdown = async () => {
    if (exited) return
    exited = true
    renderer?.destroy() // lifecycle rule: destroy on EVERY exit path
    await app.shutdown().catch(() => {})
    process.exit(0)
  }

  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())

  renderer = await createCliRenderer({ exitOnCtrlC: false })
  createRoot(renderer).render(<NexTui app={app} />)
}

await main()
