// Debug: watch all events on three nodes during a vouch.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = [mkdtempSync(join(tmpdir(), "dbg-a-")), mkdtempSync(join(tmpdir(), "dbg-b-")), mkdtempSync(join(tmpdir(), "dbg-c-"))]

function pump(name: string, stream: any): void {
  const dec = new TextDecoder()
  let buf = ""
  const feed = (chunk: any) => {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true })
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line.startsWith("{")) console.log(`[${name}]`, line.slice(0, 220))
    }
  }
  if (stream?.getReader) {
    ;(async () => {
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        feed(value)
      }
    })()
  } else if (stream?.on) {
    stream.setEncoding("utf8")
    stream.on("data", feed)
  }
}

function start(name: string, port: number, dir: string): ChildProcess {
  const proc = spawn(process.execPath, ["run", "headless", "--", "--name", name, "--port", String(port), "--data-dir", dir], { stdio: ["pipe", "pipe", "inherit"] })
  pump(name, proc.stdout)
  return proc
}

const a = start("zro", 43161, roots[0]!)
const b = start("roshan", 43162, roots[1]!)
const c = start("cku", 43163, roots[2]!)

await Bun.sleep(1500)
a.stdin?.write("/connect localhost:43162\n")
await Bun.sleep(1200)
c.stdin?.write("/connect localhost:43161\n")
await Bun.sleep(1200)
console.log("=== peers at a ===")
a.stdin?.write("/peers\n")
await Bun.sleep(600)
console.log("=== vouch ===")
a.stdin?.write("/vouch cku roshan\n")
await Bun.sleep(3000)

for (const p of [a, b, c]) p.kill()
process.exit(0)
