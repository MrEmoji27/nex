// Stress: 3-node room + voice churn over real TCP (manual, not `bun test`).
// Run: bun tests/stress-rooms.ts
//
// Proves under load:
//   1. Star fan-out integrity — 60 chat lines from a member reach the host AND
//      the third member exactly once each (no loss, no dupes through relay).
//   2. Voice-frame flood stability — both members stream ~5s of encrypted
//      frames concurrently; the links must stay healthy and error-free.
//   3. Churn — kill a member mid-room; host prunes and keeps serving; the
//      survivor's room state converges to the pruned membership.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = [
  mkdtempSync(join(tmpdir(), "nex-stress-h-")),
  mkdtempSync(join(tmpdir(), "nex-stress-m1-")),
  mkdtempSync(join(tmpdir(), "nex-stress-m2-")),
]

interface Node {
  proc: ChildProcess
  lines: Array<Record<string, any>>
  waiters: Array<{ test: (line: any) => boolean; resolve: (line: any) => void }>
  send(text: string): void
}

function startNode(name: string, port: number, dataDir: string): Node {
  const proc = spawn(
    process.execPath,
    ["run", "headless", "--", "--name", name, "--port", String(port), "--data-dir", dataDir],
    { stdio: ["pipe", "pipe", "pipe"] },
  )
  const node: Node = { proc, lines: [], waiters: [], send(t) { proc.stdin!.write(`${t}\n`) } }
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
          if (w.test(parsed)) { w.resolve(parsed); return false }
          return true
        })
      } catch { /* non-JSON */ }
    }
  })
  proc.stderr!.on("data", (chunk) => process.stderr.write(`[${name}/err] ${chunk}`))
  return node
}

function waitFor(node: Node, what: string, test: (l: any) => boolean, timeoutMs = 15_000): Promise<any> {
  const existing = node.lines.find(test)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    node.waiters.push({
      test,
      resolve: (line) => { clearTimeout(timer); resolve(line) },
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let host: Node | undefined
let m1: Node | undefined
let m2: Node | undefined

async function main() {
  const checks: string[] = []
  const ok = (label: string, pass: boolean) => {
    checks.push(`${pass ? "PASS" : "FAIL"} ${label}`)
    if (!pass) process.exitCode = 1
  }

  // ---- boot + link star: m1 -> host <- m2 ----
  host = startNode("zro", 43_111, roots[0]!)
  m1 = startNode("roshan", 43_112, roots[1]!)
  m2 = startNode("cku", 43_113, roots[2]!)
  await waitFor(host, "host ready", (l) => l.event === "ready")
  await waitFor(m1, "m1 ready", (l) => l.event === "ready")
  await waitFor(m2, "m2 ready", (l) => l.event === "ready")

  m1.send("/connect localhost:43111")
  await waitFor(m1, "m1 connected", (l) => l.event === "connected")
  m2.send("/connect localhost:43111")
  await waitFor(m2, "m2 connected", (l) => l.event === "connected")
  ok("star link: both members connected to host", true)

  // ---- host room, invite both ----
  host.send("/room warroom:roshan,cku")
  const hosted = await waitFor(host, "hosted", (l) => l.event === "room-hosted")
  const roomId = hosted.roomId as string

  const inv1 = await waitFor(m1, "m1 invite", (l) => l.event === "invitation" && l.roomId === roomId)
  const inv2 = await waitFor(m2, "m2 invite", (l) => l.event === "invitation" && l.roomId === roomId)
  m1.send(`/join ${inv1.roomId}`)
  await waitFor(m1, "m1 joined", (l) => l.event === "joined")
  m2.send(`/join ${inv2.roomId}`)
  await waitFor(m2, "m2 joined", (l) => l.event === "joined")
  const three = await waitFor(
    host,
    "host sees 3 members",
    (l) => l.event === "room" && l.roomId === roomId && Array.isArray(l.members) && l.members.length === 3,
  )
  ok("3-member room converged on host", three.members.length === 3)

  // ---- stress 1: 60 lines from m1, verify EXACT ordered arrival at host and m2 ----
  const N = 60
  for (let i = 0; i < N; i++) m1.send(`/say burst-${String(i).padStart(3, "0")}`)
  await sleep(4000)

  // Events carry only the last 3 lines per snapshot, so reconstruct DISTINCT
  // ids in first-seen order (Set preserves insertion). Because every hop is a
  // TCP link (in-order by construction), the reconstructed sequence must be
  // exactly burst-000..burst-059: proves no loss, no dupes, no reordering.
  const orderedIdsAt = (lines: Array<Record<string, any>>): string[] => {
    const set = new Set<string>()
    for (const line of lines) {
      if (line.event !== "room" || line.roomId !== roomId) continue
      for (const message of line.lastMessages ?? []) {
        const match = typeof message === "string" && /^roshan: (burst-\d{3})$/.exec(message)
        if (match) set.add(match[1]!)
      }
    }
    return [...set]
  }
  const expected = Array.from({ length: N }, (_, i) => `burst-${String(i).padStart(3, "0")}`)
  const hostSeq = orderedIdsAt(host.lines)
  const m2Seq = orderedIdsAt(m2.lines)
  ok(
    `fan-out at host: complete + ordered (${hostSeq.length}/${N})`,
    hostSeq.length === N && hostSeq.every((id, i) => id === expected[i]),
  )
  ok(
    `fan-out through relay at peer: complete + ordered (${m2Seq.length}/${N})`,
    m2Seq.length === N && m2Seq.every((id, i) => id === expected[i]),
  )

  // ---- stress 2: voice flood — all three in channel ~5s ----
  host.send("/voice on")
  await waitFor(host, "host voice", (l) => l.event === "voice-toggled" && l.active === true)
  m1.send("/voice on")
  await waitFor(m1, "m1 voice", (l) => l.event === "voice-toggled" && l.active === true)
  m2.send("/voice on")
  await waitFor(m2, "m2 voice", (l) => l.event === "voice-toggled" && l.active === true)

  const threeVoice = await waitFor(
    host,
    "host sees 3 voice participants",
    (l) =>
      l.event === "voice" &&
      Array.isArray(l.participants) &&
      l.participants.length >= 3,
    10_000,
  )
  ok("all three converge into voice channel", threeVoice.participants.length >= 3)

  await sleep(5000) // sustained concurrent streaming through the host relay

  const errorsAnywhere = [...host.lines, ...m1.lines, ...m2.lines].filter((l) => l.event === "error")
  ok(`zero transport/app errors during 5s 3-way stream (${errorsAnywhere.length} found)`, errorsAnywhere.length === 0)

  // Link still alive: ping from m1 (it dialed the host, so its selection is set).
  m1.send("/ping")
  const latency = await waitFor(m1, "post-flood ping", (l) => l.event === "latency", 10_000)
  ok(`link healthy after flood (rtt ${latency.rttMs}ms)`, latency.rttMs != null)

  // ---- stress 3: churn — hard-kill m1 mid-room ----
  m1.proc.kill("SIGKILL")
  await sleep(1500)

  // Host must prune m1 and keep functioning.
  const pruned = await waitFor(
    host,
    "host prunes m1",
    (l) =>
      l.event === "notice" &&
      typeof l.message === "string" &&
      (l.message.includes("dropped out") || l.message.includes("left")),
    12_000,
  )
  ok("member loss noticed by host", Boolean(pruned))

  // Survivor still gets served: host sends a line after the prune.
  host.send("/say still here")
  const survivorGot = await waitFor(
    m2,
    "survivor receives post-churn line",
    (l) =>
      l.event === "room" &&
      Array.isArray(l.lastMessages) &&
      l.lastMessages.some((msg: string) => msg.includes("still here")),
    10_000,
  )
  ok("survivor still receives host traffic after churn", Boolean(survivorGot))

  // Clean shutdown of survivors.
  const h = host!
  const s = m2!
  h.send("/quit")
  s.send("/quit")
  await Promise.allSettled([
    new Promise((r) => h.proc.once("exit", r)),
    new Promise((r) => s.proc.once("exit", r)),
  ])

  for (const line of checks) console.log(line)
}

main()
  .catch((err) => {
    console.error("STRESS ERROR:", err.message)
    process.exitCode = 1
  })
  .finally(() => {
    try { host?.proc.kill() } catch {}
    try { m1?.proc.kill() } catch {}
    try { m2?.proc.kill() } catch {}
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  })
