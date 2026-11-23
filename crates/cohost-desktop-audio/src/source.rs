//! Capture source choice (EARS-SRC-014, EARS-SRC-018, EARS-SRC-019) and the platform back-end trait.

use std::fmt;

/// The host the helper runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Windows,
    Other(String),
}

/// What the helper captures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceChoice {
    /// The monitor of the default sink (Linux, no `--device`).
    DefaultMonitor,
    /// The default render device (Windows).
    DefaultRender,
    /// A named PulseAudio or PipeWire source (Linux, `--device`).
    Named(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SourceError {
    UnsupportedHost(String),
    MissingSource(String),
    DeviceOnWindows(String),
}

impl fmt::Display for SourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedHost(host) => write!(
                f,
                "unsupported host {host}: the helper captures Windows and Linux only"
            ),
            Self::MissingSource(name) => write!(
                f,
                "no capture source named {name}; pass the name of a listed PulseAudio or PipeWire source"
            ),
            Self::DeviceOnWindows(value) => write!(
                f,
                "--device {value} is not accepted on Windows, which captures the default render device"
            ),
        }
    }
}

impl std::error::Error for SourceError {}

/// Chooses the source for `platform`. `available` lists the Linux source names the host offers.
/// A named source that is not listed is an error: there is no fallback to the default.
// @spec EARS-SRC-018, EARS-SRC-014
pub fn select_source(
    platform: Platform,
    device: Option<&str>,
    available: &[String],
) -> Result<SourceChoice, SourceError> {
    match (platform, device) {
        (Platform::Linux, None) => Ok(SourceChoice::DefaultMonitor),
        (Platform::Linux, Some(name)) => {
            if available.iter().any(|a| a == name) {
                Ok(SourceChoice::Named(name.to_string()))
            } else {
                Err(SourceError::MissingSource(name.to_string()))
            }
        }
        (Platform::Windows, None) => Ok(SourceChoice::DefaultRender),
        (Platform::Windows, Some(value)) => Err(SourceError::DeviceOnWindows(value.to_string())),
        (Platform::Other(host), _) => Err(SourceError::UnsupportedHost(host)),
    }
}

/// A device event reported by a back end while capturing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceEvent {
    /// The system's default device changed.
    DefaultChanged,
    /// Any other device failure.
    Error(String),
}

/// What the helper does about a device event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceAction {
    /// Close the held clip, queue it, and re-open the new default.
    Reopen,
    Continue,
    /// Stop as in EARS-SRC-022 and exit non-zero, with this message.
    Fail(String),
}

// @spec EARS-SRC-019
pub fn on_device_event(choice: &SourceChoice, event: DeviceEvent) -> DeviceAction {
    match event {
        DeviceEvent::DefaultChanged => match choice {
            SourceChoice::Named(_) => DeviceAction::Continue,
            SourceChoice::DefaultMonitor | SourceChoice::DefaultRender => DeviceAction::Reopen,
        },
        DeviceEvent::Error(msg) => DeviceAction::Fail(format!("capture device failed: {msg}")),
    }
}

/// The sample format a back end delivers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub rate: u32,
    pub channels: u16,
}

/// A platform capture back end (PulseAudio/PipeWire on Linux, WASAPI loopback on Windows). The
/// implementations are not part of the pure core; the core feeds their output to
/// [`crate::pcm::Resampler`].
///
/// Both methods block: a back end waits on the audio device. Run the capture loop on a blocking
/// thread (`tokio::task::spawn_blocking` or a dedicated thread), never on the async runtime that
/// posts clips.
pub trait Capture {
    /// Opens `choice` and reports the format of the frames `read` returns.
    fn open(&mut self, choice: &SourceChoice) -> Result<Format, String>;
    /// Appends the next interleaved `f32` frames to `out`.
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String>;
}
