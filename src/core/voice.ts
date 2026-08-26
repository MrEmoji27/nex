// Voice pipeline — alpha.6: provable plumbing with silent/mock audio.
//
// Shape of the whole increment (vision §19 groundwork):
//   capture -> encode -> [ encrypted transport frames ] -> decode -> playback
// Real microphone capture and real Opus playback land in the next increment;
// everything above and below the codec boundary is already real here:
// framing, sequencing, jitter buffering, loss detection, relay fan-out.
// The codec is a swappable port so "mock" can become "Opus" without touching
// any other layer.

import type { VoiceFrameMeta } from "./contract"

/** One frame of linear PCM — the only audio shape the pipeline speaks internally. */
export interface PcmFrame {
  data: Int16Array
  sampleRate: number
  channels: number
}

/** Where audio comes from. MockSource emits silence (or a test tone). */
export interface AudioSource {
  start(onFrame: (frame: PcmFrame) => void): Promise<void>
  stop(): Promise<void>
}

/** Where audio goes. MockSink counts and discards. */
export interface AudioSink {
  start(): Promise<void>
  stop(): Promise<void>
  play(frame: PcmFrame): void
}

/**
 * Compress/decompress one PcmFrame <-> bytes. The REAL codec (Opus via a
 * native binding) implements this same port; MockCodec is bit-transparent.
 */
export interface VoiceCodec {
  readonly name: string
  encode(frame: PcmFrame): Uint8Array
  decode(bytes: Uint8Array, sampleRate: number, channels: number): PcmFrame
}

export const MOCK_FRAME_MS = 20

function framesOf(ms: number, sampleRate: number): number {
  return Math.max(1, Math.round((sampleRate * ms) / 1000))
}

/** Silent source standing in for the microphone. Emits zeros at frame cadence. */
export class MockAudioSource implements AudioSource {
  private timer: Timer | undefined
  private seq = 0
  constructor(
    private readonly sampleRate = 48_000,
    private readonly channels = 1,
    private readonly frameMs = MOCK_FRAME_MS,
  ) {}

  async start(onFrame: (frame: PcmFrame) => void): Promise<void> {
    if (this.timer) return
    const samples = framesOf(this.frameMs, this.sampleRate)
    this.timer = setInterval(() => {
      onFrame({ data: new Int16Array(samples), sampleRate: this.sampleRate, channels: this.channels })
      this.seq++
    }, this.frameMs)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** How many silent frames were emitted (diagnostics/tests). */
  get emitted(): number {
    return this.seq
  }
}

/** Discarding sink standing in for speakers; counts what it was handed. */
export class MockAudioSink implements AudioSink {
  private playing = false
  private count = 0
  async start(): Promise<void> {
    this.playing = true
  }
  async stop(): Promise<void> {
    this.playing = false
  }
  play(frame: PcmFrame): void {
    if (!this.playing) return
    this.count++
    void frame
  }
  get played(): number {
    return this.count
  }
}

/** Bit-transparent codec: encodes PCM to its little-endian bytes and back. */
export class MockVoiceCodec implements VoiceCodec {
  readonly name = "mock-pcm16"
  encode(frame: PcmFrame): Uint8Array {
    const out = new Uint8Array(frame.data.length * 2)
    const view = new DataView(out.buffer)
    for (let i = 0; i < frame.data.length; i++) view.setInt16(i * 2, frame.data[i]!, true)
    return out
  }
  decode(bytes: Uint8Array, sampleRate: number, channels: number): PcmFrame {
    const samples = new Int16Array(Math.floor(bytes.length / 2))
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true)
    return { data: samples, sampleRate, channels }
  }
}

/**
 * One node's participation in ONE room's voice channel.
 *
 * Owns: mic source, encoder, per-destination send, inbound jitter buffer per
 * original speaker, decoder, speaker sink, and the speak-state callback that
 * feeds the UI's speaking rings. All transport access goes through the small
 * Send/Receive ports below, so tests drive it without sockets.
 */
export interface VoiceSendPort {
  /** peerIds currently reachable for relaying/fan-out (host or host link). */
  targets(): string[]
  sendFrame(peerId: string, meta: VoiceFrameMeta, payload: Uint8Array): void
}

export interface VoiceSessionOptions {
  roomId: string
  selfId: string
  source: AudioSource
  sink: AudioSink
  codec: VoiceCodec
  send: VoiceSendPort
  /** Speaking-state changes surface here (UI rings / headless events). */
  onSpeakingChange?(speaking: boolean): void
  /** Frame-level diagnostics hook (tests, future call-diagnostics modal). */
  onDiagnostics?(stats: VoiceStats): void
}

export interface VoiceStats {
  sentFrames: number
  receivedFrames: number
  droppedLate: number
  peersHeard: string[]
}

const JITTER_MS = 80

export class VoiceSession {
  private running = false
  private seq = 0
  private sentFrames = 0
  private receivedFrames = 0
  private droppedLate = 0
  private lastSeqBySender = new Map<string, number>()
  private bufferBySender = new Map<string, Array<{ seq: number; atMs: number; bytes: Uint8Array }>>()
  private flushTimer: Timer | undefined
  private speaking = false
  private sendEnabled = true

  constructor(private readonly options: VoiceSessionOptions) {}

  get active(): boolean {
    return this.running
  }

  get stats(): VoiceStats {
    return {
      sentFrames: this.sentFrames,
      receivedFrames: this.receivedFrames,
      droppedLate: this.droppedLate,
      peersHeard: [...this.lastSeqBySender.keys()],
    }
  }

  async join(sendJoinAnnounce?: () => void): Promise<void> {
    if (this.running) return
    this.running = true
    await this.options.sink.start()
    await this.options.source.start((frame) => this.onCaptured(frame))
    this.flushTimer = setInterval(() => this.flushDue(), 10)
    // Presence announce rides the control channel AFTER the pipeline is up.
    sendJoinAnnounce?.()
  }

  async leave(): Promise<void> {
    if (!this.running) return
    this.running = false
    await this.options.source.stop()
    await this.options.sink.stop()
    if (this.flushTimer) clearInterval(this.flushTimer)
    this.flushTimer = undefined
    this.setSpeaking(false)
  }

  setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return
    this.speaking = speaking
    this.options.onSpeakingChange?.(speaking)
  }

  /**
   * Mute semantics: the capture pipeline stays warm but frames are not sent.
   * Unmuting resumes transmission without tearing the session down.
   */
  setSendEnabled(enabled: boolean): void {
    this.sendEnabled = enabled
    if (!enabled) this.setSpeaking(false)
  }

  /** Inbound wire frame from ANY peer (host relay preserves original authorship). */
  acceptWireFrame(meta: VoiceFrameMeta, payload: Uint8Array): void {
    if (!this.running) return
    if (meta.fromPeerId === this.options.selfId) return // echo guard
    const last = this.lastSeqBySender.get(meta.fromPeerId)
    if (last !== undefined && meta.seq <= last) {
      this.droppedLate++
      return
    }
    this.lastSeqBySender.set(meta.fromPeerId, meta.seq)
    this.receivedFrames++
    const due = Date.now() + JITTER_MS
    const queue = this.bufferBySender.get(meta.fromPeerId) ?? []
    queue.push({ seq: meta.seq, atMs: due, bytes: payload })
    this.bufferBySender.set(meta.fromPeerId, queue)
  }

  // ---------- internals ----------

  private onCaptured(frame: PcmFrame): void {
    if (!this.running || !this.sendEnabled) return
    if (this.options.send.targets().length === 0) return
    const payload = this.options.codec.encode(frame)
    const meta: VoiceFrameMeta = { roomId: this.options.roomId, fromPeerId: this.options.selfId, seq: this.seq++ }
    for (const peerId of this.options.send.targets()) {
      this.options.send.sendFrame(peerId, meta, payload)
    }
    this.sentFrames++
    // Mock pipeline has no loudness to measure; treat "capturing" as speaking.
    // Real capture replaces this with an RMS threshold over recent frames.
    if (!this.speaking) this.setSpeaking(true)
  }

  private flushDue(): void {
    const now = Date.now()
    for (const [sender, queue] of this.bufferBySender) {
      let playedAny = false
      while (queue.length > 0 && queue[0]!.atMs <= now) {
        const item = queue.shift()!
        try {
          this.options.sink.play(this.options.codec.decode(item.bytes, 48_000, 1))
          playedAny = true
        } catch {
          // A bad frame skips playback; the stream keeps flowing.
        }
      }
      if (queue.length === 0) this.bufferBySender.delete(sender)
      if (playedAny) this.options.onDiagnostics?.(this.stats)
    }
  }
}
