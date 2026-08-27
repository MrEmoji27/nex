// LIVE: two real UDP sockets, punching to each other and carrying traffic.
//
// The unit tests simulate routers and control the clock. This uses the actual
// network stack: real sockets, real timers, real loss if any occurs. On one
// machine both are reachable, so this does not prove traversal — it proves the
// socket layer, the punch handshake, reliability and keepalive work when wired
// to something real.
//
// Run:  bun tests/live-udp.ts
import { UdpEndpoint } from "../src/network/udp/socket"

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`) }
}

console.log("\nLIVE UDP TRANSPORT\n")

const gotA: string[] = []
const gotB: string[] = []
let connectedA = false
let connectedB = false

const a = new UdpEndpoint({
  onMessage: (_p, payload) => gotA.push(new TextDecoder().decode(payload)),
  onConnected: () => (connectedA = true),
  onLost: (_p, r) => console.log("  a lost:", r),
})
const b = new UdpEndpoint({
  onMessage: (_p, payload) => gotB.push(new TextDecoder().decode(payload)),
  onConnected: () => (connectedB = true),
  onLost: (_p, r) => console.log("  b lost:", r),
})

const portA = await a.start()
const portB = await b.start()
console.log(`  sockets bound: a=${portA} b=${portB}`)
check("both sockets bound", portA > 0 && portB > 0)

// Both sides start at once. That simultaneity is the mechanism.
a.connect("b", [{ host: "127.0.0.1", port: portB }])
b.connect("a", [{ host: "127.0.0.1", port: portA }])

await Bun.sleep(1200)
check("a opened a path", connectedA)
check("b opened a path", connectedB)

if (connectedA && connectedB) {
  const enc = new TextEncoder()
  for (const m of ["one", "two", "three"]) a.send("b", enc.encode(m))
  for (const m of ["alpha", "beta"]) b.send("a", enc.encode(m))
  await Bun.sleep(1200)

  check("b received everything, in order", gotB.join(",") === "one,two,three", gotB.join(","))
  check("a received everything, in order", gotA.join(",") === "alpha,beta", gotA.join(","))

  // A larger payload, still inside one datagram.
  const big = "x".repeat(1100)
  a.send("b", enc.encode(big))
  await Bun.sleep(800)
  check("a 1100-byte payload survives", gotB.includes(big))

  let refused = false
  try {
    a.send("b", new Uint8Array(2000))
  } catch {
    refused = true
  }
  check("an oversized payload is refused, not fragmented", refused)
}

await a.stop()
await b.stop()

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
