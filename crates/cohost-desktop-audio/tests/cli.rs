//! Flag and environment parsing for the helper's command line.
use cohost_desktop_audio::cli::Options;
use cohost_desktop_audio::post::DEFAULT_URL;

fn parse(args: &[&str], env: &[(&str, &str)]) -> Options {
    Options::parse(args, env).unwrap()
}

// @spec EARS-SRC-015
#[test]
fn the_defaults_are_ears_loopback_the_local_redis_and_the_cohost_prefix() {
    let o = parse(&[], &[]);
    assert_eq!(o.url, DEFAULT_URL);
    assert_eq!(o.redis_url, "redis://127.0.0.1:6379");
    assert_eq!(o.prefix, "cohost");
}

// @spec EARS-SRC-015
#[test]
fn url_redis_url_and_prefix_flags_override_the_defaults() {
    let o = parse(
        &[
            "--url",
            "http://h:1/audio?source=desktop",
            "--redis-url",
            "redis://r:2",
            "--prefix",
            "t1",
        ],
        &[],
    );
    assert_eq!(
        (o.url.as_str(), o.redis_url.as_str(), o.prefix.as_str()),
        ("http://h:1/audio?source=desktop", "redis://r:2", "t1")
    );
}

// @spec EARS-SRC-015
#[test]
fn redis_url_comes_from_the_environment_and_the_flag_wins() {
    assert_eq!(
        parse(&[], &[("REDIS_URL", "redis://env:3")]).redis_url,
        "redis://env:3"
    );
    assert_eq!(
        parse(
            &["--redis-url", "redis://flag:4"],
            &[("REDIS_URL", "redis://env:3")]
        )
        .redis_url,
        "redis://flag:4"
    );
}

// @spec EARS-SRC-017
#[test]
fn the_clip_flags_default_to_700_15000_and_500_and_can_be_set() {
    let d = parse(&[], &[]).clip;
    assert_eq!(
        (d.silence_ms, d.max_clip_ms, d.silence_level),
        (700, 15_000, 500)
    );
    let o = parse(
        &[
            "--silence-ms",
            "400",
            "--max-clip-ms",
            "9000",
            "--silence-level",
            "900",
        ],
        &[],
    )
    .clip;
    assert_eq!(
        (o.silence_ms, o.max_clip_ms, o.silence_level),
        (400, 9_000, 900)
    );
}

// @spec EARS-SRC-021
#[test]
fn the_token_follows_the_flag_then_the_environment_and_an_empty_value_is_unset() {
    assert_eq!(
        parse(&["--token", "a"], &[("EARS_HTTP_TOKEN", "b")])
            .token
            .as_deref(),
        Some("a")
    );
    assert_eq!(
        parse(&[], &[("EARS_HTTP_TOKEN", "b")]).token.as_deref(),
        Some("b")
    );
    assert_eq!(
        parse(&["--token", ""], &[("EARS_HTTP_TOKEN", "")]).token,
        None
    );
}

// @spec EARS-SRC-018
#[test]
fn device_is_optional() {
    assert_eq!(parse(&[], &[]).device, None);
    assert_eq!(
        parse(&["--device", "x.monitor"], &[]).device.as_deref(),
        Some("x.monitor")
    );
}

// @spec EARS-SRC-015
#[test]
fn an_unknown_flag_is_an_error() {
    assert!(Options::parse(&["--nope"], &[]).is_err());
}

// @spec EARS-SRC-017
#[test]
fn a_zero_clip_length_is_rejected() {
    assert!(Options::parse(&["--silence-ms", "0"], &[]).is_err());
    assert!(Options::parse(&["--max-clip-ms", "0"], &[]).is_err());
}

// @spec EARS-SRC-017
#[test]
fn clip_lengths_and_the_silence_level_have_upper_bounds() {
    assert!(Options::parse(&["--silence-ms", "10000"], &[]).is_ok());
    assert!(Options::parse(&["--silence-ms", "10001"], &[]).is_err());
    assert!(Options::parse(&["--max-clip-ms", "60000"], &[]).is_ok());
    assert!(Options::parse(&["--max-clip-ms", "60001"], &[]).is_err());
    assert!(Options::parse(&["--silence-level", "32767"], &[]).is_ok());
    assert!(Options::parse(&["--silence-level", "32768"], &[]).is_err());
}

// @spec EARS-SRC-015
#[test]
fn an_empty_prefix_is_rejected() {
    assert!(Options::parse(&["--prefix", ""], &[]).is_err());
}

// @spec EARS-SRC-021
#[test]
fn a_token_with_a_line_break_is_rejected_from_the_flag_or_the_environment() {
    assert!(Options::parse(&["--token", "a\r\nX-Evil: 1"], &[]).is_err());
    assert!(Options::parse(&[], &[("EARS_HTTP_TOKEN", "a\nb")]).is_err());
}

// @spec EARS-SRC-015
#[test]
fn a_url_must_be_http_with_a_host_and_a_valid_port() {
    for bad in [
        "ftp://h/x",
        "https://h/x",
        "http:///x",
        "http://h:0/x",
        "http://h:99999/x",
        "http://h:abc/x",
        "http://u@h/x",
        "http://[::1/x",
    ] {
        assert!(
            Options::parse(&["--url", bad], &[]).is_err(),
            "{bad} accepted"
        );
    }
    assert!(Options::parse(&["--url", "http://[::1]:8765/audio?source=desktop"], &[]).is_ok());
}

// @spec EARS-SRC-015
#[test]
fn a_non_loopback_url_with_a_token_warns() {
    let warned = Options::parse(
        &["--url", "http://192.168.1.5:8765/audio", "--token", "t"],
        &[],
    )
    .unwrap();
    assert_eq!(warned.warnings.len(), 1);
    assert!(
        Options::parse(&["--url", "http://192.168.1.5:8765/audio"], &[])
            .unwrap()
            .warnings
            .is_empty()
    );
    assert!(
        Options::parse(&["--token", "t"], &[])
            .unwrap()
            .warnings
            .is_empty()
    );
    assert!(
        Options::parse(
            &["--url", "http://localhost:8765/audio", "--token", "t"],
            &[]
        )
        .unwrap()
        .warnings
        .is_empty()
    );
}
