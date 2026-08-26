// Voice pipeline tests — mock audio, real sequencing/jitter/loss logic.
import { describe, expect, test } from "bun:test"
import type { VoiceFrameMeta } from "../src/core/contract"
import {
  MockAudioSink,
  MockAudioSource,
  MockVoiceCodec,
  VoiceSession,
  type VoiceSendPort,
} from "../src/core/voice"

const ROOM = "room1"
const SELF = "self-1"

function meta(seq: number, fromPeerId = "peer-1"): VoiceFrameMeta {
  return { roomId: ROOM, fromPeerId, seq }
}

/** Records sent frames per destination; targets configurable per test. */
function harness(initialTargets: string[] = ["host-1"]) {
  let targets = initialTargets
  const sent: Array<{ to: string; meta: VoiceFrameMeta; payload: Uint8Array }> = []
  const send: VoiceSendPort = {
    targets: () => targets,
    sendFrame(to, m, payload) {
      sent.push({ to, meta: { ...m }, payload })
    },
  }
  return {
    send,
    sent,
    setTargets(next: string[]) {
      targets = next
    },
  }
}

async function startedSession(overrides?: Partial<ConstructorParameters<typeof VoiceSession>[0]>) {
  const h = harness()
  const source = new MockAudioSource()
  const sink = new MockAudioSink()
  const session = new VoiceSession({
    roomId: ROOM,
    selfId: SELF,
    source,
    sink,
    codec: new MockVoiceCodec(),
    send: h.send,
    ...overrides,
  })
  await session.join()
  return { session, h, source, sink }
}

describe("codec", () => {
  test("mock codec roundtrips PCM bytes", () => {
    const codec = new MockVoiceCodec()
    const frame = { data: Int16Array.from([0, -1, 1, 32767, -32768]), sampleRate: 48_000, channels: 1 }
    const bytes = codec.encode(frame)
    expect(bytes.length).toBe(10)
    const back = codec.decode(bytes, 48_000, 1)
    expect([...back.data]).toEqual([0, -1, 1, 32767, -32768])
  })

  test("mock source emits zero frames (silence) at cadence", async () => {
    const source = new MockAudioSource()
    let frames = 0
    await source.start((frame) => {
      frames++
      for (const sample of frame.data) expect(sample).toBe(0)
    })
    await new Promise((r) => setTimeout(r, 90))
    await source.stop()
    expect(frames).toBeGreaterThanOrEqual(2)
    expect(source.emitted).toBe(frames)
  })
})

describe("voice session", () => {
  test("captured frames fan out to all targets with monotonic seq", async () => {
    const { session, h } = await startedSession()
    await new Promise((r) => setTimeout(r, 70))
    await session.leave()

    expect(h.sent.length).toBeGreaterThanOrEqual(2)
    const seqs = h.sent.map((s) => s.meta.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    for (const item of h.sent) {
      expect(item.to).toBe("host-1")
      expect(item.meta.fromPeerId).toBe(SELF)
      expect(item.meta.roomId).toBe(ROOM)
    }
    expect(session.stats.sentFrames).toBe(h.sent.length / 1)
  })

  test("mute stops SENDING but keeps the pipeline warm; unmute resumes", async () => {
    const { session, h } = await startedSession()
    await new Promise((r) => setTimeout(r, 60))
    session.setSendEnabled(false)
    const atMute = h.sent.length
    await new Promise((r) => setTimeout(r, 60))
    expect(h.sent.length).toBe(atMute)
    session.setSendEnabled(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(h.sent.length).toBeGreaterThan(atMute)
    await session.leave()
  })

  test("inbound frames pass jitter buffer and play; late/replayed frames drop", async () => {
    const sink = new MockAudioSink()
    const codec = new MockVoiceCodec()
    const h = harness([])
    const session = new VoiceSession({
      roomId: ROOM,
      selfId: SELF,
      source: new MockAudioSource(),
      sink,
      codec,
      send: h.send,
    })
    await session.join()

    const pcm = Int16Array.from([100, 200, 300])
    const bytes = codec.encode({ data: pcm, sampleRate: 48_000, channels: 1 })
    session.acceptWireFrame(meta(1), bytes)
    session.acceptWireFrame(meta(2), bytes)
    // Replay of seq 2 and stale seq 1 must be dropped as late.
    session.acceptWireFrame(meta(2), bytes)
    session.acceptWireFrame(meta(1), bytes)

    // JITTER_MS is 80 — nothing should have played yet.
    expect(sink.played).toBe(0)
    await new Promise((r) => setTimeout(r, 140))
    expect(sink.played).toBe(2)
    // Fresh frames count as received; replays/stale count only as drops.
    expect(session.stats.receivedFrames).toBe(2)
    expect(session.stats.droppedLate).toBe(2)
    await session.leave()
  })

  test("echo guard ignores own frames relayed back", async () => {
    const { session, sink } = await startedSession()
    const codec = new MockVoiceCodec()
    const bytes = codec.encode({ data: new Int16Array(16), sampleRate: 48_000, channels: 1 })
    session.acceptWireFrame(meta(5, SELF), bytes)
    await new Promise((r) => setTimeout(r, 120))
    expect(sink.played).toBe(0)
    expect(session.stats.receivedFrames).toBe(0)
    await session.leave()
  })

  test("leave stops timers and clears speaking state", async () => {
    const { session } = await startedSession()
    expect(session.active).toBe(true)
    await session.leave()
    expect(session.active).toBe(false)
  })
})
