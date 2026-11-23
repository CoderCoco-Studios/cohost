//! Clip cutting against a synthetic PCM feed; no audio device. The exact `--silence-ms` and `--max-clip-ms`
//! boundary tick and the `--silence-level` scale are unspecified (see the issue #231 edge audit), so these tests
//! stay clear of them.
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
    // silence_level 0: a sample is audible when it is above zero in magnitude, so zeros are silence on any scale.
    ClipCutter::new(ClipConfig { silence_ms, max_clip_ms, silence_level: 0 })
}
fn feed(c: &mut ClipCutter, pcm: &[i16], chunk: usize) -> Vec<Vec<i16>> {
    pcm.chunks(chunk).flat_map(|p| c.push(p)).collect()
}

// @spec EARS-SRC-015
#[test]
fn a_feed_that_never_pauses_is_cut_at_max_clip_ms() {
    let mut c = cutter(300, 1000);
    let clips = feed(&mut c, &loud(2500), 160);
    assert_eq!(clips.len(), 2);
    assert!(clips.iter().all(|k| k.len() == ms(1000)));
}

// @spec EARS-SRC-015
#[test]
fn an_all_silent_feed_posts_no_clip() {
    let mut c = cutter(300, 1000);
    assert!(feed(&mut c, &quiet(10_000), 160).is_empty());
    assert!(c.finish().is_none());
}

// @spec EARS-SRC-015
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

// @spec EARS-SRC-015
#[test]
fn a_pause_much_shorter_than_silence_ms_does_not_split_a_clip() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(200);
    pcm.extend(quiet(50));
    pcm.extend(loud(200));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160).len(), 1);
}

// @spec EARS-SRC-015
#[test]
fn two_bursts_separated_by_well_over_silence_ms_are_two_clips() {
    let mut c = cutter(300, 10_000);
    let mut pcm = loud(400);
    pcm.extend(quiet(1000));
    pcm.extend(loud(400));
    pcm.extend(quiet(1000));
    assert_eq!(feed(&mut c, &pcm, 160).len(), 2);
}

// @spec EARS-SRC-015
#[test]
fn the_cut_does_not_depend_on_how_the_feed_is_chunked() {
    let mut pcm = loud(400);
    pcm.extend(quiet(1000));
    pcm.extend(loud(2200));
    let whole = feed(&mut cutter(300, 1000), &pcm, pcm.len());
    let small = feed(&mut cutter(300, 1000), &pcm, 97);
    assert_eq!(whole, small);
}
