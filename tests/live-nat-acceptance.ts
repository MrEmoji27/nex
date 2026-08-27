// LIVE ACCEPTANCE: two machines, two home routers, no port forwarding.
//
// Everything else in this repository runs on one machine. That is exactly what
// this milestone cannot be proven by: hole punching is a claim about what two
// ROUTERS do to packets they did not expect, and a loopback socket has no
// router in front of it. Localhost passing says nothing about whether Zro and
// Roshan can talk.
//
// So this script runs ONE node, on ONE machine, and is run on both.
//
//   Machine A (zro):     bun tests/live-nat-acceptance.ts --role zro --handle zro-42 --peer roshan-42
//   Machine B (roshan):  bun tests/live-nat-acceptance.ts --role roshan --handle roshan-42
//
// Start roshan FIRST — zro searches for the handle and a handle that is not
// registered yet is indistinguishable from one that does not exist.
//
// Both need --service <url> unless NEX_RV is set. Nothing else: no port
// forwarding, no NEX_PUBLIC_ADDRESS, no VPN, no shared network. If any of those
// are present the test is not testing what it claims to.
//
// On failure it names the LAYER that failed rather than saying "it did not
// work", because those are different bugs with different fixes and guessing
// between them is how a NAT problem gets papered over with a relay.
import { rm } from "node:fs/promises"

interface Args {
  role: "zro" | "roshan"
  handle: string
  peer?: string
  service: string
  dataDir: string
  timeoutMs: number
  /**
   * Path to a compiled `nex` binary to test INSTEAD of the source tree.
   *
   * This is what the other machine actually runs. A compiled binary is not the
   * same program as `bun run src/main/...`: dynamic imports are resolved at
   * build time, the data directory moves, and there is no checkout to fall back
   * on. Testing the source and shipping the binary tests the wrong thing.
   */
  binary?: string
}

function parse(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const role = (get("--role") ?? "") as Args["role"]
  if (role !== "zro" && role !== "roshan") {
    console.log(
      "usage: --role zro|roshan --handle <handle> [--peer <handle>] [--service <url>] [--binary path/to/nex.exe]",
    )
    process.exit(2)
  }
  const handle = get("--handle")
  if (!handle) {
    console.log("--handle is required (3-32 chars, a-z 0-9 _ -)")
    process.exit(2)
  }
  const service = get("--service") ?? process.env.NEX_RV ?? ""
  if (!service) {
    console.log("--service <url> is required, or set NEX_RV")
    process.exit(2)
  }
  if (role === "zro" && !get("--peer")) {
    console.log("--peer <handle> is required for the zro side")
    process.exit(2)
  }
  return {
    role,
    handle,
    peer: get("--peer"),
    service,
    dataDir: get("--data-dir") ?? `data/acceptance/${handle}`,
    timeoutMs: Number(get("--timeout") ?? 120_000),
    binary: get("--binary"),
  }
}

const args = parse(process.argv.slice(2))
const MESSAGE = `acceptance ${args.handle} ${Date.now()}`

// ---------- the node ----------

await rm(args.dataDir, { recursive: true, force: true }).catch(() => {})
const command = args.binary
  ? [args.binary, "headless", "--name", args.role, "--data-dir", args.dataDir]
  : ["bun", "run", "src/main/headless.ts", "--name", args.role, "--data-dir", args.dataDir]
const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Diagnostics are what turns "it did not connect" into a named layer.
    env: { ...process.env, NEX_DEBUG_NET: "1" },
})

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
      try {
        events.push(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // not an event line
      }
    }
  }
})()

const send = (line: string): void => void proc.stdin!.write(line + "\n")

async function waitFor(
  pred: (e: Record<string, unknown>) => boolean,
  ms = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const hit = events.find(pred)
    if (hit) return hit
    if (Date.now() > deadline) return null
    await Bun.sleep(150)
  }
}

async function diagnostics(): Promise<string[]> {
  try {
    return (await Bun.file(`${args.dataDir}/net-diagnostics.log`).text()).trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Name the layer that failed.
 *
 * The order matters: each check assumes everything before it succeeded, so the
 * first one that fails is the earliest thing that broke, which is the one worth
 * fixing. Reporting a later symptom would send the fix to the wrong place.
 */
async function classify(): Promise<string> {
  const log = await diagnostics()
  const has = (event: string) => log.some((line) => line.includes(` ${event} `))
  const line = (event: string) => log.find((l) => l.includes(` ${event} `)) ?? ""

  const rendezvousUp = events.some((e) => e.event === "rendezvous" && e.connectable === true)
  if (!rendezvousUp) return "Rendezvous — no lease was published; the service never accepted this node"

  // Everything below assumes an introduction actually happened. It is checked
  // first because a service that refused the request produces exactly the same
  // silence downstream as a NAT that ate the packets, and blaming the wrong one
  // sends the fix to the wrong layer. This is not hypothetical: a stale service
  // binary refusing the amended request looked, from here, like a peer that
  // published no candidates.
  const lastRendezvousError = [...events].reverse().find((e) => e.event === "error" && e.scope === "rendezvous")
  if (args.role === "zro") {
    if (!events.some((e) => e.event === "find" && e.found === true)) {
      return "Rendezvous — the peer's handle never became connectable"
    }
    if (!events.some((e) => e.event === "introduction-sent")) {
      return `Rendezvous — the service refused the introduction request: ${String(lastRendezvousError?.message ?? "no reason given")}`
    }
  } else if (!events.some((e) => e.event === "introduction-request")) {
    return "Rendezvous — no introduction arrived, so nothing downstream was ever attempted"
  }

  if (!has("stun_mapping")) return "STUN — no measurement was attempted; the transport did not start"
  if (line("stun_mapping").includes('"address":null')) {
    return "STUN — no server answered. UDP may be blocked outbound on this network"
  }
  if (!has("candidate_selected")) {
    return "candidate generation — the peer published no punchable candidate, so nothing was tried"
  }
  if (!has("punch_start")) return "application integration — candidates were chosen but punching never began"
  if (has("punch_failed") || !has("path_established")) {
    const symmetric = line("stun_mapping").includes('"nat":"symmetric"')
    return symmetric
      ? "NAT filtering/mapping — this router assigns a new public port per destination (symmetric). " +
          "Punching cannot cross that; the address the peer was given was stale before they used it"
      : "punching — both sides sent, neither got through inside the window"
  }
  if (!has("noise_start")) return "reliable UDP — the path opened but the channel never carried the handshake"
  if (!has("noise_authenticated")) {
    return "Noise — the handshake started over an open path and never completed"
  }
  if (line("identity_result").includes('"state":"mismatch"')) {
    return "identity — the peer proved a key that does not match the one on record for that nodeId"
  }
  if (!has("union_formed")) return "identity — authentication finished but the link was not accepted"
  return "application integration — the link formed but the message did not cross it"
}

// ---------- the run ----------

console.log(`\nNEX NAT ACCEPTANCE — ${args.role} (${args.handle})`)
console.log(`service: ${args.service}`)
console.log(`under test: ${args.binary ?? "source tree (bun run)"}\n`)

const failures: string[] = []
const step = (label: string, ok: boolean, detail = ""): boolean => {
  console.log(ok ? `  ok   ${label}` : `  FAIL ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures.push(label)
  return ok
}

await Bun.sleep(3500) // identity generation, transports binding

send(`/rendezvous on ${args.service} ${args.handle}`)
const connectable = await waitFor((e) => e.event === "rendezvous" && e.connectable === true, 30_000)
step("published a lease on the rendezvous service", connectable !== null)

// What this machine looks like from outside. Printed either way: a symmetric
// NAT is not a failure of this code, and knowing that before the connection
// attempt is worth more than deducing it after.
send("/stun")
const stun = await waitFor((e) => e.event === "stun", 20_000)
if (stun) {
  console.log(`  net  public address: ${String(stun.address ?? "none")}  (local udp ${String(stun.udpPort)})`)
  console.log(`  net  ${String(stun.detail)}`)
}
step("measured a public UDP address", Boolean(stun?.address), String(stun?.detail ?? "no answer"))

if (args.role === "roshan") {
  console.log("\n  waiting for zro to ask for an introduction...\n")
  const inbound = await waitFor((e) => e.event === "introduction-request", args.timeoutMs)
  if (step("zro asked for an introduction", inbound !== null)) {
    send(`/accept ${String(inbound!.requestId)}`)
    step("accepted", (await waitFor((e) => e.event === "introduction-answered", 15_000)) !== null)

    const connected = await waitFor(
      (e) => e.event === "peer" && (e.peer as { status?: string } | undefined)?.status === "connected",
      args.timeoutMs,
    )
    step("UNION formed with zro", connected !== null)

    const delivered = await waitFor(
      (e) => e.event === "message" && typeof e.content === "string" && (e.content as string).includes("acceptance"),
      args.timeoutMs,
    )
    step("a message arrived over the direct link", delivered !== null)
  }
} else {
  console.log(`\n  looking for ${args.peer}...\n`)
  let found: Record<string, unknown> | null = null
  const deadline = Date.now() + args.timeoutMs
  while (Date.now() < deadline) {
    send(`/find ${args.peer}`)
    found = await waitFor((e) => e.event === "find" && e.found === true, 6000)
    if (found) break
    events.length = Math.min(events.length, events.length) // keep history; just retry
    await Bun.sleep(2000)
  }
  if (step(`found ${args.peer}`, found !== null, "handle never became connectable")) {
    send(`/ask ${args.peer}`)
    step("introduction requested", (await waitFor((e) => e.event === "introduction-sent", 15_000)) !== null)

    const answered = await waitFor((e) => e.event === "introduction-answered" && e.accept === true, args.timeoutMs)
    step("roshan accepted", answered !== null)

    const connected = await waitFor(
      (e) => e.event === "peer" && (e.peer as { status?: string } | undefined)?.status === "connected",
      args.timeoutMs,
    )
    if (step("UNION formed with roshan", connected !== null)) {
      send("/net")
      const net = await waitFor((e) => e.event === "net", 10_000)
      const peers = (net?.peers ?? []) as Array<{ transport?: string; status?: string }>
      const direct = peers.find((p) => p.status === "connected")
      console.log(`  net  transport in use: ${String(direct?.transport ?? "unknown")}`)
      step("the link is the punched UDP one, not a fallback", direct?.transport === "udp")

      await Bun.sleep(1000)
      // A bare line is a message to the connected peer; /say is for rooms.
      send(MESSAGE)
      // Whether it arrived is asserted on roshan's side; here we only need to
      // know the send did not throw.
      step("sent a message over the direct link", (await waitFor((e) => e.event === "error", 2500)) === null)
    }
  }
}

// ---------- verdict ----------

/**
 * Which address the path actually opened on.
 *
 * This is the difference between the test passing and the test MEANING
 * anything. A union formed over 192.168.x.x crossed no router: it is the same
 * result localhost gives, and reporting it as NAT traversal would be exactly
 * the false pass this milestone exists to avoid.
 */
async function pathEndpoint(): Promise<string | null> {
  const line = (await diagnostics()).find((l) => l.includes(" path_established "))
  const match = line?.match(/"endpoint":"([^"]+)"/)
  return match?.[1] ?? null
}

function isPrivateHost(host: string): boolean {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:)/.test(host)
}

console.log("")
const endpoint = await pathEndpoint()
if (failures.length === 0 && endpoint && isPrivateHost(endpoint.replace(/:\d+$/, ""))) {
  console.log(`INCONCLUSIVE — the union formed, but on ${endpoint}, which is a private address.`)
  console.log("Both nodes are on the same network, so no router was crossed and nothing was punched")
  console.log("through. Run this from two machines on two different internet connections.\n")
  process.exit(2)
}
if (failures.length === 0) {
  console.log(`PASS — direct UDP union across two networks (path: ${endpoint ?? "unknown"})\n`)
} else {
  console.log(`FAIL — ${failures.length} step(s) failed`)
  console.log(`\n  failing layer: ${await classify()}\n`)
  const recent = (await diagnostics()).slice(-12)
  if (recent.length > 0) {
    console.log("  last diagnostics:")
    for (const line of recent) console.log(`    ${line}`)
  }
  const errors = events.filter((e) => e.event === "error").slice(-5)
  if (errors.length > 0) {
    console.log("\n  errors:")
    for (const e of errors) console.log(`    [${String(e.scope)}] ${String(e.message)}`)
  }
  console.log("")
}

proc.kill()
await Bun.sleep(300)
process.exit(failures.length === 0 ? 0 : 1)
