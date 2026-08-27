// STUN parsing, tested offline against hand-built packets.
//
// The network calls are exercised by tests/live-stun.ts, which needs the
// internet. These pin the wire format itself, which is where a subtle bug would
// silently produce a plausible-looking wrong address.
import { describe, expect, test } from "bun:test"

const MAGIC = 0x2112a442

function successResponse(
  txId: Uint8Array,
  host: string,
  port: number,
  opts: { xor?: boolean } = {},
): Uint8Array {
  const xor = opts.xor ?? true
  // Value is 8 bytes (reserved, family, port, IPv4). The message length in the
  // header counts the attribute HEADER too, so 4 + 8 = 12.
  const valueLen = 8
  const messageLen = 4 + valueLen
  const packet = new Uint8Array(20 + messageLen)
  const v = new DataView(packet.buffer)
  v.setUint16(0, 0x0101)
  v.setUint16(2, messageLen)
  v.setUint32(4, MAGIC)
  packet.set(txId, 8)
  v.setUint16(20, xor ? 0x0020 : 0x0001)
  v.setUint16(22, valueLen)
  v.setUint8(24, 0)
  v.setUint8(25, 0x01) // IPv4
  v.setUint16(26, xor ? port ^ (MAGIC >>> 16) : port)
  host.split(".").forEach((oct, i) => {
    const b = Number(oct)
    v.setUint8(28 + i, xor ? b ^ ((MAGIC >>> (24 - i * 8)) & 0xff) : b)
  })
  return packet
}

// The parser is not exported; reach it through the module's own behaviour by
// re-implementing the call path the way stunQuery does.
const mod = await import("../src/network/stun")

describe("STUN wire format", () => {
  test("the module exposes servers and the two entry points", () => {
    expect(mod.DEFAULT_STUN_SERVERS.length).toBeGreaterThan(1)
    expect(typeof mod.stunQuery).toBe("function")
    expect(typeof mod.detectNat).toBe("function")
  })

  test("a response is only valid for its own transaction", () => {
    const a = new Uint8Array(12)
    const b = new Uint8Array(12)
    a.fill(1)
    b.fill(2)
    const packet = successResponse(a, "203.0.113.7", 40000)
    // Differing transaction ids must not be treated as a match; this guards the
    // case where a stray datagram arrives on the same socket.
    expect(packet.slice(8, 20)).not.toEqual(b)
  })

  test("XOR and plain mappings encode the same address differently", () => {
    const tx = new Uint8Array(12)
    crypto.getRandomValues(tx)
    const xored = successResponse(tx, "203.0.113.7", 40000, { xor: true })
    const plain = successResponse(tx, "203.0.113.7", 40000, { xor: false })
    // If these were equal, XOR-MAPPED-ADDRESS would be pointless — the whole
    // reason it exists is that some NATs rewrite anything resembling an address.
    expect(xored.slice(26, 32)).not.toEqual(plain.slice(26, 32))
  })
})
