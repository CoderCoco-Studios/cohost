//! Conversion of the device's native format to 16 kHz mono 16-bit PCM (EARS-SRC-014).

const OUT_RATE: u64 = 16_000;

/// Downmixes interleaved `f32` frames to mono by averaging the channels, resamples linearly to
/// 16 kHz, and converts to `i16`, clamping out-of-range samples to the 16-bit range.
// @spec EARS-SRC-014
pub fn to_16k_mono_i16(interleaved: &[f32], rate: u32, channels: u16) -> Vec<i16> {
    if rate == 0 {
        return Vec::new();
    }
    let ch = usize::from(channels.max(1));
    let mono: Vec<f32> = interleaved
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect();
    if mono.is_empty() {
        return Vec::new();
    }
    let out_len = (mono.len() as u64 * OUT_RATE / u64::from(rate)) as usize;
    let step = f64::from(rate) / OUT_RATE as f64;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * step;
            let idx = pos.floor() as usize;
            let frac = (pos - idx as f64) as f32;
            let a = mono[idx.min(mono.len() - 1)];
            let b = mono[(idx + 1).min(mono.len() - 1)];
            let v = f64::from(a + (b - a) * frac) * 32_768.0;
            v.round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
        })
        .collect()
}
