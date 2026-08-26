// Discovery unit tests — invite codec + seen-registry bookkeeping.
// The LAN socket layer itself is exercised by the live smokes.
import { describe, expect, test } from "bun:test"
import {
  SeenRegistry,
  decodeInvite,
  encodeInvite,
  makeBeacon,
  parseBeacon,
} from "../src/core/discovery"

describe("beacon codec", () => {
  test("makeBeacon -> parseBeacon roundtrips", () => {
    const payload = makeBeacon({ nodeId: "A".repeat(64), name: "zro", port: 42001 }, "A".repeat(64))
    const beacon = parseBeacon(new TextEncoder().encode(payload))
    expect(beacon).not.toBeNull()
    expect(beacon!.name).toBe("zro")
    expect(beacon!.port).toBe(42001)
    expect(beacon!.nodeId).toBe("A".repeat(64))
  })

  test("garbage datagrams are rejected, never thrown", () => {
    const bytes = new TextEncoder().encode(`{not json`)
    expect(parseBeacon(bytes)).toBeNull()
    expect(parseBeacon(new TextEncoder().encode(`{"v":9}`))).toBeNull()
    expect(parseBeacon(new Uint8Array(4))).toBeNull()
  })
})

describe("invite codec", () => {
  test("full code roundtrips with fingerprint", () => {
    const fp = "AB12CD34" + "0".repeat(56)
    const code = encodeInvite({ name: "zro", host: "100.101.5.20", port: 42001, fp })
    const parts = decodeInvite(code)!
    expect(parts.name).toBe("zro")
    expect(parts.host).toBe("100.101.5.20")
    expect(parts.port).toBe(42001)
    expect(parts.fp).toBe(fp)
    expect(code.startsWith("nex://zro@100.101.5.20:42001/fp=")).toBe(true)
  })

  test("names with spaces survive encoding", () => {
    const code = encodeInvite({ name: "big z", host: "192.168.1.7", port: 42101 })
    expect(decodeInvite(code)!.name).toBe("big z")
  })

  test("rejects malformed codes", () => {
    expect(decodeInvite("not an invite")).toBeNull()
    expect(decodeInvite("nex://host:notaport")).toBeNull()
    expect(decodeInvite("http://evil.example")).toBeNull()
  })
})

describe("SeenRegistry", () => {
  test("observe adds once then refreshes; list sorts newest first", async () => {
    const reg = new SeenRegistry()
    const first = reg.observe({ peerId: "p1", name: "a", address: "10.0.0.2:42001", source: "lan" }, 1000)
    expect(first.added).toBe(true)
    const again = reg.observe({ peerId: "p1", name: "a", address: "10.0.0.2:42001", source: "lan" }, 2000)
    expect(again.added).toBe(false)
    reg.observe({ peerId: "p2", name: "b", address: "10.0.0.3:42001", source: "intro", viaName: "a" }, 3000)
    const list = reg.list()
    expect(list.map((p) => p.peerId)).toEqual(["p2", "p1"])
  })

  test("sweepExpired drops only stale entries and reports them", () => {
    const reg = new SeenRegistry()
    reg.observe({ peerId: "old", name: "x", address: "h:1", source: "lan" }, 1000)
    reg.observe({ peerId: "new", name: "y", address: "h:2", source: "intro" })
    // "old" was observed at unix-ms 1000 (1970!) so its TTL lapsed long ago;
    // "new" was observed now and must survive a sweep at now.
    const gone = reg.sweepExpired(Date.now())
    expect(gone.map((g) => g.peerId)).toEqual(["old"])
    expect(reg.get("new")).not.toBeNull()
    expect(reg.get("old")).toBeNull()
  })

  test("address updates propagate on refresh (roaming laptops)", () => {
    const reg = new SeenRegistry()
    reg.observe({ peerId: "p", name: "n", address: "10.0.0.9:42001", source: "lan" }, 1000)
    const { peer } = reg.observe({ peerId: "p", name: "n", address: "10.0.0.9:52001", source: "lan" }, 2000)
    expect(peer.address).toBe("10.0.0.9:52001")
  })
})
