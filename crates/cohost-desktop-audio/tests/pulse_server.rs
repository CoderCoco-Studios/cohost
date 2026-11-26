//! The Linux back end's pure logic: finding the PulseAudio socket, naming the default sink's
//! monitor, deciding when a server event means the followed default changed, and decoding the
//! float frames the server sends. No PulseAudio server is involved.
use std::path::PathBuf;

use cohost_desktop_audio::pulse_server::{
    Facility, FrameDecoder, ServerEnv, default_changed, monitor_of, server_socket, wakes_follower,
};

fn env<'a>(
    pulse_server: Option<&'a str>,
    runtime: Option<&'a str>,
    xdg: Option<&'a str>,
) -> ServerEnv<'a> {
    ServerEnv {
        pulse_server,
        pulse_runtime_path: runtime,
        xdg_runtime_dir: xdg,
    }
}

// @spec EARS-SRC-014
#[test]
fn a_unix_pulse_server_is_the_socket() {
    let wslg = env(
        Some("unix:/mnt/wslg/PulseServer"),
        None,
        Some("/run/user/1000"),
    );
    assert_eq!(
        server_socket(&wslg).unwrap(),
        PathBuf::from("/mnt/wslg/PulseServer")
    );
}

// @spec EARS-SRC-014
#[test]
fn an_absolute_path_pulse_server_is_the_socket() {
    let e = env(Some("/run/pulse/native"), None, None);
    assert_eq!(
        server_socket(&e).unwrap(),
        PathBuf::from("/run/pulse/native")
    );
}

// @spec EARS-SRC-014
#[test]
fn a_machine_id_prefix_on_a_unix_entry_is_ignored() {
    let e = env(Some("{0123abcd}unix:/run/pulse/native"), None, None);
    assert_eq!(
        server_socket(&e).unwrap(),
        PathBuf::from("/run/pulse/native")
    );
}

// @spec EARS-SRC-014
#[test]
fn the_first_unix_entry_of_a_server_list_is_used() {
    let e = env(
        Some("tcp:192.168.1.5:4713 unix:/tmp/pulse/native unix:/other"),
        None,
        None,
    );
    assert_eq!(
        server_socket(&e).unwrap(),
        PathBuf::from("/tmp/pulse/native")
    );
}

// @spec EARS-SRC-014
#[test]
fn a_tcp_pulse_server_is_an_error_naming_the_value_and_the_unix_only_rule() {
    for value in [
        "tcp:192.168.1.5:4713",
        "tcp6:[::1]:4713",
        "localhost",
        "192.168.1.5",
    ] {
        let err = server_socket(&env(Some(value), None, Some("/run/user/1000"))).unwrap_err();
        assert!(err.contains(value), "{err}");
        assert!(err.contains("unix socket"), "{err}");
    }
}

// @spec EARS-SRC-014
#[test]
fn an_empty_unix_entry_is_not_a_socket() {
    let err = server_socket(&env(Some("unix:"), None, None)).unwrap_err();
    assert!(err.contains("unix:"), "{err}");
}

// @spec EARS-SRC-014
#[test]
fn an_unset_or_blank_pulse_server_falls_back_to_the_runtime_directories() {
    for blank in [None, Some(""), Some("   ")] {
        assert_eq!(
            server_socket(&env(blank, Some("/run/pulse"), Some("/run/user/1000"))).unwrap(),
            PathBuf::from("/run/pulse/native")
        );
        assert_eq!(
            server_socket(&env(blank, None, Some("/run/user/1000"))).unwrap(),
            PathBuf::from("/run/user/1000/pulse/native")
        );
    }
}

// @spec EARS-SRC-014
#[test]
fn no_server_and_no_runtime_directory_is_an_error_naming_what_to_set() {
    let err = server_socket(&env(None, None, None)).unwrap_err();
    assert!(err.contains("PULSE_SERVER"), "{err}");
    assert!(err.contains("XDG_RUNTIME_DIR"), "{err}");
}

// @spec EARS-SRC-018
#[test]
fn the_default_capture_is_the_monitor_of_the_default_sink() {
    assert_eq!(
        monitor_of("alsa_output.pci.analog-stereo"),
        "alsa_output.pci.analog-stereo.monitor"
    );
}

// @spec EARS-SRC-019
#[test]
fn server_and_sink_events_wake_the_default_follower_and_others_do_not() {
    assert!(wakes_follower(Facility::Server));
    assert!(wakes_follower(Facility::Sink));
    assert!(!wakes_follower(Facility::Other));
}

// @spec EARS-SRC-019
#[test]
fn a_different_or_missing_default_sink_is_a_change_of_the_followed_default() {
    assert!(default_changed(Some("a"), Some("b")));
    assert!(default_changed(Some("a"), None));
    assert!(!default_changed(Some("a"), Some("a")));
}

// @spec EARS-SRC-019
#[test]
fn a_named_source_follows_no_default_so_nothing_is_a_change() {
    assert!(!default_changed(None, Some("b")));
    assert!(!default_changed(None, None));
}

// @spec EARS-SRC-014
#[test]
fn little_endian_float_frames_decode_across_chunk_boundaries() {
    let samples = [0.5f32, -0.25, 1.0, -1.0];
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut decoder = FrameDecoder::default();
    let mut out = Vec::new();
    // Chunks cut mid-sample: 3 bytes, then 6, then the rest.
    decoder.push(&bytes[..3], &mut out);
    assert!(out.is_empty());
    decoder.push(&bytes[3..9], &mut out);
    assert_eq!(out, vec![0.5, -0.25]);
    decoder.push(&bytes[9..], &mut out);
    assert_eq!(out, samples.to_vec());
}
