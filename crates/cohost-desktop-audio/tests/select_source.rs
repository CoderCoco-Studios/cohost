//! Choosing the capture source for the host and the `--device` value, with no audio device involved.
use cohost_desktop_audio::source::{Platform, SourceChoice, select_source};

fn avail() -> Vec<String> {
    vec!["alsa_output.pci.analog-stereo.monitor".into(), "alsa_input.usb.mic".into()]
}

// @spec EARS-SRC-018
#[test]
fn linux_without_a_device_captures_the_monitor_of_the_default_sink() {
    assert_eq!(select_source(Platform::Linux, None, &avail()).unwrap(), SourceChoice::DefaultMonitor);
}

// @spec EARS-SRC-018
#[test]
fn linux_with_a_listed_source_captures_that_source() {
    let name = "alsa_output.pci.analog-stereo.monitor";
    assert_eq!(select_source(Platform::Linux, Some(name), &avail()).unwrap(), SourceChoice::Named(name.into()));
}

// @spec EARS-SRC-018
#[test]
fn linux_with_a_missing_source_is_an_error_naming_it_with_no_fallback() {
    let err = select_source(Platform::Linux, Some("nope.monitor"), &avail()).unwrap_err();
    assert!(err.to_string().contains("nope.monitor"), "{err}");
}

// @spec EARS-SRC-018
#[test]
fn windows_captures_the_default_render_device_and_refuses_a_device_value() {
    assert_eq!(select_source(Platform::Windows, None, &[]).unwrap(), SourceChoice::DefaultRender);
    let err = select_source(Platform::Windows, Some("Speakers"), &[]).unwrap_err();
    assert!(err.to_string().contains("Speakers"), "{err}");
}

// @spec EARS-SRC-014
#[test]
fn any_other_host_is_an_error_naming_the_host() {
    let err = select_source(Platform::Other("macos".into()), None, &[]).unwrap_err();
    assert!(err.to_string().contains("macos"), "{err}");
}
