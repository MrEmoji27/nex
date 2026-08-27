// The op layout, frozen.
//
// These bytes are what a Nex link carries once the handshake is done, and they
// must be the same on TCP and UDP: the transport decides how a frame travels,
// never what it means. The layout below is the one encrypted-tcp-transport.ts
// has written since v1 (writeOpFrame / dispatchOp) — recorded here so a change
// on either side fails a test instead of quietly making the two transports
// speak different dialects of the same protocol.
//
// If an assertion here fails, the encoding changed. That is a wire break, and
// it needs a version bump, not a new vector.
import { describe, expect, test } from "bun:test"
import {
  decodeOp,
  encodeOp,
  OP_CONTROL,
  OP_MESSAGE,
  OP_PING,
  OP_PONG,
  OP_VOICE,
} from "../src/core/session/op-frames"

const MAX = 60_000

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

describe("frozen layout", () => {
  test("a message is 0x01 followed by UTF-8", () => {
    expect(hex(encodeOp({ op: OP_MESSAGE, content: "hi" }, MAX))).toBe("016869")
  })

  test("non-ASCII is UTF-8, not code units", () => {
    // A message is bytes on the wire; encoding it as UTF-16 would make every
    // emoji a different length on each side of a mixed-version link.
    expect(hex(encodeOp({ op: OP_MESSAGE, content: "é" }, MAX))).toBe("01c3a9")
  })

  test("ping and pong are 0x02/0x03 plus a big-endian u64", () => {
    expect(hex(encodeOp({ op: OP_PING, t: 1 }, MAX))).toBe("020000000000000001")
    expect(hex(encodeOp({ op: OP_PONG, t: 258 }, MAX))).toBe("030000000000000102")
  })

  test("a voice frame is 0x05, a u16 meta length, the meta, then the audio", () => {
    const encoded = encodeOp(
      { op: OP_VOICE, meta: { roomId: "r", fromPeerId: "p", seq: 1 }, payload: new Uint8Array([1, 2, 3]) },
      MAX,
    )
    expect(encoded[0]).toBe(0x05)
    const metaLen = new DataView(encoded.buffer).getUint16(1)
    expect(metaLen).toBe(JSON.stringify({ roomId: "r", fromPeerId: "p", seq: 1 }).length)
    expect(hex(encoded.slice(3 + metaLen))).toBe("010203")
  })
})

describe("round trips", () => {
  test("every op decodes back to what went in", () => {
    const message = decodeOp(encodeOp({ op: OP_MESSAGE, content: "hello" }, MAX))
    expect(message).toEqual({ kind: "message", content: "hello" })

    const ping = decodeOp(encodeOp({ op: OP_PING, t: 1_700_000_000_000 }, MAX))
    expect(ping).toEqual({ kind: "ping", t: 1_700_000_000_000 })

    const control = decodeOp(
      encodeOp({ op: OP_CONTROL, control: { kind: "retention", action: "ack", ts: 5 } as never }, MAX),
    )
    expect(control.kind).toBe("control")

    const voice = decodeOp(
      encodeOp(
        { op: OP_VOICE, meta: { roomId: "r1", fromPeerId: "P", seq: 9 }, payload: new Uint8Array([7, 7]) },
        MAX,
      ),
    )
    expect(voice.kind).toBe("voice")
    if (voice.kind === "voice") {
      expect(voice.meta.seq).toBe(9)
      expect(Array.from(voice.payload)).toEqual([7, 7])
    }
  })
})

describe("what is fatal and what is survivable", () => {
  test("an unknown op is fatal: the two ends disagree about the protocol", () => {
    expect(() => decodeOp(new Uint8Array([0x7f, 1, 2]))).toThrow(/unknown op/)
  })

  test("control that is not JSON is fatal", () => {
    expect(() => decodeOp(new Uint8Array([0x04, 0x7b, 0x7b]))).toThrow(/not valid JSON/)
  })

  test("an unknown control KIND is dropped, not fatal", () => {
    // A newer peer talking about a feature this build predates must not be able
    // to kill the link by mentioning it.
    const frame = encodeOp({ op: OP_CONTROL, control: { kind: "telepathy" } as never }, MAX)
    expect(decodeOp(frame).kind).toBe("drop")
  })

  test("a malformed voice frame costs 20ms of audio, not the session", () => {
    expect(decodeOp(new Uint8Array([0x05])).kind).toBe("drop")
    expect(decodeOp(new Uint8Array([0x05, 0xff, 0xff, 0x01])).kind).toBe("drop")
  })
})

describe("size ceilings are enforced before anything is encrypted", () => {
  // Both transports advance a cipher nonce inside send(). A throw AFTER
  // encryption would burn a counter and desync the stream permanently, so the
  // check has to live here, where nothing has happened yet.
  test("an oversized message is refused with its actual size", () => {
    expect(() => encodeOp({ op: OP_MESSAGE, content: "x".repeat(50) }, 20)).toThrow(/message too large \(50 bytes/)
  })

  test("an oversized voice frame is refused", () => {
    expect(() =>
      encodeOp({ op: OP_VOICE, meta: { roomId: "r", fromPeerId: "p", seq: 1 }, payload: new Uint8Array(500) }, 100),
    ).toThrow(/voice frame too large/)
  })
})
