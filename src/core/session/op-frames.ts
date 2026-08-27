// The op frames that ride inside a secure session.
//
// This is what a Nex link actually carries once the handshake is done: chat
// messages, latency probes, control ops, voice frames. The bytes are identical
// on TCP and UDP by intent — the transport decides how they travel, never what
// they mean. The layout is the one the TCP transport has always written (see
// encrypted-tcp-transport.ts, writeOpFrame/dispatchOp), frozen here as vectors
// in tests/op-frames.test.ts so a change to one transport cannot quietly
// redefine the other.
//
// Sizes are validated BEFORE anything is encrypted. On both transports the
// nonce advances inside the cipher, so a throw after encryption would burn a
// counter and desync the stream permanently; every failure has to happen here.

import { isKnownControl, type ControlWire, type VoiceFrameMeta } from "../contract"

export const OP_MESSAGE = 0x01
export const OP_PING = 0x02
export const OP_PONG = 0x03
export const OP_CONTROL = 0x04
export const OP_VOICE = 0x05

export type OpFrame =
  | { op: typeof OP_MESSAGE; content: string }
  | { op: typeof OP_PING; t: number }
  | { op: typeof OP_PONG; t: number }
  | { op: typeof OP_CONTROL; control: ControlWire }
  | { op: typeof OP_VOICE; meta: VoiceFrameMeta; payload: Uint8Array }

/** What a decoded frame turned out to be. "drop" is not an error: see below. */
export type DecodedOp =
  | { kind: "message"; content: string }
  | { kind: "ping"; t: number }
  | { kind: "pong"; t: number }
  | { kind: "control"; control: ControlWire }
  | { kind: "voice"; meta: VoiceFrameMeta; payload: Uint8Array }
  | { kind: "drop"; reason: string }

function encJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

/**
 * Encode one op frame.
 *
 * `maxPlaintext` is the transport's ceiling, and it differs a lot: TCP frames
 * are length-prefixed with a u16, while a UDP datagram has to stay under the
 * smallest MTU. Passing it in rather than assuming one keeps the limit where
 * the constraint actually lives.
 */
export function encodeOp(frame: OpFrame, maxPlaintext: number): Uint8Array {
  if (frame.op === OP_MESSAGE) {
    const body = new TextEncoder().encode(frame.content)
    if (body.length > maxPlaintext - 1) {
      throw new Error(`message too large (${body.length} bytes; max ${maxPlaintext - 1})`)
    }
    const out = new Uint8Array(1 + body.length)
    out[0] = OP_MESSAGE
    out.set(body, 1)
    return out
  }
  if (frame.op === OP_CONTROL) {
    const body = encJson(frame.control)
    if (body.length > maxPlaintext - 1) throw new Error("control op too large")
    const out = new Uint8Array(1 + body.length)
    out[0] = OP_CONTROL
    out.set(body, 1)
    return out
  }
  if (frame.op === OP_VOICE) {
    // [0x05][u16be metaLen][meta json][payload]
    const metaBody = encJson(frame.meta)
    if (metaBody.length > 0xffff) throw new Error("voice frame meta too large")
    const total = 1 + 2 + metaBody.length + frame.payload.length
    if (total > maxPlaintext) throw new Error("voice frame too large")
    const out = new Uint8Array(total)
    out[0] = OP_VOICE
    new DataView(out.buffer).setUint16(1, metaBody.length)
    out.set(metaBody, 3)
    out.set(frame.payload, 3 + metaBody.length)
    return out
  }
  const out = new Uint8Array(9)
  out[0] = frame.op
  new DataView(out.buffer).setBigUint64(1, BigInt(Math.min(frame.t, Number.MAX_SAFE_INTEGER)))
  return out
}

/**
 * Decode one op frame.
 *
 * Throws only for what cannot be reasoned about at all — an op this build has
 * never heard of, or control JSON that is not JSON. Everything survivable
 * returns "drop": a malformed voice frame costs 20ms of audio, and an unknown
 * control KIND is simply a newer peer talking about rooms or voice features
 * this build predates. Killing the link over either would make every protocol
 * addition a compatibility break.
 */
export function decodeOp(plaintext: Uint8Array): DecodedOp {
  if (plaintext.length < 1) return { kind: "drop", reason: "empty op frame" }
  const op = plaintext[0]

  if (op === OP_MESSAGE) {
    return { kind: "message", content: new TextDecoder().decode(plaintext.slice(1)) }
  }
  if (op === OP_PING || op === OP_PONG) {
    if (plaintext.length < 9) return { kind: "drop", reason: "truncated latency op" }
    const t = Number(new DataView(plaintext.buffer, plaintext.byteOffset).getBigUint64(1))
    return op === OP_PING ? { kind: "ping", t } : { kind: "pong", t }
  }
  if (op === OP_CONTROL) {
    let control: ControlWire
    try {
      control = JSON.parse(new TextDecoder().decode(plaintext.slice(1))) as ControlWire
    } catch {
      throw new Error("control op not valid JSON")
    }
    if (!isKnownControl(control)) return { kind: "drop", reason: "unknown control kind" }
    return { kind: "control", control }
  }
  if (op === OP_VOICE) {
    if (plaintext.length < 3) return { kind: "drop", reason: "truncated voice frame" }
    const metaLen = new DataView(plaintext.buffer, plaintext.byteOffset).getUint16(1)
    if (3 + metaLen > plaintext.length) return { kind: "drop", reason: "voice meta overruns frame" }
    let meta: VoiceFrameMeta
    try {
      meta = JSON.parse(new TextDecoder().decode(plaintext.slice(3, 3 + metaLen))) as VoiceFrameMeta
    } catch {
      return { kind: "drop", reason: "voice meta not valid JSON" }
    }
    if (!meta || typeof meta.roomId !== "string" || typeof meta.fromPeerId !== "string") {
      return { kind: "drop", reason: "voice meta missing fields" }
    }
    return { kind: "voice", meta, payload: plaintext.slice(3 + metaLen) }
  }
  throw new Error(`unknown op ${op}`)
}
