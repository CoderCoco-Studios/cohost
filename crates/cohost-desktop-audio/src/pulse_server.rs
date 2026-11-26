//! The pure logic of the Linux back end (EARS-SRC-014, EARS-SRC-018, EARS-SRC-019): where the
//! PulseAudio socket is, which source is the default capture, which server events can move the
//! followed default, and how the float frames the server sends are decoded. It holds no
//! connection, so it is tested on any host.
//!
//! The `pulseaudio` client speaks the native protocol over a unix socket only: a `PULSE_SERVER`
//! that names only TCP servers is refused with a message saying so (WSLg's
//! `unix:/mnt/wslg/PulseServer` is a unix socket and works).

use std::path::PathBuf;

/// The environment the socket is looked up in: `PULSE_SERVER`, `PULSE_RUNTIME_PATH` and
/// `XDG_RUNTIME_DIR`.
#[derive(Debug, Clone, Copy, Default)]
pub struct ServerEnv<'a> {
    pub pulse_server: Option<&'a str>,
    pub pulse_runtime_path: Option<&'a str>,
    pub xdg_runtime_dir: Option<&'a str>,
}

/// The unix socket to reach the server on. A non-blank `PULSE_SERVER` is a whitespace-separated
/// list of servers, each optionally prefixed by `{machine-id}`; its first `unix:<path>` or absolute
/// path entry is the socket, and a list with no such entry is an error. Otherwise the socket is
/// `$PULSE_RUNTIME_PATH/native`, then `$XDG_RUNTIME_DIR/pulse/native`.
// @spec EARS-SRC-014
pub fn server_socket(env: &ServerEnv<'_>) -> Result<PathBuf, String> {
    if let Some(value) = env.pulse_server.map(str::trim).filter(|v| !v.is_empty()) {
        for entry in value.split_whitespace() {
            let entry = strip_machine_id(entry);
            let path = entry.strip_prefix("unix:").unwrap_or(entry);
            if path.starts_with('/') {
                return Ok(PathBuf::from(path));
            }
        }
        return Err(format!(
            "PULSE_SERVER={value} names no unix socket; the helper reaches PulseAudio over a unix \
             socket only (unix:/path), not over TCP"
        ));
    }
    if let Some(dir) = env.pulse_runtime_path.filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir).join("native"));
    }
    if let Some(dir) = env.xdg_runtime_dir.filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(dir).join("pulse/native"));
    }
    Err(
        "no PulseAudio socket: set PULSE_SERVER (unix:/path) or XDG_RUNTIME_DIR to where the \
         server's socket is"
            .into(),
    )
}

fn strip_machine_id(entry: &str) -> &str {
    if entry.starts_with('{')
        && let Some(end) = entry.find('}')
    {
        return &entry[end + 1..];
    }
    entry
}

/// The monitor source of `sink`, which carries what the sink plays.
// @spec EARS-SRC-018
pub fn monitor_of(sink: &str) -> String {
    format!("{sink}.monitor")
}

/// The facility of a server subscription event, as far as the back end cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Facility {
    /// The server itself: a change of the default sink or source.
    Server,
    /// A sink appeared, changed or went away.
    Sink,
    Other,
}

/// Whether an event of `facility` can have moved the default sink, so the follower asks again.
// @spec EARS-SRC-019
pub fn wakes_follower(facility: Facility) -> bool {
    matches!(facility, Facility::Server | Facility::Sink)
}

/// Whether the default sink is no longer the one the capture follows. `followed` is `None` for a
/// named source, which follows no default; a server with no default sink left is a change.
// @spec EARS-SRC-019
pub fn default_changed(followed: Option<&str>, now: Option<&str>) -> bool {
    match followed {
        Some(followed) => now != Some(followed),
        None => false,
    }
}

/// Decodes the little-endian `f32` samples of a record stream, keeping a sample cut across two
/// chunks until its last byte arrives.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    carry: Vec<u8>,
}

impl FrameDecoder {
    /// Appends the whole samples of `chunk` (after any bytes carried from the last chunk) to `out`.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<f32>) {
        let mut rest = chunk;
        if !self.carry.is_empty() {
            let need = 4 - self.carry.len();
            let take = need.min(rest.len());
            self.carry.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.carry.len() < 4 {
                return;
            }
            let bytes = [self.carry[0], self.carry[1], self.carry[2], self.carry[3]];
            out.push(f32::from_le_bytes(bytes));
            self.carry.clear();
        }
        let (samples, tail) = rest.as_chunks::<4>();
        out.extend(samples.iter().map(|b| f32::from_le_bytes(*b)));
        self.carry.extend_from_slice(tail);
    }

    /// Drops a partial sample, for a stream that is re-opened.
    pub fn reset(&mut self) {
        self.carry.clear();
    }
}
