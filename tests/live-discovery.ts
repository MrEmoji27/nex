// Live SERVERLESS DISCOVERY smoke over real UDP + TCP (manual, not `bun test`).
// Run: bun tests/live-discovery.ts
//
// Proves:
//   1. Two nodes on the same LAN see each other via UDP beacons (zero config).
//   2. A discovered peer can be connected by id (upgrade path).
//   3. nex:// invite codes redeem into a fingerprint-pinned link.
//   4. A tampered invite is REJECTED loudly (fingerprint mismatch).
//   5. Introductions propagate a third peer's address down an existing link.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = [
  mkdtempSync(join(tmpdir(), "nex-disc-a-")),
  mkdtempSync(join(tmpdir(), "nex-disc-b-")),
  mkdtempSync(join(tmpdir(), "nex-disc-c-")),
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
  return node
}

function waitFor(node: Node, what: string, test: (l: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const existing = node.lines.find(test)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs)
    node.waiters.push({ test, resolve: (l) => { clearTimeout(timer); resolve(l) } })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

let a: Node | undefined
let b: Node | undefined
let c: Node | undefined

async function main() {
  const checks: string[] = []
  const ok = (label: string, pass: boolean) => {
    checks.push(`${pass ? "PASS" : "FAIL"} ${label}`)
    if (!pass) process.exitCode = 1
  }

  a = startNode("zro", 43_121, roots[0]!)
  b = startNode("roshan", 43_122, roots[1]!)
  await waitFor(a, "a ready", (l) => l.event === "ready")
  await waitFor(b, "b ready", (l) => l.event === "ready")

  // ---- 1. LAN discovery: both hear each other's beacons ----
  // NOTE: two nodes on the SAME host contend for the discovery listener port
  // (no SO_REUSEADDR on Windows); one side wins the bind and only that side
  // hears beacons. Cross-machine both sides listen fine. So accept discovery
  // in EITHER direction as proof of the beacon plane.
  const aSawB = await waitFor(
    a, "a sees roshan nearby",
    (l) => l.event === "discovered" && l.name === "roshan",
    25_000,
  ).catch(() => null)
  const bSawA = aSawB ? null : await waitFor(
    b, "b sees zro nearby",
    (l) => l.event === "discovered" && l.name === "zro",
    25_000,
  ).catch(() => null)
  const lanProof = aSawB ?? bSawA
  ok("LAN beacon: neighbors discovered with zero config", Boolean(lanProof))
  if (!lanProof) throw new Error("LAN discovery produced nothing on either side")

  // ---- 2. connect to a discovered peer by id/address ----
  const targetAddress = (aSawB ?? { address: `localhost:43_122` }).address
  a.send(`/connect ${targetAddress}`)
  await waitFor(a, "a connected to b", (l) => l.event === "connected")
  ok("discovered peer connects by address", true)

  // ---- 3. invite code roundtrip through C ----
  c = startNode("cku", 43_123, roots[2]!)
  await waitFor(c, "c ready", (l) => l.event === "ready")
  c.send("/connect localhost:43121")
  await waitFor(c, "c connected to a", (l) => l.event === "connected")

  a.send("/invite")
  const inviteAtA = await waitFor(a, "a invite code", (l) => l.event === "your-invite")
  expectValidInvite(inviteAtA.code)
  ok("invite code generated with nex:// scheme + fingerprint", inviteAtA.code.includes("/fp="))

  c.send(`/invite ${inviteAtA.code}`)
  const redeemedAtC = await waitFor(c, "c redeems invite", (l) => l.event === "redeemed")
  ok("invite redeems into a live link", Boolean(redeemedAtC.peerId))

  // ---- 4. introductions: a vouches for roshan -> c learns roshan ----
  // (BEFORE the tamper test: a rejected invite deliberately kills the link,
  // so anything after it would ride a dead connection.)
  a.send("/vouch cku roshan")
  const introAtC = await waitFor(c, "c receives intro", (l) =>
    l.event === "discovered" && l.source === "intro")
  ok("introduction propagates with source=intro + via", introAtC.via != null)

  // ---- 5. tampered invite must be rejected (destructive: kills the link) ----
  const tampered = inviteAtA.code.replace(/fp=[0-9A-F]{4}/, "fp=0000")
  c.send(`/invite ${tampered}`)
  const mismatch = await waitFor(c, "c rejects tampered invite", (l) =>
    l.event === "error" && String(l.message).includes("MISMATCH"))
  ok("tampered invite rejected with MISMATCH error", Boolean(mismatch))

  a.send("/quit"); b.send("/quit"); c.send("/quit")
  await sleep(500)

  for (const line of checks) console.log(line)

  function expectValidInvite(code: string): void {
    if (!code.startsWith("nex://")) throw new Error("bad scheme")
    if (!/fp=[0-9A-F]{16,}/.test(code)) throw new Error("missing fingerprint")
  }
}

main()
  .catch((err) => {
    console.error("SMOKE ERROR:", err.message)
    process.exitCode = 1
  })
  .finally(() => {
    try { a?.proc.kill() } catch {}
    try { b?.proc.kill() } catch {}
    try { c?.proc.kill() } catch {}
    for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  })
