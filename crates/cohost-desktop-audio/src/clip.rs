//! Clip cutting (EARS-SRC-017): closes a clip at silence or at the length cap.

use std::collections::VecDeque;

/// Samples per millisecond of the 16 kHz feed.
const SAMPLES_PER_MS: usize = 16;
/// The clip's leading and trailing padding, capped at `silence_ms` when that is shorter.
const PAD_MS: u32 = 100;

/// The cut settings from `--silence-ms`, `--max-clip-ms` and `--silence-level`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClipConfig {
    pub silence_ms: u32,
    pub max_clip_ms: u32,
    /// A sample is audible when its absolute 16-bit value is greater than this.
    pub silence_level: u16,
}

impl Default for ClipConfig {
    fn default() -> Self {
        Self {
            silence_ms: 700,
            max_clip_ms: 15_000,
            silence_level: 500,
        }
    }
}

fn samples(ms: u32) -> usize {
    ms as usize * SAMPLES_PER_MS
}

/// A clip being built: audio from its leading pad through the last audible sample seen so far.
struct Open {
    samples: Vec<i16>,
    /// Length of `samples` up to and including the last audible sample.
    audible_end: usize,
    /// Non-audible samples at the end of `samples`.
    silent_run: usize,
}

/// Cuts a 16 kHz mono feed into clips. Feed it with [`ClipCutter::push`] and call
/// [`ClipCutter::finish`] when the feed ends.
pub struct ClipCutter {
    silence_n: usize,
    pad_n: usize,
    max_n: usize,
    level: u16,
    /// Silent samples since the previous clip's end, at most `pad_n` of them.
    idle: VecDeque<i16>,
    open: Option<Open>,
}

impl ClipCutter {
    pub fn new(cfg: ClipConfig) -> Self {
        Self {
            silence_n: samples(cfg.silence_ms),
            pad_n: samples(cfg.silence_ms.min(PAD_MS)),
            max_n: samples(cfg.max_clip_ms),
            level: cfg.silence_level,
            idle: VecDeque::new(),
            open: None,
        }
    }

    fn audible(&self, sample: i16) -> bool {
        sample.unsigned_abs() > self.level
    }

    /// Feeds samples and returns the clips that closed, in order.
    // @spec EARS-SRC-017
    pub fn push(&mut self, pcm: &[i16]) -> Vec<Vec<i16>> {
        pcm.iter().filter_map(|&s| self.step(s)).collect()
    }

    /// Ends the feed: returns the held clip, cut like any other, or `None` when nothing audible
    /// is held.
    // @spec EARS-SRC-019, EARS-SRC-022
    pub fn finish(&mut self) -> Option<Vec<i16>> {
        self.idle.clear();
        let open = self.open.take()?;
        let keep = open.audible_end + open.silent_run.min(self.pad_n);
        Some(truncated(open.samples, keep))
    }

    fn step(&mut self, sample: i16) -> Option<Vec<i16>> {
        let audible = self.audible(sample);
        if self.open.is_none() {
            if !audible {
                self.idle.push_back(sample);
                while self.idle.len() > self.pad_n {
                    self.idle.pop_front();
                }
                return None;
            }
            // The leading pad may not fill the cap by itself: the sample that starts the clip must fit.
            let keep = self.pad_n.min(self.max_n.saturating_sub(1));
            while self.idle.len() > keep {
                self.idle.pop_front();
            }
            self.open = Some(Open {
                samples: self.idle.drain(..).collect(),
                audible_end: 0,
                silent_run: 0,
            });
        }
        let open = self.open.as_mut()?;
        open.samples.push(sample);
        if audible {
            open.audible_end = open.samples.len();
            open.silent_run = 0;
        } else {
            open.silent_run += 1;
        }
        if open.samples.len() >= self.max_n {
            // The cap cut holds exactly `max_n` samples and the next clip starts after it, with no leading pad.
            self.idle.clear();
            return self.open.take().map(|o| o.samples);
        }
        if open.silent_run >= self.silence_n {
            return self.open.take().map(|o| self.close_on_silence(o));
        }
        None
    }

    /// Keeps the trailing pad and drops the rest of the closing silence. The last pad's worth of
    /// the dropped silence becomes the next clip's leading pad candidate, never reaching back
    /// before this clip's end.
    fn close_on_silence(&mut self, open: Open) -> Vec<i16> {
        let keep = open.audible_end + self.pad_n;
        let dropped = &open.samples[keep..];
        self.idle.clear();
        let from = dropped.len().saturating_sub(self.pad_n);
        self.idle.extend(dropped[from..].iter().copied());
        truncated(open.samples, keep)
    }
}

fn truncated(mut samples: Vec<i16>, len: usize) -> Vec<i16> {
    samples.truncate(len);
    samples
}
