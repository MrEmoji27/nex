// Live two-node ROOM + VOICE smoke over real TCP through real headless nodes.
// Run manually (not part of `bun test`): bun tests/live-room-voice.ts
// Proves: invite -> join -> membership convergence -> room chat relay ->
// voice presence convergence -> encrypted voice-frame flood stability.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = [
  mkdtempSync(join(tmpdir(), "nex-live-room-a-")),
  mkdtempSync(join(tmpdir(), "nex-live-room-b-")),
]

/** Live node handles, hoisted so the finally-block can kill strays on failure. */
let liveA: Node | undefined
let liveB: Node | undefined

interface Node {
  proc: ChildProcess
  // Parsed JSON events from this node's stdout.
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

  const a = startNode("zro", 43_101, roots[0]!)
  const b = startNode("roshan", 43_102, roots[1]!)
  liveA = a
  liveB = b

  await waitFor(a, "a ready", (l) => l.event === "ready" && l.mock === false)
  await waitFor(b, "b ready", (l) => l.event === "ready" && l.mock === false)

  // ---- link up ----
  a.send("/connect localhost:43102")
  await waitFor(a, "a connected", (l) => l.event === "connected")
  await waitFor(b, "b registers peer", (l) => l.event === "peer" && l.peer?.status === "connected")
  ok("link established", true)

  // ---- host a room and invite roshan ----
  a.send("/room lounge:roshan")
  const hosted = await waitFor(a, "room-hosted", (l) => l.event === "room-hosted")
  ok(`a hosts "${hosted.name}" (${hosted.roomId})`, typeof hosted.roomId === "string")

  const inviteAtB = await waitFor(b, "b invitation", (l) => l.event === "invitation")
  ok("b receives the invitation", inviteAtB.roomId === hosted.roomId)

  // ---- b joins ----
  b.send(`/join ${inviteAtB.roomId}`)
  const joined = await waitFor(b, "b joined", (l) => l.event === "joined")
  ok("b joins successfully", joined.roomId === hosted.roomId)

  const aSeesMember = await waitFor(
    a,
    "a sees b in room",
    (l) =>
      l.event === "room" &&
      l.roomId === hosted.roomId &&
      Array.isArray(l.members) &&
      l.members.some((m: string) => m.startsWith("roshan")),
  )
  ok("membership converges on host", aSeesMember.members.length === 2)

  const bSeesBoth = await waitFor(
    b,
    "b sees both members",
    (l) => l.event === "room" && l.roomId === hosted.roomId && Array.isArray(l.members) && l.members.length >= 2,
  )
  ok("membership converges on member", Array.isArray(bSeesBoth.members))

  // ---- room chat: member -> host relays back as authorship-preserved line ----
  b.send("/say hello from the room")
  const chatAtA = await waitFor(
    a,
    "a sees room chat",
    (l) =>
      l.event === "room" &&
      l.roomId === hosted.roomId &&
      Array.isArray(l.lastMessages) &&
      l.lastMessages.some((m: string) => m.includes("hello from the room")),
  )
  ok(
    "room chat arrives with original authorship",
    chatAtA.lastMessages.some((m: string) => m.startsWith("roshan:")),
  )

  // Host replies into the room; member sees it.
  a.send("/say host online")
  const hostChatAtB = await waitFor(
    b,
    "b sees host chat",
    (l) =>
      l.event === "room" &&
      l.roomId === hosted.roomId &&
      Array.isArray(l.lastMessages) &&
      l.lastMessages.some((m: string) => m.includes("host online")),
  )
  ok("host line reaches member", hostChatAtB.lastMessages.some((m: string) => m.startsWith("zro:")))

  // ---- voice: both join the channel ----
  a.send("/voice on")
  await waitFor(a, "a voice on", (l) => l.event === "voice-toggled" && l.active === true)
  ok("a enters voice channel", true)

  // Member learns the host is in-channel (via state reconciliation).
  const bSeesA = await waitFor(
    b,
    "b sees a in voice",
    (l) => l.event === "voice" && Array.isArray(l.participants) && l.participants.some((p: string) => p.startsWith("zro")),
  )
  ok("voice presence converges to member", bSeesA.state === "connected")

  b.send("/voice on")
  await waitFor(b, "b voice on", (l) => l.event === "voice-toggled" && l.active === true)

  // Host learns the member joined too (relayed join op).
  const aSeesB = await waitFor(
    a,
    "a sees b in voice",
    (l) =>
      l.event === "voice" &&
      Array.isArray(l.participants) &&
      l.participants.some((p: string) => p.startsWith("roshan")),
  )
  ok("both present in voice on host view", aSeesB.participants.length === 2)

  // ---- mute propagation ----
  b.send("/mute on")
  const aSeesMute = await waitFor(
    a,
    "a sees b muted",
    (l) =>
      l.event === "voice" &&
      Array.isArray(l.participants) &&
      l.participants.some((p: string) => p.startsWith("roshan") && p.includes("(muted)")),
  )
  ok("mute propagates host-side", Boolean(aSeesMute))

  // ---- encrypted voice-frame flood: 600ms of streaming must not disturb the link ----
  await new Promise((r) => setTimeout(r, 600))
  const errA = a.lines.find((l) => l.event === "error")
  const errB = b.lines.find((l) => l.event === "error")
  ok("no transport errors during voice streaming (a)", !errA)
  ok("no transport errors during voice streaming (b)", !errB)

  // Link still alive: ping works.
  a.send("/ping")
  const latency = await waitFor(a, "post-stream latency", (l) => l.event === "latency", 8000)
  ok("link healthy after stream flood", latency.rttMs != null)

  // ---- teardown paths ----
  b.send("/leave lounge")
  const leftA = await waitFor(
    a,
    "a sees b leave",
    (l) => l.event === "notice" && typeof l.message === "string" && l.message.includes("left"),
  )
  ok("bye propagates to host", Boolean(leftA))

  // With everyone gone, close is a clean local dissolve (nothing to fan out).
  a.send("/close lounge")
  const closedA = await waitFor(a, "a closes room", (l) => l.event === "room-closed")
  ok("host close completes cleanly", closedA.reason.includes("closed"))
  const errLateA = a.lines.find((l) => l.event === "error")
  ok("no errors through full teardown", !errLateA)

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
    // Never leak node processes when a check fails midway.
    try { liveA?.proc.kill() } catch {}
    try { liveB?.proc.kill() } catch {}
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  })
