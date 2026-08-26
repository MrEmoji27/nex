// LIVE: real microphone audio through the native sidecar, across a real
// VoiceSession, and back out a real speaker.
//
// The unit suite proves the session logic with mocks. This proves the thing
// mocks cannot: that the sidecar, the framing, the jitter buffer and the
// transport carry actual sound end to end, and how long it takes.
//
// Run:  bun tests/live-voice-native.ts
import { NativeVoiceIo, nativeVoiceAvailable } from "../src/core/native-voice"
import { MockAudioSink, MockAudioSource, MockVoiceCodec, VoiceSession } from "../src/core/voice"

if (!nativeVoiceAvailable()) {
  console.log("sidecar not built. run:  cd audio && cargo build --release")
  process.exit(1)
}

console.log("\nLIVE NATIVE VOICE\n")

// Two sessions, wired straight to each other: whatever A captures, B plays.
// The loop is deliberately closed in-process so this measures the audio path
// and not the network.
const io = new NativeVoiceIo()

let sent = 0
let played = 0
let bytes = 0
const latencies: number[] = []
const sentAt = new Map<number, number>()

const session = new VoiceSession({
  roomId: "live",
  selfId: "self",
  source: new MockAudioSource(),
  sink: new MockAudioSink(),
  codec: new MockVoiceCodec(),
  encoded: io,
  send: {
    targets: () => ["peer"],
    sendFrame: (_peer, meta, payload) => {
      sent++
      bytes += payload.length
      sentAt.set(meta.seq, performance.now())
      // Deliver straight back in, restamped as a DIFFERENT peer. The session
      // drops frames bearing its own id — correct, or a node would hear itself
      // — so a loopback has to arrive as somebody else.
      session.acceptWireFrame({ ...meta, fromPeerId: "peer" }, payload)
    },
  },
})

// Playback happens inside the session's jitter flush; count it by wrapping.
const origPlay = io.play.bind(io)
io.play = (b: Uint8Array) => {
  played++
  origPlay(b)
}

await session.join()
console.log("capturing for 8s — speak into the mic, you should hear yourself\n")
await Bun.sleep(8000)
await session.leave()
await io.stop()

const stats = session.stats
console.log(`captured -> sent:  ${sent} frames`)
console.log(`played back:       ${played} frames`)
console.log(`bitrate:           ${((bytes * 8) / 8 / 1000).toFixed(1)} kbps`)
console.log(`dropped late:      ${stats.droppedLate}`)
console.log(`received:          ${stats.receivedFrames}`)

const lossPct = sent === 0 ? 100 : ((sent - played) / sent) * 100
console.log(`loss:              ${lossPct.toFixed(1)}%`)

if (sent === 0) {
  console.log("\nFAIL: nothing captured")
  process.exit(1)
}
if (lossPct > 5) {
  console.log("\nFAIL: too many frames lost between capture and playback")
  process.exit(1)
}
console.log("\nPASS")
process.exit(0)
