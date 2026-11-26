//! The Linux back end's pure logic: finding the PulseAudio socket, naming the default sink's
//! monitor, deciding what a server event asks to check, when a silent stream has stalled, and
//! decoding the float frames the server sends. No PulseAudio server is involved.
use std::path::PathBuf;
use std::time::Duration;

use cohost_desktop_audio::pulse_server::{
    Facility, FrameDecoder, STALL_AFTER, ServerEnv, Wake, default_changed, monitor_of,
    server_sockets, stalled, wake_for,
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
        machine_id: None,
    }
}

fn paths(list: &[&str]) -> Vec<PathBuf> {
    list.iter().map(PathBuf::from).collect()
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
        server_sockets(&wslg).unwrap(),
        paths(&["/mnt/wslg/PulseServer"])
    );
}

// @spec EARS-SRC-014
#[test]
fn an_absolute_path_pulse_server_is_the_socket() {
    let e = env(Some("/run/pulse/native"), None, None);
    assert_eq!(server_sockets(&e).unwrap(), paths(&["/run/pulse/native"]));
}

// @spec EARS-SRC-014
#[test]
fn a_machine_id_prefix_is_kept_only_for_this_machine() {
    let value = "{other}unix:/elsewhere {ours}unix:/run/pulse/native unix:/plain";
    let mut e = env(Some(value), None, None);
    e.machine_id = Some("ours\n");
    assert_eq!(
        server_sockets(&e).unwrap(),
        paths(&["/run/pulse/native", "/plain"])
    );
}

// @spec EARS-SRC-014
#[test]
fn a_machine_id_prefix_is_kept_when_this_machine_id_is_unknown() {
    let e = env(Some("{0123abcd}unix:/run/pulse/native"), None, None);
    assert_eq!(server_sockets(&e).unwrap(), paths(&["/run/pulse/native"]));
}

// @spec EARS-SRC-014
#[test]
fn only_entries_for_another_machine_are_an_error() {
    let mut e = env(Some("{other}unix:/run/pulse/native"), None, None);
    e.machine_id = Some("ours");
    let err = server_sockets(&e).unwrap_err();
    assert!(err.contains("{other}unix:/run/pulse/native"), "{err}");
}

// @spec EARS-SRC-014
#[test]
fn every_unix_entry_of_a_server_list_is_a_candidate_in_order() {
    let e = env(
        Some("tcp:192.168.1.5:4713 unix:/tmp/pulse/native unix:/other"),
        None,
        None,
    );
    assert_eq!(
        server_sockets(&e).unwrap(),
        paths(&["/tmp/pulse/native", "/other"])
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
        let err = server_sockets(&env(Some(value), None, Some("/run/user/1000"))).unwrap_err();
        assert!(err.contains(value), "{err}");
        assert!(err.contains("unix socket"), "{err}");
    }
}

// @spec EARS-SRC-014
#[test]
fn an_empty_unix_entry_is_not_a_socket() {
    let err = server_sockets(&env(Some("unix:"), None, None)).unwrap_err();
    assert!(err.contains("unix:"), "{err}");
}

// @spec EARS-SRC-014
#[test]
fn an_unset_or_blank_pulse_server_falls_back_to_the_runtime_directories() {
    for blank in [None, Some(""), Some("   ")] {
        assert_eq!(
            server_sockets(&env(blank, Some("/run/pulse"), Some("/run/user/1000"))).unwrap(),
            paths(&["/run/pulse/native"])
        );
        assert_eq!(
            server_sockets(&env(blank, None, Some("/run/user/1000"))).unwrap(),
            paths(&["/run/user/1000/pulse/native"])
        );
    }
}

// @spec EARS-SRC-014
#[test]
fn no_server_and_no_runtime_directory_is_an_error_naming_what_to_set() {
    let err = server_sockets(&env(None, None, None)).unwrap_err();
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
fn server_and_sink_events_check_the_default_and_source_events_check_the_source() {
    let default = Wake {
        default: true,
        source: false,
    };
    let source = Wake {
        default: false,
        source: true,
    };
    assert_eq!(wake_for(Facility::Server), default);
    assert_eq!(wake_for(Facility::Sink), default);
    assert_eq!(wake_for(Facility::Source), source);
    assert_eq!(wake_for(Facility::Other), Wake::default());
    assert_eq!(
        default.merge(source),
        Wake {
            default: true,
            source: true
        }
    );
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

// @spec EARS-SRC-019
#[test]
fn a_stream_stalls_after_two_seconds_without_audio() {
    assert_eq!(STALL_AFTER, Duration::from_secs(2));
    assert!(!stalled(Duration::from_millis(1999)));
    assert!(stalled(Duration::from_secs(2)));
    assert!(stalled(Duration::from_secs(30)));
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

// @spec EARS-SRC-014
#[test]
fn a_sample_carried_over_three_small_chunks_decodes_once_whole() {
    let bytes = 0.75f32.to_le_bytes();
    let mut decoder = FrameDecoder::default();
    let mut out = Vec::new();
    decoder.push(&bytes[..1], &mut out);
    decoder.push(&bytes[1..2], &mut out);
    assert!(out.is_empty());
    decoder.push(&bytes[2..], &mut out);
    assert_eq!(out, vec![0.75]);
}

// @spec EARS-SRC-014
#[test]
fn reset_drops_a_partial_sample() {
    let mut decoder = FrameDecoder::default();
    let mut out = Vec::new();
    decoder.push(&0.5f32.to_le_bytes()[..2], &mut out);
    decoder.reset();
    decoder.push(&(-0.25f32).to_le_bytes(), &mut out);
    assert_eq!(out, vec![-0.25]);
}
