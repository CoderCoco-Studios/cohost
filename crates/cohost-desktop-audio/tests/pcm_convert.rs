//! Conversion of a device's native format to 16 kHz mono 16-bit PCM, whatever the device format.
use cohost_desktop_audio::pcm::to_16k_mono_i16;

// @spec EARS-SRC-014
#[test]
fn stereo_48k_becomes_16k_mono_of_the_same_duration() {
    let stereo = vec![0.25_f32; 48_000 * 2];
    assert_eq!(to_16k_mono_i16(&stereo, 48_000, 2).len(), 16_000);
}

// @spec EARS-SRC-014
#[test]
fn mono_44_1k_becomes_16k_within_one_sample_of_the_same_duration() {
    let out = to_16k_mono_i16(&vec![0.25_f32; 44_100], 44_100, 1);
    assert!((out.len() as i64 - 16_000).abs() <= 1, "len {}", out.len());
}

// @spec EARS-SRC-014
#[test]
fn a_constant_level_keeps_its_level_when_the_channels_agree() {
    let out = to_16k_mono_i16(&vec![0.5_f32; 48_000 * 2], 48_000, 2);
    let mid = out[out.len() / 2];
    assert!((i32::from(mid) - 16_384).abs() <= 2, "mid {mid}");
}

// @spec EARS-SRC-014
#[test]
fn silence_stays_silence_and_overload_clamps_to_the_i16_range() {
    assert!(
        to_16k_mono_i16(&vec![0.0_f32; 16_000], 16_000, 1)
            .iter()
            .all(|s| *s == 0)
    );
    let hot = to_16k_mono_i16(&vec![1.5_f32; 16_000], 16_000, 1);
    assert!(hot.iter().all(|s| *s == i16::MAX));
}

// @spec EARS-SRC-014
#[test]
fn negative_overload_clamps_to_i16_min() {
    let cold = to_16k_mono_i16(&vec![-1.5_f32; 16_000], 16_000, 1);
    assert!(cold.iter().all(|s| *s == i16::MIN));
}
