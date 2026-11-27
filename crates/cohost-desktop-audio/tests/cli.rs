//! Flag and environment parsing for the helper's command line.
use cohost_desktop_audio::cli::Options;
use cohost_desktop_audio::post::{DEFAULT_URL, listener_key};

/// A control token as the installer makes one, and the listener key derived from it
/// (HMAC-SHA256 of `cohost/ears-listener/v1`, control-plane CTRL-RUNTIME-017).
const TOKEN: &str = "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed";
const KEY: &str = "67ed33ea3112c4bf1508bfca5a994b3c32d7de97ebf774f9cd18fc085f7517fb";
/// An environment holding the control token, so a parse fails only for the problem under test.
const WITH: &[(&str, &str)] = &[("CONTROL_TOKEN", TOKEN)];

/// Parses with `CONTROL_TOKEN` set unless `env` sets it.
fn parse(args: &[&str], env: &[(&str, &str)]) -> Options {
    let mut e = env.to_vec();
    if !e.iter().any(|(k, _)| *k == "CONTROL_TOKEN") {
        e.push(("CONTROL_TOKEN", TOKEN));
    }
    Options::parse(args, &e).unwrap()
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
            "--allow-remote",
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
fn the_key_is_derived_from_control_token_or_the_overriding_flag_trimmed_and_never_the_token() {
    assert_eq!(listener_key(TOKEN), KEY);
    assert_eq!(
        parse(&[], &[]).key,
        KEY,
        "from CONTROL_TOKEN in the environment"
    );
    assert_eq!(
        parse(&[], &[("CONTROL_TOKEN", &format!("  {TOKEN}\t"))]).key,
        KEY,
        "the token is trimmed before the key is derived"
    );
    assert_eq!(
        parse(&["--token", TOKEN], &[("CONTROL_TOKEN", "other")]).key,
        KEY,
        "a non-empty --token overrides the environment"
    );
    assert_eq!(
        parse(&["--token", ""], &[]).key,
        KEY,
        "an empty --token is the same as none"
    );
    let o = parse(&[], &[]);
    assert_ne!(o.key, TOKEN);
    assert!(!format!("{o:?}").contains(TOKEN), "the token is not kept");
}

// @spec EARS-SRC-021
#[test]
fn without_a_token_from_the_flag_or_the_environment_parsing_fails_naming_both() {
    for (args, env) in [
        (&[][..], &[][..]),
        (&[][..], &[("CONTROL_TOKEN", "")][..]),
        (&["--token", ""][..], &[("CONTROL_TOKEN", "")][..]),
    ] {
        let err = Options::parse(args, env).unwrap_err().to_string();
        assert!(
            err.contains("CONTROL_TOKEN") && err.contains("--token"),
            "{err}"
        );
    }
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
    assert!(Options::parse(&["--nope"], WITH).is_err());
}

// @spec EARS-SRC-017
#[test]
fn a_zero_clip_length_is_rejected() {
    assert!(Options::parse(&["--silence-ms", "0"], WITH).is_err());
    assert!(Options::parse(&["--max-clip-ms", "0"], WITH).is_err());
}

// @spec EARS-SRC-017
#[test]
fn clip_lengths_and_the_silence_level_have_upper_bounds() {
    assert!(Options::parse(&["--silence-ms", "10000"], WITH).is_ok());
    assert!(Options::parse(&["--silence-ms", "10001"], WITH).is_err());
    assert!(Options::parse(&["--max-clip-ms", "60000"], WITH).is_ok());
    assert!(Options::parse(&["--max-clip-ms", "60001"], WITH).is_err());
    assert!(Options::parse(&["--silence-level", "32767"], WITH).is_ok());
    assert!(Options::parse(&["--silence-level", "32768"], WITH).is_err());
}

// @spec EARS-SRC-015
#[test]
fn an_empty_prefix_is_rejected() {
    assert!(Options::parse(&["--prefix", ""], WITH).is_err());
}

// @spec EARS-SRC-021
#[test]
fn a_token_with_a_line_break_is_rejected_from_the_flag_or_the_environment() {
    assert!(Options::parse(&["--token", "a\r\nX-Evil: 1"], WITH).is_err());
    assert!(Options::parse(&[], &[("CONTROL_TOKEN", "a\nb")]).is_err());
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
            Options::parse(&["--url", bad], WITH).is_err(),
            "{bad} accepted"
        );
    }
    assert!(Options::parse(&["--url", "http://[::1]:8765/audio?source=desktop"], WITH).is_ok());
}

// @spec EARS-SRC-015
#[test]
fn a_non_loopback_url_is_a_usage_error_unless_allow_remote_is_given_which_warns() {
    let remote = ["--url", "http://192.168.1.5:8765/audio"];
    let err = Options::parse(&remote, WITH).unwrap_err().to_string();
    assert!(err.contains("--allow-remote"), "{err}");
    let allowed = Options::parse(&[&remote[..], &["--allow-remote"]].concat(), WITH).unwrap();
    assert_eq!(allowed.warnings.len(), 1);
    assert!(
        allowed.warnings[0].contains("unencrypted"),
        "{:?}",
        allowed.warnings
    );
    for local in [
        "http://localhost:8765/audio",
        "http://127.0.0.2:8765/audio",
        "http://[::1]:8765/audio",
    ] {
        let o = Options::parse(&["--url", local], WITH).unwrap();
        assert!(o.warnings.is_empty(), "{local}");
    }
    assert!(Options::parse(&[], WITH).unwrap().warnings.is_empty());
}
