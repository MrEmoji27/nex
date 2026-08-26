// Acoustic echo cancellation and noise suppression.
//
// Why this is hand-rolled: WebRTC's audio processing module is the right answer
// and does not build here. Its Rust wrapper needs autotools on one version and
// meson plus a C++ toolchain on the next, and the 2.1 line fails compiling
// WebRTC's own sources under MSVC. Rather than ship a Linux-only feature, this
// is a normalised least-mean-squares canceller in pure Rust.
//
// It is not AEC3. It will not match Discord in a hard room. What it does do is
// remove the common case — speaker bleed into an open microphone — on every
// platform, with no build dependencies.
//
// The part that is usually hardest is free here: an echo canceller needs the
// far-end reference signal, and because this process owns playback as well as
// capture, we already have exactly what was sent to the speaker.

use std::collections::VecDeque;

/// Filter length in samples. At 48 kHz this covers ~43 ms of echo path, which
/// spans headphone bleed and a small room. Longer tails cost CPU linearly and
/// adapt more slowly, which hurts more than the extra reach helps.
const TAPS: usize = 2048;

/// NLMS step size. Higher converges faster and rings; lower is stable and slow.
const MU: f32 = 0.35;

/// Keeps the update from exploding when the reference is near silent.
const EPS: f32 = 1e-6;

/// Freeze adaptation when near-end energy exceeds this multiple of the far-end
/// energy for the frame: both sides are talking, and adapting through that is
/// what makes a canceller learn the wrong filter and start chewing up speech.
///
/// Measured per FRAME, not per sample. An earlier version compared the
/// microphone against the running residual, which is self-defeating: the better
/// the filter got, the smaller the residual, so the guard tripped permanently
/// and adaptation stopped at 5 dB.
const DOUBLE_TALK: f32 = 2.0;

pub struct EchoCanceller {
    weights: Vec<f32>,
    /// Far-end history, newest first, TAPS long.
    reference: VecDeque<f32>,
    denoiser: Option<Box<nnnoiseless::DenoiseState<'static>>>,
    ns_in: Vec<f32>,
    ns_out: Vec<f32>,
    pub enabled: bool,
}

impl EchoCanceller {
    pub fn new(noise_suppression: bool) -> Self {
        Self {
            weights: vec![0.0; TAPS],
            reference: VecDeque::from(vec![0.0; TAPS]),
            denoiser: if noise_suppression {
                Some(nnnoiseless::DenoiseState::new())
            } else {
                None
            },
            ns_in: Vec::with_capacity(nnnoiseless::FRAME_SIZE),
            ns_out: vec![0.0; nnnoiseless::FRAME_SIZE],
            enabled: true,
        }
    }

    /// Record what was just handed to the speaker. Must be called with the same
    /// samples, in the same order, that playback received — a reference that
    /// drifts from what was actually played is worse than no canceller, because
    /// the filter then subtracts a signal that was never in the room.
    pub fn push_reference(&mut self, played: &[f32]) {
        for &s in played {
            self.reference.push_front(s);
            self.reference.pop_back();
        }
    }

    /// Remove echo from one captured frame, in place.
    pub fn process(&mut self, mic: &mut [f32]) {
        if self.enabled {
            self.cancel(mic);
        }
        if self.denoiser.is_some() {
            self.suppress_noise(mic);
        }
    }

    fn cancel(&mut self, mic: &mut [f32]) {
        // Frame-level gate, decided once before adapting.
        let near: f32 = mic.iter().map(|s| s * s).sum();
        let far: f32 = self.reference.iter().take(mic.len()).map(|s| s * s).sum();
        let far_active = far > EPS;
        let double_talk = near > DOUBLE_TALK * far;
        let adapt = far_active && !double_talk;

        for sample in mic.iter_mut() {
            // Estimate the echo currently arriving, as a weighted sum of what
            // we recently played.
            let mut estimate = 0.0f32;
            let mut energy = 0.0f32;
            for (w, r) in self.weights.iter().zip(self.reference.iter()) {
                estimate += w * r;
                energy += r * r;
            }

            let residual = *sample - estimate;

            if adapt && energy > EPS {
                let step = MU / (energy + EPS);
                for (w, r) in self.weights.iter_mut().zip(self.reference.iter()) {
                    *w += step * residual * r;
                }
            }

            *sample = residual;
        }
    }

    fn suppress_noise(&mut self, mic: &mut [f32]) {
        let Some(denoiser) = self.denoiser.as_mut() else { return };
        // RNNoise works on fixed 480-sample frames at 48 kHz and expects i16
        // range, not the -1..1 that cpal hands us.
        for chunk in mic.chunks_mut(nnnoiseless::FRAME_SIZE) {
            if chunk.len() < nnnoiseless::FRAME_SIZE {
                break;
            }
            self.ns_in.clear();
            self.ns_in.extend(chunk.iter().map(|s| s * 32768.0));
            denoiser.process_frame(&mut self.ns_out[..], &self.ns_in[..]);
            for (dst, src) in chunk.iter_mut().zip(self.ns_out.iter()) {
                *dst = src / 32768.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Simulate a room: the microphone hears a delayed, attenuated copy of what
    /// the speaker played. A working canceller drives that copy toward zero.
    #[test]
    fn cancels_a_synthetic_echo() {
        let mut aec = EchoCanceller::new(false);
        let delay = 120usize;
        let gain = 0.6f32;

        let mut far_history = vec![0.0f32; delay];
        let mut before = 0.0f64;
        let mut after = 0.0f64;
        let mut n = 0u32;

        // 400 frames of 480 samples = 4 seconds, enough for NLMS to converge.
        for f in 0..400 {
            let far: Vec<f32> = (0..480)
                .map(|i| {
                    let t = (f * 480 + i) as f32 / 48_000.0;
                    // Two tones so the reference is not a single frequency,
                    // which any filter can cancel trivially.
                    (t * 300.0 * std::f32::consts::TAU).sin() * 0.4
                        + (t * 1100.0 * std::f32::consts::TAU).sin() * 0.2
                })
                .collect();

            // What the mic picks up: the echo alone, so residual is measurable.
            far_history.extend_from_slice(&far);
            let echo: Vec<f32> = far_history[..480].iter().map(|s| s * gain).collect();
            far_history.drain(..480);

            let mut mic = echo.clone();
            aec.push_reference(&far);
            aec.process(&mut mic);

            // Skip the convergence period before scoring.
            if f >= 300 {
                for (e, r) in echo.iter().zip(mic.iter()) {
                    before += (e * e) as f64;
                    after += (r * r) as f64;
                    n += 1;
                }
            }
        }

        let rms_before = (before / n as f64).sqrt();
        let rms_after = (after / n as f64).sqrt();
        let erle_db = 20.0 * (rms_before / rms_after.max(1e-12)).log10();
        println!("echo before={rms_before:.5} after={rms_after:.5} ERLE={erle_db:.1} dB");

        // Echo return loss enhancement. 6 dB is a 2x reduction — a low bar, set
        // deliberately: this asserts the filter converges at all, not that it
        // matches AEC3.
        assert!(erle_db > 6.0, "AEC achieved only {erle_db:.1} dB ERLE");
    }
}
