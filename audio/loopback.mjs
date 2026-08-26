// Pipe the sidecar's captured Opus straight back into its own playback input.
// If you hear yourself, every stage works: capture, encode, framing, decode,
// playback. Measures packet rate and size while it runs.
import { spawn } from "node:child_process"

const proc = spawn("./target/release/nex-audio.exe", { stdio: ["pipe", "pipe", "inherit"] })

let buf = Buffer.alloc(0)
let packets = 0
let bytes = 0
const started = Date.now()

proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0)
    if (buf.length < 4 + len) break
    const payload = buf.subarray(4, 4 + len)
    buf = buf.subarray(4 + len)
    packets++
    bytes += len
    // Straight back in — this is the loop.
    const framed = Buffer.alloc(4 + payload.length)
    framed.writeUInt32LE(payload.length, 0)
    payload.copy(framed, 4)
    proc.stdin.write(framed)
  }
})

setTimeout(() => {
  const secs = (Date.now() - started) / 1000
  console.log(`\npackets: ${packets} in ${secs.toFixed(1)}s`)
  console.log(`rate:    ${(packets / secs).toFixed(1)}/s   (expect ~50/s for 20ms frames)`)
  console.log(`bitrate: ${((bytes * 8) / secs / 1000).toFixed(1)} kbps`)
  console.log(`avg pkt: ${(bytes / Math.max(packets, 1)).toFixed(1)} bytes`)
  proc.kill()
  process.exit(0)
}, 6000)
