//! Clip cutting (EARS-SRC-017) against a synthetic PCM feed; no audio device.
use cohost_desktop_audio::clip::{ClipConfig, ClipCutter};

const RATE: usize = 16_000;
const LOUD: i16 = 8_000;

fn ms(n: usize) -> usize {
    n * RATE / 1000
}
fn loud(n_ms: usize) -> Vec<i16> {
    vec![LOUD; ms(n_ms)]
}
fn quiet(n_ms: usize) -> Vec<i16> {
    vec![0; ms(n_ms)]
}
fn cutter(silence_ms: u32, max_clip_ms: u32) -> ClipCutter {
    ClipCutter::new(ClipConfig {
        silence_ms,
        max_clip_ms,
        silence_level: 500,
    })
}
fn feed(c: &mut ClipCutter, pcm: &[i16], chunk: usize) -> Vec<Vec<i16>> {
    pcm.chunks(chunk).flat_map(|p| c.push(p)).collect()
}

// @spec EARS-SRC-017
#[test]
fn a_feed_that_never_pauses_is_cut_at_max_clip_ms() {
    let mut c = cutter(300, 1000);
    let clips = feed(&mut c, &loud(2500), 160);
    assert_eq!(clips.len(), 2);
    assert!(clips.iter().all(|k| k.len() == ms(1000)));
}

// @spec EARS-SRC-017
#[test]
fn an_all_silent_feed_posts_no_clip() {
    let mut c = cutter(300, 1000);
    assert!(feed(&mut c, &quiet(10_000), 160).is_empty());
    assert!(c.finish().is_none());
}

// @spec EARS-SRC-017
#[test]
fn speech_followed_by_silence_well_past_silence_ms_closes_one_clip_holding_the_speech() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(500);
    pcm.extend(quiet(1000));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips.len(), 1);
    assert!(clips[0].len() >= ms(500));
    assert_eq!(clips[0].iter().filter(|s| **s == LOUD).count(), ms(500));
}

// @spec EARS-SRC-017
#[test]
fn a_pause_much_shorter_than_silence_ms_does_not_split_a_clip() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(200);
    pcm.extend(quiet(50));
    pcm.extend(loud(200));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160).len(), 1);
}

// @spec EARS-SRC-017
#[test]
fn two_bursts_separated_by_well_over_silence_ms_are_two_clips() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(400);
    pcm.extend(quiet(1000));
    pcm.extend(loud(400));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160).len(), 2);
}

// @spec EARS-SRC-017
#[test]
fn the_cut_does_not_depend_on_how_the_feed_is_chunked() {
    let mut pcm = loud(400);
    pcm.extend(quiet(1000));
    pcm.extend(loud(2200));
    let whole = feed(&mut cutter(300, 1000), &pcm, pcm.len());
    let small = feed(&mut cutter(300, 1000), &pcm, 97);
    assert_eq!(whole, small);
}

// @spec EARS-SRC-017
#[test]
fn the_defaults_are_700_ms_15_s_and_level_500() {
    let d = ClipConfig::default();
    assert_eq!(
        (d.silence_ms, d.max_clip_ms, d.silence_level),
        (700, 15_000, 500)
    );
}

// @spec EARS-SRC-017
#[test]
fn a_silent_run_of_exactly_silence_ms_closes_the_clip_and_one_sample_less_does_not() {
    let mut speech = loud(400);
    let mut c = cutter(300, 10_000);
    speech.extend(vec![0; ms(300) - 1]);
    assert!(c.push(&speech).is_empty());
    assert_eq!(c.push(&[0]).len(), 1);
}

// @spec EARS-SRC-017
#[test]
fn a_sample_at_the_level_is_silence_and_one_above_it_is_audible() {
    let mut c = cutter(300, 10_000);
    let mut at = vec![500_i16, -500];
    at.extend(quiet(2000));
    assert!(c.push(&at).is_empty());
    let mut above = vec![501_i16];
    above.extend(quiet(2000));
    assert_eq!(c.push(&above).len(), 1);
}

// @spec EARS-SRC-017
#[test]
fn a_clip_is_padded_100_ms_each_side_of_the_audible_span_and_the_closing_silence_is_dropped() {
    let mut c = cutter(300, 10_000);
    let mut pcm = quiet(1000);
    pcm.extend(loud(500));
    pcm.extend(quiet(1000));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips.len(), 1);
    assert_eq!(clips[0].len(), ms(100) + ms(500) + ms(100));
    assert!(clips[0][..ms(100)].iter().all(|s| *s == 0));
    assert_eq!(clips[0][ms(100)], LOUD);
}

// @spec EARS-SRC-017
#[test]
fn the_pad_is_silence_ms_when_that_is_shorter_than_100_ms() {
    let mut c = cutter(40, 10_000);
    let mut pcm = quiet(1000);
    pcm.extend(loud(500));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160)[0].len(), ms(40) + ms(500) + ms(40));
}

// @spec EARS-SRC-019, EARS-SRC-022
#[test]
fn finish_returns_the_clip_held_when_the_feed_ends_cut_like_any_other() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(400);
    pcm.extend(quiet(100));
    assert!(c.push(&pcm).is_empty());
    assert_eq!(c.finish().unwrap().len(), ms(400) + ms(100));
    assert!(c.finish().is_none());
}

// @spec EARS-SRC-019, EARS-SRC-022
#[test]
fn finish_with_only_silence_held_returns_nothing() {
    let mut c = cutter(300, 10_000);
    c.push(&quiet(200));
    assert!(c.finish().is_none());
}

// @spec EARS-SRC-017
#[test]
fn the_leading_pad_takes_whatever_audio_is_available_at_the_start_of_the_feed() {
    let mut c = cutter(300, 10_000);
    let mut pcm = quiet(30);
    pcm.extend(loud(500));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160)[0].len(), ms(30) + ms(500) + ms(100));
}

// @spec EARS-SRC-017
#[test]
fn the_leading_pad_never_reaches_back_before_the_end_of_the_previous_clip() {
    // silence_ms 100: the first clip's trailing pad takes the whole 100 ms gap, so the second has no leading pad.
    let mut c = cutter(100, 10_000);
    let mut pcm = loud(400);
    pcm.extend(quiet(100));
    pcm.extend(loud(400));
    pcm.extend(quiet(1000));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips.len(), 2);
    assert_eq!(clips[0].len(), ms(400) + ms(100));
    assert_eq!(clips[1].len(), ms(400) + ms(100));
    assert_eq!(clips[1][0], LOUD);
}

// @spec EARS-SRC-017
#[test]
fn the_leading_pad_counts_toward_max_clip_ms() {
    let mut c = cutter(300, 1000);
    let mut pcm = quiet(1000);
    pcm.extend(loud(2000));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips[0].len(), ms(1000));
    assert!(clips[0][..ms(100)].iter().all(|s| *s == 0));
    assert_eq!(clips[0][ms(100)], LOUD);
}

// @spec EARS-SRC-017
#[test]
fn the_clip_after_a_cap_cut_starts_at_the_next_sample_with_no_leading_pad() {
    let mut c = cutter(300, 1000);
    let mut pcm: Vec<i16> = vec![LOUD; ms(1000)];
    pcm.extend(vec![LOUD + 1; ms(500)]);
    pcm.extend(quiet(1000));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips[0].len(), ms(1000));
    assert_eq!(clips[1][0], LOUD + 1);
    assert_eq!(clips[1].len(), ms(500) + ms(100));
}

// @spec EARS-SRC-017
#[test]
fn a_silence_run_ending_on_the_cap_sample_still_trims_the_closing_silence() {
    let mut c = cutter(300, 1000);
    let mut pcm = loud(700);
    pcm.extend(quiet(300));
    let clips = feed(&mut c, &pcm, 160);
    assert_eq!(clips.len(), 1);
    assert_eq!(clips[0].len(), ms(700) + ms(100));
}
