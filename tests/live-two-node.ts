// Live two-node smoke over real TCP through the real headless entrypoints.
// Run manually (not part of `bun test`): bun tests/live-two-node.ts
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = [
  mkdtempSync(join(tmpdir(), "nex-live-a-")),
  mkdtempSync(join(tmpdir(), "nex-live-b-")),
]

interface Node {
  proc: ChildProcess
  lines: string[]
  waiters: Array<{ test: (line: any) => boolean; resolve: (line: any) => void }>
  send(text: string): void
}

function startNode(name: string, port: number, dataDir: string): Node {
  const proc = spawn(
    process.execPath,
    ["run", "headless", "--", "--name", name, "--port", String(port), "--data-dir", dataDir],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const node: Node = {
    proc,
    lines: [],
    waiters: [],
    send(text) {
      proc.stdin!.write(`${text}\n`)
    },
  }
  let buffer = ""
  proc.stdout!.setEncoding("utf8")
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk
    let idx: number
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!raw) continue
      try {
        const parsed = JSON.parse(raw)
        node.lines.push(parsed)
        node.waiters = node.waiters.filter((w) => {
          if (w.test(parsed)) {
            w.resolve(parsed)
            return false
          }
          return true
        })
      } catch {
        // non-JSON stdout line; ignore
      }
    }
  })
  proc.stderr!.on("data", (chunk) => process.stderr.write(`[${name}/err] ${chunk}`))
  return node
}

function waitFor(node: Node, what: string, test: (line: any) => boolean, timeoutMs = 8000): Promise<any> {
  const existing = node.lines.find(test)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    node.waiters.push({
      test,
      resolve: (line) => {
        clearTimeout(timer)
        resolve(line)
      },
    })
  })
}

async function main() {
  const checks: string[] = []
  const ok = (label: string, pass: boolean) => {
    checks.push(`${pass ? "PASS" : "FAIL"} ${label}`)
    if (!pass) process.exitCode = 1
  }

  const a = startNode("zro", 42_981, roots[0]!)
  const b = startNode("roshan", 42_982, roots[1]!)

  const readyA = await waitFor(a, "a ready", (l) => l.event === "ready" && l.mock === false)
  const readyB = await waitFor(b, "b ready", (l) => l.event === "ready" && l.mock === false)
  ok(`a boots online on :${readyA.port}`, readyA.status === "online" && readyA.port === 42_981)
  ok(`b boots online on :${readyB.port}`, readyB.status === "online" && readyB.port === 42_982)

  a.send("/connect localhost:42_982".replace("_", ""))
  const connected = await waitFor(a, "a connected", (l) => l.event === "connected")
  ok("handshake completes (dialer)", connected.name === "roshan")

  const bSawPeer = await waitFor(b, "b registers peer", (l) => l.event === "peer" && l.peer?.status === "connected")
  ok("listener side registers connection", bSawPeer.peer.name === "zro")

  a.send("hello roshan")
  const atB = await waitFor(b, "b inbound", (l) => l.event === "message" && l.direction === "in")
  ok("message a->b arrives", atB.content === "hello roshan")

  b.send("hey zro")
  const atA = await waitFor(a, "a inbound", (l) => l.event === "message" && l.direction === "in")
  ok("message b->a arrives", atA.content === "hey zro")

  // TOFU: first meeting is unknown until re-handshake.
  const peerAtA = await waitFor(a, "peer state", (l) => l.event === "peer" && l.peer?.identityState)
  ok("first-meeting identity state present", typeof peerAtA.peer.identityState === "string")

  // Retention agreement: A tightens to 7d (announce), then raises to forever.
  // B (default forever) meets the raise -> auto-ack; both sides converge.
  a.send("/retention 7d")
  await waitFor(a, "a retention-set", (l) => l.event === "retention-set")
  const bSawTighten = await waitFor(b, "b sees announce", (l) => l.event === "retention" && l.theirs === "7d")
  ok("b learns a's tightened policy", bSawTighten.theirs === "7d")

  a.send("/retention forever")
  await waitFor(a, "a raise", (l) => l.event === "retention" && l.pendingOut)
  const aAcked = await waitFor(a, "a acked", (l) => l.event === "retention" && l.lastAction === "ack")
  ok("b auto-acks a's raise (forever meets forever)", aAcked.lastAction === "ack")

  // Explicit reject: B tightens to 24h; A must come DOWN first so the next
  // raise is a real transition (raising requires previous < new).
  b.send("/retention 24h")
  await waitFor(b, "b tighten", (l) => l.event === "retention-set")
  const aSaw24 = await waitFor(a, "a sees 24h", (l) => l.event === "retention" && l.theirs === "24h")
  ok("a learns b tightened to 24h", aSaw24.theirs === "24h")

  a.send("/retention 24h")
  await waitFor(a, "a aligns down", (l) => l.event === "retention-set")
  await waitFor(b, "b sees a align", (l) => l.event === "retention" && l.theirs === "24h")

  a.send("/retention forever")
  const bProposal = await waitFor(b, "b proposal", (l) => l.event === "retention" && l.pendingIn === "forever")
  ok("b parks explicit proposal", bProposal.pendingIn === "forever")

  b.send("/answer no")
  await waitFor(b, "b answered", (l) => l.event === "answered")
  const aRejected = await waitFor(a, "a sees reject", (l) => l.event === "retention" && l.lastAction === "reject")
  ok("rejection propagates to proposer", aRejected.lastAction === "reject")

  a.send("/quit")
  b.send("/quit")
  await Promise.allSettled([
    new Promise((r) => a.proc.once("exit", r)),
    new Promise((r) => b.proc.once("exit", r)),
  ])

  for (const line of checks) console.log(line)
}

main()
  .catch((err) => {
    console.error("SMOKE ERROR:", err.message)
    process.exitCode = 1
  })
  .finally(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  })
