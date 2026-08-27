// LIVE: ask real STUN servers what the internet sees, and what this router does
// to a single local port.
//
// Run:  bun tests/live-stun.ts
import { detectNat, discoverPublicAddress } from "../src/network/stun"

console.log("\nLIVE STUN\n")

const addr = await discoverPublicAddress()
console.log(`public address: ${addr ? `${addr.host}:${addr.port}  via ${addr.server}` : "NONE"}`)

const nat = await detectNat()
console.log(`nat behaviour:  ${nat.behaviour}`)
console.log(`               ${nat.detail}`)

if (!addr) {
  console.log("\nFAIL: no STUN server answered — UDP may be blocked here")
  process.exit(1)
}
if (nat.behaviour === "unknown") {
  console.log("\nINCONCLUSIVE: address found, NAT behaviour undetermined")
  process.exit(0)
}
console.log(
  nat.behaviour === "cone"
    ? "\nPASS: a direct connection can be arranged from this network"
    : "\nPASS (detected): symmetric NAT — this network needs a relay",
)
process.exit(0)
