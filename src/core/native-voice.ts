// Bridge to the native audio sidecar (audio/, Rust).
//
// The mock pipeline assumed JavaScript could hold PCM and run a codec. It can
// hold PCM, but it cannot run Opus, and shipping raw PCM over a pipe just to
// encode it somewhere else would add a copy and a hop to the one path where
// latency is the whole product. So capture-and-encode live together in the
// sidecar, and this module speaks the only thing that crosses the boundary:
// already-encoded Opus frames.
//
// That is why VoiceSession takes an `encoded` port as an alternative to the
// source/codec/sink trio rather than a native implementation of them — a
// PcmFrame whose bytes are secretly Opus would be a lie the type system would
// let us tell.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/** Already-encoded audio, the only shape that crosses the native boundary. */
export interface EncodedAudioIo {
  /** Begin capturing. `onFrame` receives one Opus packet per 20ms. */
  start(onFrame: (opus: Uint8Array) => void): Promise<void>
  stop(): Promise<void>
  /** Hand one Opus packet to the speaker. */
  play(opus: Uint8Array): void
  readonly name: string
}

const MAX_PACKET = 1500

function sidecarPath(): string | null {
  const exe = process.platform === "win32" ? "nex-audio.exe" : "nex-audio"
  const candidates = [
    join(process.cwd(), "audio", "target", "release", exe),
    join(process.cwd(), "bin", exe),
    // Beside the packaged binary, which is where the installer puts it.
    join(process.execPath, "..", exe),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function nativeVoiceAvailable(): boolean {
  return sidecarPath() !== null
}

/**
 * Opus frames over the sidecar's stdio, length-prefixed both ways.
 *
 * The sidecar is a separate process on purpose: a fault in audio drivers or in
 * the codec kills something restartable instead of the node holding the
 * conversation.
 */
export class NativeVoiceIo implements EncodedAudioIo {
  readonly name = "opus-native"
  private proc: ChildProcessWithoutNullStreams | undefined
  private buf: Buffer = Buffer.alloc(0)

  async start(onFrame: (opus: Uint8Array) => void): Promise<void> {
    const bin = sidecarPath()
    if (!bin) throw new Error("nex-audio sidecar not found; build it with: cd audio && cargo build --release")

    const proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] })
    this.proc = proc

    proc.stdout.on("data", (chunk: Buffer) => {
      this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
      for (;;) {
        if (this.buf.length < 4) return
        const len = this.buf.readUInt32LE(0)
        // A length outside the codec's range means the stream desynchronised.
        // Reading on would feed noise to the decoder, so stop instead.
        if (len === 0 || len > MAX_PACKET) {
          this.buf = Buffer.alloc(0)
          proc.stderr.emit("data", Buffer.from(`framing error: length ${len}\n`))
          return
        }
        if (this.buf.length < 4 + len) return
        onFrame(new Uint8Array(this.buf.subarray(4, 4 + len)))
        this.buf = this.buf.subarray(4 + len)
      }
    })

    // The sidecar logs to stderr precisely so stdout stays a clean binary
    // stream; surface it rather than swallowing a driver failure.
    proc.stderr.on("data", (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.error(line)
    })

    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`sidecar exited early (code ${code})`))
      proc.once("exit", onExit)
      // It prints a ready line once both streams are open; a short settle is
      // enough and avoids a handshake the protocol does not otherwise need.
      setTimeout(() => {
        proc.off("exit", onExit)
        resolve()
      }, 300)
    })
  }

  play(opus: Uint8Array): void {
    const proc = this.proc
    if (!proc || proc.killed) return
    const framed = Buffer.allocUnsafe(4 + opus.length)
    framed.writeUInt32LE(opus.length, 0)
    Buffer.from(opus).copy(framed, 4)
    proc.stdin.write(framed)
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.buf = Buffer.alloc(0)
    if (!proc) return
    proc.stdin.end()
    proc.kill()
  }
}
