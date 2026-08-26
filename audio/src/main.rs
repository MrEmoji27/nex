// Nex audio sidecar.
//
// Bun owns the session, the transport and the jitter buffer. This process owns
// the two things a JS runtime cannot do: touching the sound card, and running
// Opus. It is deliberately small — a bug here is a crash in a process that can
// be restarted, not in the node holding your conversation.
//
// Protocol, both directions, on stdin/stdout:
//
//     [u32 little-endian length][payload]
//
// stdout payloads are Opus packets captured from the microphone.
// stdin payloads are Opus packets to play. Nothing else crosses the boundary,
// so a desynchronised stream cannot be mistaken for a command.
//
// Errors and diagnostics go to stderr, never stdout — stdout is a binary
// stream and a stray log line would corrupt the frame it lands in.

use std::io::{Read, Write};
use std::sync::mpsc;

use audiopus::coder::{Decoder, Encoder};
use audiopus::packet::Packet;
use audiopus::MutSignals;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// Opus is defined at these rates; 48k is the one every device agrees on.
const SAMPLE_RATE: u32 = 48_000;
/// 20ms — the frame size Opus is tuned for and what WebRTC and Discord both use.
/// Smaller cuts latency but costs bitrate efficiency and CPU per second.
const FRAME_MS: u32 = 20;
const FRAME_SAMPLES: usize = (SAMPLE_RATE * FRAME_MS / 1000) as usize; // 960
/// Voice is mono. Stereo would double the bitrate to carry a duplicate signal.
const CHANNELS: Channels = Channels::Mono;
/// 32 kbps: transparent for speech at 48k. Discord defaults near 64k stereo.
const BITRATE: i32 = 32_000;
const MAX_PACKET: usize = 1500;

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[nex-audio] {msg}");
}

/// Encode a tone, decode it back, and compare energy. Proves the codec path
/// carries signal rather than silence — a loopback through a quiet room looks
/// identical to a broken encoder, because Opus VBR spends almost no bits on
/// silence either way.
fn selftest() -> Result<(), String> {
    let mut enc = Encoder::new(SampleRate::Hz48000, CHANNELS, Application::Voip)
        .map_err(|e| format!("enc: {e}"))?;
    enc.set_bitrate(Bitrate::BitsPerSecond(BITRATE))
        .map_err(|e| format!("bitrate: {e}"))?;
    let mut dec = Decoder::new(SampleRate::Hz48000, CHANNELS).map_err(|e| format!("dec: {e}"))?;

    let mut pkt = vec![0u8; MAX_PACKET];
    let mut out = vec![0f32; FRAME_SAMPLES];
    let (mut sent, mut got, mut bytes) = (0f64, 0f64, 0usize);

    // 25 frames = half a second of 440 Hz at a realistic speech level.
    for f in 0..25 {
        let tone: Vec<f32> = (0..FRAME_SAMPLES)
            .map(|i| {
                let t = (f * FRAME_SAMPLES + i) as f32 / SAMPLE_RATE as f32;
                (t * 440.0 * std::f32::consts::TAU).sin() * 0.3
            })
            .collect();
        sent += tone.iter().map(|s| (s * s) as f64).sum::<f64>();

        let n = enc.encode_float(&tone, &mut pkt[..]).map_err(|e| format!("encode: {e}"))?;
        bytes += n;

        let packet = Packet::try_from(&pkt[..n]).map_err(|e| format!("packet: {e}"))?;
        let signals = MutSignals::try_from(&mut out[..]).map_err(|e| format!("signals: {e}"))?;
        let m = dec.decode_float(Some(packet), signals, false).map_err(|e| format!("decode: {e}"))?;
        got += out[..m].iter().map(|s| (s * s) as f64).sum::<f64>();
    }

    let rms_in = (sent / (25.0 * FRAME_SAMPLES as f64)).sqrt();
    let rms_out = (got / (25.0 * FRAME_SAMPLES as f64)).sqrt();
    let ratio = rms_out / rms_in;
    println!("selftest: rms in={rms_in:.4} out={rms_out:.4} ratio={ratio:.3}");
    println!("selftest: {} bytes / 25 frames = {:.1} kbps", bytes, (bytes * 8) as f64 / 0.5 / 1000.0);

    // A lossy codec will not round-trip exactly, but it must not lose the
    // signal. Anything near zero means we are shipping silence.
    if ratio < 0.5 || ratio > 2.0 {
        return Err(format!("codec did not preserve signal energy (ratio {ratio:.3})"));
    }
    println!("selftest: PASS");
    Ok(())
}

fn main() {
    if std::env::args().any(|a| a == "--selftest") {
        match selftest() {
            Ok(()) => return,
            Err(e) => {
                log(&format!("selftest FAILED: {e}"));
                std::process::exit(1);
            }
        }
    }
    if let Err(e) = run() {
        log(&format!("fatal: {e}"));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let host = cpal::default_host();

    let input = host.default_input_device().ok_or("no input device")?;
    let output = host.default_output_device().ok_or("no output device")?;
    log(&format!(
        "in={} out={}",
        input.name().unwrap_or_else(|_| "?".into()),
        output.name().unwrap_or_else(|_| "?".into())
    ));

    // Ask for 48 kHz because Opus is defined there, but take the device's own
    // channel count and buffer size. Demanding mono and a fixed buffer is what
    // WASAPI rejected: shared-mode devices publish a format and will not
    // renegotiate it. Downmixing in the callback is cheap; being refused a
    // stream is fatal.
    let in_ch = input
        .default_input_config()
        .map_err(|e| format!("input config: {e}"))?
        .channels();
    let out_default = output
        .default_output_config()
        .map_err(|e| format!("output config: {e}"))?;
    let out_ch = out_default.channels();
    // Take the output device's own rate. This one publishes 96 kHz and will not
    // accept 48; a shared-mode WASAPI endpoint does not renegotiate. Opus still
    // decodes at 48 and we resample on the way out.
    let out_rate = out_default.sample_rate().0;

    let in_cfg = cpal::StreamConfig {
        channels: in_ch,
        sample_rate: cpal::SampleRate(SAMPLE_RATE),
        buffer_size: cpal::BufferSize::Default,
    };
    let out_cfg = cpal::StreamConfig {
        channels: out_ch,
        sample_rate: cpal::SampleRate(out_rate),
        buffer_size: cpal::BufferSize::Default,
    };
    log(&format!(
        "negotiated: in {in_ch}ch@{SAMPLE_RATE} out {out_ch}ch@{out_rate}"
    ));

    // Ratio of output samples per decoded sample. 1.0 when the device runs at
    // 48 kHz and no resampling happens at all.
    let ratio = out_rate as f64 / SAMPLE_RATE as f64;

    // --- capture: mic -> Opus -> stdout -----------------------------------
    let (tx_cap, rx_cap) = mpsc::channel::<Vec<f32>>();
    let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 2);

    let in_stream = input
        .build_input_stream(
            &in_cfg,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Downmix to mono by averaging. Voice on two channels is the
                // same signal twice; encoding both would double the bitrate to
                // carry no extra information.
                if in_ch == 1 {
                    pending.extend_from_slice(data);
                } else {
                    let n = in_ch as usize;
                    for chunk in data.chunks_exact(n) {
                        pending.push(chunk.iter().sum::<f32>() / n as f32);
                    }
                }
                while pending.len() >= FRAME_SAMPLES {
                    let frame: Vec<f32> = pending.drain(..FRAME_SAMPLES).collect();
                    let _ = tx_cap.send(frame);
                }
            },
            |e| log(&format!("input stream error: {e}")),
            None,
        )
        .map_err(|e| format!("build input: {e}"))?;

    // --- playback: stdin -> Opus -> speaker --------------------------------
    let (tx_play, rx_play) = mpsc::channel::<Vec<f32>>();
    let mut play_buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 4);

    let out_stream = output
        .build_output_stream(
            &out_cfg,
            move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
                // Mono decoded audio, resampled to the device rate and fanned
                // out to however many channels it wants.
                let out_frames = data.len() / out_ch as usize;
                let want = (out_frames as f64 / ratio).ceil() as usize + 1;
                while play_buf.len() < want {
                    match rx_play.try_recv() {
                        Ok(frame) => play_buf.extend_from_slice(&frame),
                        // Underrun. Silence is the honest output: inventing
                        // samples to fill the gap is how robotic artefacts get
                        // into a call.
                        Err(_) => break,
                    }
                }
                let ch = out_ch as usize;
                let avail = play_buf.len();
                let mut written = 0usize;

                for f in 0..out_frames {
                    // Linear interpolation between neighbouring source samples.
                    // Good enough for speech; a polyphase filter would be the
                    // upgrade if this ever carries music.
                    let src = f as f64 / ratio;
                    let i0 = src.floor() as usize;
                    if i0 + 1 >= avail {
                        break;
                    }
                    let frac = (src - i0 as f64) as f32;
                    let sample = play_buf[i0] * (1.0 - frac) + play_buf[i0 + 1] * frac;
                    for c in 0..ch {
                        data[f * ch + c] = sample;
                    }
                    written = f + 1;
                }

                for s in data[written * ch..].iter_mut() {
                    *s = 0.0;
                }

                // Drop what we consumed, keeping one sample for the next
                // interpolation window.
                let consumed = ((written as f64 / ratio).floor() as usize).saturating_sub(1);
                if consumed > 0 && consumed <= play_buf.len() {
                    play_buf.drain(..consumed);
                }
            },
            |e| log(&format!("output stream error: {e}")),
            None,
        )
        .map_err(|e| format!("build output: {e}"))?;

    in_stream.play().map_err(|e| format!("play input: {e}"))?;
    out_stream.play().map_err(|e| format!("play output: {e}"))?;

    // --- stdin reader: decode incoming Opus --------------------------------
    std::thread::spawn(move || {
        let mut dec = match Decoder::new(SampleRate::Hz48000, CHANNELS) {
            Ok(d) => d,
            Err(e) => {
                log(&format!("decoder init: {e}"));
                return;
            }
        };
        let mut stdin = std::io::stdin().lock();
        let mut len_buf = [0u8; 4];
        let mut pkt = vec![0u8; MAX_PACKET];
        let mut pcm = vec![0f32; FRAME_SAMPLES];

        loop {
            if stdin.read_exact(&mut len_buf).is_err() {
                log("stdin closed");
                return;
            }
            let len = u32::from_le_bytes(len_buf) as usize;
            if len == 0 || len > MAX_PACKET {
                log(&format!("bad frame length {len}; stream desynchronised"));
                return;
            }
            if stdin.read_exact(&mut pkt[..len]).is_err() {
                return;
            }
            // audiopus wraps both sides in validated newtypes; a packet that
            // fails this conversion is malformed and must not reach the codec.
            let packet = match Packet::try_from(&pkt[..len]) {
                Ok(p) => p,
                Err(e) => {
                    log(&format!("bad packet: {e}"));
                    continue;
                }
            };
            let signals = match MutSignals::try_from(&mut pcm[..]) {
                Ok(s) => s,
                Err(e) => {
                    log(&format!("signal buffer: {e}"));
                    continue;
                }
            };
            match dec.decode_float(Some(packet), signals, false) {
                Ok(n) => {
                    let _ = tx_play.send(pcm[..n].to_vec());
                }
                Err(e) => log(&format!("decode: {e}")),
            }
        }
    });

    // --- main loop: encode captured frames to stdout -----------------------
    let mut enc = Encoder::new(SampleRate::Hz48000, CHANNELS, Application::Voip)
        .map_err(|e| format!("encoder init: {e}"))?;
    enc.set_bitrate(Bitrate::BitsPerSecond(BITRATE))
        .map_err(|e| format!("set bitrate: {e}"))?;
    // In-band FEC: the encoder carries a coarse copy of the previous frame, so a
    // single lost packet can be reconstructed instead of leaving a hole.
    let _ = enc.set_inband_fec(true);
    let _ = enc.set_packet_loss_perc(5);

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut pkt = vec![0u8; MAX_PACKET];

    log(&format!(
        "ready: {SAMPLE_RATE} Hz mono, {FRAME_MS}ms frames, {BITRATE} bps, fec on"
    ));

    while let Ok(frame) = rx_cap.recv() {
        match enc.encode_float(&frame, &mut pkt[..]) {
            Ok(n) if n > 0 => {
                if out.write_all(&(n as u32).to_le_bytes()).is_err() {
                    break;
                }
                if out.write_all(&pkt[..n]).is_err() {
                    break;
                }
                // Flush per frame. Buffering would trade the latency this whole
                // process exists to protect.
                if out.flush().is_err() {
                    break;
                }
            }
            Ok(_) => {}
            Err(e) => log(&format!("encode: {e}")),
        }
    }

    Ok(())
}
