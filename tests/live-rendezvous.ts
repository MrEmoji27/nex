// LIVE smoke: two real RendezvousClients against a real rendezvous service.
//
// Every other rendezvous test fakes the network at both ends — fake fetch, fake
// socket. That proves the logic and proves nothing about whether the two halves
// can actually talk. This is the V3 §39 acceptance path up to the handoff:
//
//   Roshan registers -> Zro searches -> Zro requests -> Roshan is notified
//   -> Roshan accepts -> Zro receives Roshan's contact descriptor
//
// Run:  bun tests/live-rendezvous.ts            (service on :8080)
//       NEX_RV=http://host:port bun tests/live-rendezvous.ts
import { RendezvousClient, browserSocketFactory, type RendezvousClientOptions } from "../src/core/rendezvous/client"
import type { ContactDescriptor } from "../src/core/rendezvous/descriptor"

const BASE = process.env.NEX_RV ?? "http://127.0.0.1:8080"

let pass = 0
let fail = 0
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`)
  }
}

function nodeId(seed: string): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(seed)
  return h.digest("hex").toUpperCase()
}

function mkClient(
  name: string,
  handle: string,
  port: number,
  events: RendezvousClientOptions["events"],
): RendezvousClient {
  return new RendezvousClient({
    baseUrl: BASE,
    identity: { nodeId: nodeId(name), seedHex: Bun.SHA256.hash(name, "hex"), noisePub: "cc".repeat(32) },
    handle,
    capabilities: ["chat", "rooms", "voice"],
    candidates: [{ kind: "direct-tcp", host: "127.0.0.1", port }],
    openSocket: browserSocketFactory,
    events,
  })
}

const settle = (ms = 400) => Bun.sleep(ms)

console.log(`\nLIVE RENDEZVOUS SMOKE -> ${BASE}\n`)

// --- reachability -----------------------------------------------------------
try {
  const res = await fetch(`${BASE}/v1/status`)
  const body = (await res.json()) as { components?: Record<string, string> }
  check("service reachable, /v1/status 200", res.status === 200)
  check("all components operational", Object.values(body.components ?? {}).every((v) => v === "operational"))
} catch (err) {
  console.log(`\nCannot reach ${BASE}: ${err instanceof Error ? err.message : String(err)}`)
  console.log("Start it with:  cd rendezvous && go run ./cmd/rendezvousd\n")
  process.exit(1)
}

// --- Roshan publishes presence ---------------------------------------------
let notified: null | { requestId: string; fromHandle: string } = null
const roshanErrors: string[] = []
const roshan = mkClient("roshan-live", "roshan", 42001, {
  introductionRequest: (r) => {
    notified = { requestId: r.requestId, fromHandle: r.fromHandle }
  },
  error: (m) => void roshanErrors.push(m),
})

await roshan.start()
await settle(600)
const rs = roshan.state()
check("roshan registered (CONNECTABLE)", rs.connectable, JSON.stringify(rs))
check("roshan control channel attached (CONNECTED)", rs.connected, `errors: ${roshanErrors.join("; ") || "none"}`)

// --- Zro searches -----------------------------------------------------------
let accepted: null | { requestId: string; contactDescriptor?: ContactDescriptor } = null
const zroErrors: string[] = []
const zro = mkClient("zro-live", "zro", 42002, {
  introductionResponse: (r) => {
    if (r.accept) accepted = { requestId: r.requestId, contactDescriptor: r.contactDescriptor }
  },
  error: (m) => void zroErrors.push(m),
})
await zro.start()
await settle(600)
check("zro registered", zro.state().connectable)

const found = await zro.search("roshan").catch((e) => {
  check("search('roshan') did not throw", false, String(e))
  return null
})
check("search('roshan') found a live descriptor", found !== null)
check("descriptor carries roshan's nodeId", found?.nodeId === nodeId("roshan-live"), found?.nodeId ?? "none")
check("descriptor reports connectable", found?.connectable === true)
check(
  "search result carries NO address (V3 §11)",
  found !== null && !("candidates" in (found as object)),
)

const miss = await zro.search("nobodyhome").catch(() => "threw")
check("search miss returns null, not an error", miss === null)

// --- introduction round trip ------------------------------------------------
const req = await zro.requestIntroduction("roshan").catch((e) => {
  check("requestIntroduction did not throw", false, String(e))
  return null
})
check("introduction request accepted by service", req !== null)
await settle(900)

// Read through explicitly typed locals: TypeScript cannot see that the event
// callbacks above ever ran, so it narrows these captures to `never`.
const gotRequest = notified as { requestId: string; fromHandle: string } | null
check("roshan was NOTIFIED over the control channel", gotRequest !== null, "no frame arrived")
if (gotRequest) {
  check("notification names zro as the requester", gotRequest.fromHandle === "zro")

  await roshan.respondIntroduction(gotRequest.requestId, true).catch((e) =>
    check("respondIntroduction(accept) did not throw", false, String(e)),
  )
  await settle(900)

  const gotAccept = accepted as { requestId: string; contactDescriptor?: ContactDescriptor } | null
  check("zro received the ACCEPTANCE", gotAccept !== null, "no response frame arrived")
  check("acceptance carries roshan's contact descriptor", gotAccept?.contactDescriptor != null)
  check(
    "contact descriptor carries a dialable candidate (the handoff)",
    (gotAccept?.contactDescriptor?.candidates?.length ?? 0) > 0,
    JSON.stringify(gotAccept?.contactDescriptor?.candidates ?? []),
  )
  check(
    "contact descriptor identity matches the searched one",
    gotAccept?.contactDescriptor?.nodeId === nodeId("roshan-live"),
  )
}

// --- presence is a lease ----------------------------------------------------
await roshan.stop()
await settle(500)
const afterStop = await zro.search("roshan").catch(() => null)
check("after roshan stops, he is no longer discoverable", afterStop === null)

await zro.stop()

console.log(`\n${pass} passed, ${fail} failed\n`)
if (zroErrors.length || roshanErrors.length) {
  console.log("client-reported errors:")
  for (const e of [...new Set([...zroErrors, ...roshanErrors])]) console.log(`  - ${e}`)
  console.log()
}
process.exit(fail === 0 ? 0 : 1)
