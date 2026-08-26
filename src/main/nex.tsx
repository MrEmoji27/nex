// Unified `nex` entrypoint for compiled distribution (bun --compile).
//
//   nex                     -> TUI (installed mode: data in ~/.nex/data)
//   nex headless            -> headless JSON node
//   nex mock                -> TUI against the scripted demo app
//   nex --name zro --port 42101 ... (same flags everywhere)
//
// Installed-mode detection: when running from a compiled binary there is no
// project checkout, so the default data dir moves from ./data/local to
// ~/.nex/data. Explicit --data-dir always wins. NEX_DEV=1 keeps the old
// behavior for repo runs.
import { parseArgs } from "./args"

const argv = process.argv.slice(2)
const first = argv[0]
const MODE =
  first === "headless" || first === "mock" || first === "help" || first === "--help" || first === "-h"
    ? first
    : "tui"
if (MODE !== "tui") argv.shift()

function homeDataDir(): string {
  // Bun on Windows: USERPROFILE; POSIX: HOME.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "."
  const sep = process.platform === "win32" ? "\\" : "/"
  return `${home}${sep}.nex${sep}data`
}

async function main() {
  if (MODE === "help" || MODE === "--help" || MODE === "-h") {
    printHelp()
    return
  }
  const args = parseArgs(argv)
  const installed = !process.env.NEX_DEV && !args.dataDir
  if (!args.dataDir) {
    args.dataDir = installed ? homeDataDir() : undefined
  }

  const common = {
    name: args.name ?? process.env.NEX_NAME,
    port: args.port ?? (process.env.NEX_PORT ? Number(process.env.NEX_PORT) : undefined),
    dataDir: args.dataDir,
    passphrase: args.passphrase ?? process.env.NEX_PASSPHRASE,
    plaintext: args.plaintext || process.env.NEX_PLAINTEXT === "1",
  }

  if (MODE === "headless") {
    const { runHeadless } = await import("./headless")
    await runHeadless({ ...common, mock: false }).catch((err) => fail(err))
    return
  }

  // TUI or mock
  if (MODE === "mock") process.env.NEX_MOCK = "1"
  const { createCliRenderer } = await import("@opentui/core")
  const { createRoot } = await import("@opentui/react")
  const { NexTui } = await import("../ui/nex-tui")

  let app
  let mock = false
  try {
    if (MODE === "mock" || process.env.NEX_MOCK === "1") {
      const { createMockApp } = await import("../network/mock-transport")
      app = await createMockApp({ port: common.port, name: common.name })
      mock = true
    } else {
      const { createNodeApp } = await import("./node-app")
      const built = await createNodeApp(common)
      app = built.app
    }
  } catch (err) {
    fail(err)
  }

  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | null = null
  let exited = false
  const shutdown = async () => {
    if (exited) return
    exited = true
    renderer?.destroy()
    await app.shutdown().catch(() => {})
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  if (mock) console.error("mock mode: scripted peers, nothing leaves this machine")

  renderer = await createCliRenderer({ exitOnCtrlC: false })
  createRoot(renderer).render(<NexTui app={app} />)
}

function fail(err: unknown): never {
  console.error(`failed to start: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

function printHelp(): void {
  console.log(`Nex ${"— terminal-native p2p communication"}

Usage:
  nex                    open the chat interface
  nex headless           run a headless node (JSON lines on stdout)
  nex mock               demo mode with scripted peers (offline)
  nex help               this text

Options:
  -n, --name <name>        your display name
  -p, --port <port>        listen port (default 42001)
  -d, --data-dir <dir>     state directory (default: ~/.nex/data when installed)
      --passphrase <s>     protective vault tier (unrecoverable if lost)
      --plaintext          disable local encryption (not recommended)

First steps inside the TUI:
  a                add someone by host:port
  /room lounge     host a group room
  c                join the room's voice channel

Home of the source: see NEX.md`)
}

main().catch((err: unknown) => fail(err))
