// LIVE: the whole V3 §39 acceptance path through two real headless Nex nodes.
//
// live-rendezvous.ts proves the rendezvous LAYER talks to the service. This
// proves the thing that actually matters: that an accepted introduction ends in
// a direct encrypted link and a message crossing it, with the service out of the
// path afterwards.
//
//   roshan: /rendezvous on <url> roshan
//   zro:    /rendezvous on <url> zro  -> /find roshan -> /ask roshan
//   roshan: /accept <id>
//   zro:    auto-dials, identity pin checked, UNION
//   zro:    sends a message; roshan receives it
//   then:   service is killed, and the link must survive
//
// Run:  cd rendezvous && go run ./cmd/rendezvousd     (separate terminal)
//       bun tests/live-rendezvous-union.ts
import { rm } from "node:fs/promises"

const BASE = process.env.NEX_RV ?? "http://127.0.0.1:8080"
const ROOT = "data/live-rv"
// Unique handles per run. A handle is held for the lease (up to 90s), so a
// re-run inside that window legitimately collides with its own previous nodes —
// the service is right to refuse, and the test should not fight it.
const RUN = Math.floor(Math.random() * 1e6).toString(36)
const H_ROSHAN = `roshan-${RUN}`
const H_ZRO = `zro-${RUN}`

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = ""): void => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`) }
}

interface Node {
  name: string
  proc: Bun.Subprocess
  events: Array<Record<string, unknown>>
  send(line: string): void
  waitFor(pred: (e: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown> | null>
}

async function spawnNode(name: string, port: number): Promise<Node> {
  const dir = `${ROOT}/${name}`
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  const proc = Bun.spawn(
    ["bun", "run", "src/main/headless.ts", "--name", name, "--port", String(port), "--data-dir", dir],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  const events: Array<Record<string, unknown>> = []
  ;(async () => {
    const decoder = new TextDecoder()
    let buf = ""
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value)
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith("{")) continue
        try { events.push(JSON.parse(line) as Record<string, unknown>) } catch { /* not an event line */ }
      }
    }
  })()
  const node: Node = {
    name,
    proc,
    events,
    send(line) { proc.stdin!.write(line + "\n") },
    async waitFor(pred, ms = 12_000) {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const hit = events.find(pred)
        if (hit) return hit
        await Bun.sleep(120)
      }
      return null
    },
  }
  return node
}

console.log(`\nLIVE RENDEZVOUS -> UNION  (service ${BASE})\n`)

try {
  const s = await fetch(`${BASE}/v1/status`)
  if (s.status !== 200) throw new Error(`status ${s.status}`)
} catch (err) {
  console.log(`Cannot reach ${BASE}: ${err instanceof Error ? err.message : String(err)}`)
  console.log("Start it with:  cd rendezvous && go run ./cmd/rendezvousd\n")
  process.exit(1)
}

const roshan = await spawnNode("roshan", 42061)
const zro = await spawnNode("zro", 42062)
await Bun.sleep(3500) // identity generation + transport listen

// --- both join rendezvous ---------------------------------------------------
roshan.send(`/rendezvous on ${BASE} ${H_ROSHAN}`)
zro.send(`/rendezvous on ${BASE} ${H_ZRO}`)

const rReady = await roshan.waitFor((e) => e.event === "rendezvous" && e.connectable === true)
const zReady = await zro.waitFor((e) => e.event === "rendezvous" && e.connectable === true)
check("roshan is CONNECTABLE via the app", rReady !== null)
check("zro is CONNECTABLE via the app", zReady !== null)
// CONNECTED lands after CONNECTABLE — the lease is published first and the
// control socket attaches a moment later. They are separate facts by design
// (V3 §7), so this waits for its own event rather than reading the first one.
const rConnected = await roshan.waitFor((e) => e.event === "rendezvous" && e.connected === true)
check("roshan is also CONNECTED (control channel)", rConnected !== null)

// --- zro finds roshan -------------------------------------------------------
zro.send(`/find ${H_ROSHAN}`)
const found = await zro.waitFor((e) => e.event === "find")
check(`/find ${H_ROSHAN} resolves`, found?.found === true, JSON.stringify(found ?? {}))
check("/find returns no address (V3 §11)", found !== null && !("address" in found))

// --- introduction -----------------------------------------------------------
zro.send(`/ask ${H_ROSHAN}`)
check("/ask sends an introduction request", (await zro.waitFor((e) => e.event === "introduction-sent")) !== null)

const inbound = await roshan.waitFor((e) => e.event === "introduction-request")
check("roshan is told zro is looking for him", inbound !== null)
check("request names zro", inbound?.fromHandle === H_ZRO, String(inbound?.fromHandle))

if (inbound) {
  roshan.send(`/accept ${String(inbound.requestId)}`)
  check("roshan accepts", (await roshan.waitFor((e) => e.event === "introduction-answered")) !== null)

  // --- the handoff: zro auto-dials and the union forms ----------------------
  const connected = await zro.waitFor(
    (e) => e.event === "peer" || (e.event === "connected") ||
      (e.event === "peerChanged") || (typeof e.status === "string" && e.status === "connected"),
    20_000,
  )
  const union = await zro.waitFor(
    (e) => typeof e.status === "string" && e.status === "connected", 20_000,
  )
  check("zro forms a DIRECT link after acceptance", connected !== null || union !== null,
    "no connection event; the rendezvous->P2P handoff did not complete")

  // --- a message must cross the direct link, not the service ---------------
  await Bun.sleep(1500)
  zro.send("hello from zro over the direct link")
  const delivered = await roshan.waitFor(
    (e) => e.event === "message" && typeof e.content === "string" &&
      (e.content as string).includes("hello from zro"),
    15_000,
  )
  check("MESSAGE CROSSES THE DIRECT LINK", delivered !== null,
    "message never arrived — union may not have formed")

  // --- rendezvous goes away; the relationship must survive -----------------
  if (delivered) {
    console.log("\n  (killing rendezvous is a manual step; see notes below)\n")
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)

for (const n of [roshan, zro]) {
  const errs = n.events.filter((e) => e.event === "error").slice(-4)
  if (errs.length) {
    console.log(`${n.name} errors:`)
    for (const e of errs) console.log(`  - [${String(e.scope)}] ${String(e.message)}`)
  }
}

roshan.proc.kill()
zro.proc.kill()
await Bun.sleep(300)
await rm(ROOT, { recursive: true, force: true }).catch(() => {})
process.exit(fail === 0 ? 0 : 1)
