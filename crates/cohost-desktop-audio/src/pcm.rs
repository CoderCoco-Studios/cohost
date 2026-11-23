//! Conversion of the device's native format to 16 kHz mono 16-bit PCM (EARS-SRC-014).
//!
//! The conversion is a stateful [`Resampler`]: downmix, a windowed-sinc low-pass that keeps
//! content above the 16 kHz output's Nyquist out of the band (so it cannot alias), and linear
//! phase interpolation. Output sample `k` sits at input position `k * rate / 16000` computed in
//! exact integer arithmetic, so the output does not depend on how the input is chunked.

use std::collections::VecDeque;
use std::f64::consts::PI;

const OUT_RATE: u64 = 16_000;
/// Filter half-length in input samples: 64 taps in all.
const HALF: i64 = 32;
/// The passband edge as a fraction of the output rate's Nyquist-limited band.
const PASSBAND: f64 = 0.45;
/// Taps per output sample.
const TAPS: usize = (2 * HALF) as usize;

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Streaming converter from interleaved `f32` frames to 16 kHz mono `i16`.
pub struct Resampler {
    rate: u64,
    channels: usize,
    /// Samples of a frame that has not been completed yet.
    pending: Vec<f32>,
    /// Mono input samples from absolute index `base` on.
    hist: VecDeque<f32>,
    base: i64,
    first: f32,
    last: f32,
    /// Mono input frames received.
    total_in: i64,
    /// Index of the next output sample.
    next_out: u64,
    cutoff: f64,
    /// Filter weights per fractional phase, `TAPS` per phase, before normalisation.
    weights: Vec<f64>,
    /// The sum of each phase's weights.
    norms: Vec<f64>,
    /// Phase count: `OUT_RATE / gcd(rate, OUT_RATE)`. Output phases repeat with this period.
    step: u64,
}

impl Resampler {
    /// `rate` is the device rate in Hz. A zero rate or channel count yields no output.
    pub fn new(rate: u32, channels: u16) -> Self {
        let rate = u64::from(rate);
        let cutoff = if rate == 0 {
            0.0
        } else {
            PASSBAND * (rate.min(OUT_RATE) as f64) / rate as f64
        };
        let step = if rate == 0 { 1 } else { gcd(rate, OUT_RATE) };
        let phases = (OUT_RATE / step) as usize;
        let mut this = Self {
            rate,
            channels: usize::from(channels.max(1)),
            pending: Vec::new(),
            hist: VecDeque::new(),
            base: 0,
            first: 0.0,
            last: 0.0,
            total_in: 0,
            next_out: 0,
            cutoff,
            weights: Vec::new(),
            norms: Vec::new(),
            step,
        };
        if rate > 0 {
            for p in 0..phases {
                let frac = (p as u64 * step) as f64 / OUT_RATE as f64;
                let mut norm = 0.0;
                for t in 0..TAPS {
                    // Tap t reads input sample `int - HALF + 1 + t` for an output at `int + frac`.
                    let x = frac + (HALF - 1 - t as i64) as f64;
                    let w = this.weight(x);
                    this.weights.push(w);
                    norm += w;
                }
                this.norms.push(norm);
            }
        }
        this
    }

    /// Integer part of output `k`'s input position.
    fn position(&self, k: u64) -> i64 {
        (k * self.rate / OUT_RATE) as i64
    }

    /// Index of output `k`'s fractional phase in the weight table.
    fn phase(&self, k: u64) -> usize {
        ((k * self.rate % OUT_RATE) / self.step) as usize
    }

    /// The mono input sample at absolute index `j`. Before the start and after the end the edge
    /// sample repeats, so a constant input stays constant at both ends of the feed.
    fn sample(&self, j: i64) -> f64 {
        if self.total_in == 0 {
            0.0
        } else if j < 0 {
            f64::from(self.first)
        } else if j >= self.total_in {
            f64::from(self.last)
        } else {
            f64::from(self.hist[(j - self.base) as usize])
        }
    }

    /// The windowed-sinc low-pass weight at distance `x` input samples.
    fn weight(&self, x: f64) -> f64 {
        if x.abs() >= HALF as f64 {
            return 0.0;
        }
        let arg = 2.0 * self.cutoff * x;
        let sinc = if arg == 0.0 {
            1.0
        } else {
            (PI * arg).sin() / (PI * arg)
        };
        let window = 0.5 + 0.5 * (PI * x / HALF as f64).cos();
        2.0 * self.cutoff * sinc * window
    }

    /// Output sample `k`: the filtered input at its position, normalised to unity DC gain.
    fn output(&self, k: u64) -> f32 {
        let int = self.position(k);
        let p = self.phase(k);
        let row = &self.weights[p * TAPS..(p + 1) * TAPS];
        let mut acc = 0.0;
        for (t, w) in row.iter().enumerate() {
            acc += w * self.sample(int - HALF + 1 + t as i64);
        }
        let norm = self.norms[p];
        let v = if norm == 0.0 { 0.0 } else { acc / norm };
        (v * 32_768.0)
            .round()
            .clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as f32
    }

    /// Feeds interleaved frames and returns the output that is complete. A partial frame waits
    /// for the next call.
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<i16> {
        if self.rate == 0 {
            return Vec::new();
        }
        self.pending.extend_from_slice(interleaved);
        let frames = self.pending.len() / self.channels;
        for f in 0..frames {
            let frame = &self.pending[f * self.channels..(f + 1) * self.channels];
            let mono = frame.iter().sum::<f32>() / self.channels as f32;
            if self.total_in == 0 {
                self.first = mono;
            }
            self.last = mono;
            self.hist.push_back(mono);
            self.total_in += 1;
        }
        self.pending.drain(..frames * self.channels);

        let mut out = Vec::new();
        loop {
            let int = self.position(self.next_out);
            if int + HALF >= self.total_in {
                break;
            }
            out.push(self.output(self.next_out) as i16);
            self.next_out += 1;
        }
        self.trim();
        out
    }

    /// Ends the feed: emits the remaining output, extending the last sample past the end.
    pub fn finish(&mut self) -> Vec<i16> {
        if self.rate == 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        while self.position(self.next_out) < self.total_in {
            out.push(self.output(self.next_out) as i16);
            self.next_out += 1;
        }
        out
    }

    /// Drops input no later output can reach.
    fn trim(&mut self) {
        let keep_from = self.position(self.next_out) - HALF + 1;
        while self.base < keep_from && !self.hist.is_empty() {
            self.hist.pop_front();
            self.base += 1;
        }
    }
}

/// One-shot conversion: downmixes interleaved `f32` frames to mono, resamples to 16 kHz and
/// converts to `i16`, clamping out-of-range samples to the 16-bit range.
// @spec EARS-SRC-014
pub fn to_16k_mono_i16(interleaved: &[f32], rate: u32, channels: u16) -> Vec<i16> {
    let mut r = Resampler::new(rate, channels);
    let mut out = r.push(interleaved);
    out.extend(r.finish());
    out
}
