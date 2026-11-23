//! The platform capture back ends. Each one implements [`Capture`]; a host with none is an
//! unsupported host (EARS-SRC-014).

use crate::source::{Capture, Platform};

#[cfg(target_os = "linux")]
mod pulse;
#[cfg(windows)]
mod wasapi_capture;

/// The host this build runs on.
pub fn current_platform() -> Platform {
    if cfg!(target_os = "linux") {
        Platform::Linux
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Other(std::env::consts::OS.to_string())
    }
}

/// The source names the host offers for `--device`. Only Linux names sources; other hosts offer none.
pub fn list_sources() -> Result<Vec<String>, String> {
    #[cfg(target_os = "linux")]
    {
        pulse::list_sources()
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Vec::new())
    }
}

/// Creates the platform capture, not yet opened. It is used on the thread that creates it: the
/// back ends hold OS handles that are not moved between threads.
pub fn new_capture() -> Result<Box<dyn Capture>, String> {
    #[cfg(target_os = "linux")]
    {
        pulse::PulseCapture::connect().map(|c| Box::new(c) as Box<dyn Capture>)
    }
    #[cfg(windows)]
    {
        Ok(Box::new(wasapi_capture::WasapiCapture::new()))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Err(format!("unsupported host {}", std::env::consts::OS))
    }
}
