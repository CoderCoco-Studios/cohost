//! The pure logic of the Linux back end (EARS-SRC-014, EARS-SRC-018, EARS-SRC-019): where the
//! PulseAudio socket is, which source is the default capture, which server events can move the
//! followed default or remove the captured source, when a silent stream counts as stalled, and how
//! the float frames the server sends are decoded. It holds no connection, so it is tested on any
//! host.
//!
//! The `pulseaudio` client speaks the native protocol over a unix socket only: a `PULSE_SERVER`
//! that names only TCP servers is refused with a message saying so (WSLg's
//! `unix:/mnt/wslg/PulseServer` is a unix socket and works).

use std::path::PathBuf;
use std::time::Duration;

/// The environment the socket is looked up in: `PULSE_SERVER`, `PULSE_RUNTIME_PATH`,
/// `XDG_RUNTIME_DIR`, and this machine's id (`/etc/machine-id`), which a `{machine-id}` prefix on a
/// `PULSE_SERVER` entry is compared with.
#[derive(Debug, Clone, Copy, Default)]
pub struct ServerEnv<'a> {
    pub pulse_server: Option<&'a str>,
    pub pulse_runtime_path: Option<&'a str>,
    pub xdg_runtime_dir: Option<&'a str>,
    pub machine_id: Option<&'a str>,
}

/// The unix sockets to try, in order; the back end connects to the first that answers.
///
/// A non-blank `PULSE_SERVER` is a whitespace-separated list of servers. Each `unix:<path>` or
/// absolute-path entry is a candidate; an entry prefixed by `{machine-id}` is one only when that id
/// is this machine's (or this machine's id is unknown); a list with no candidate is an error naming
/// the value. Without `PULSE_SERVER` the socket is `$PULSE_RUNTIME_PATH/native`, else
/// `$XDG_RUNTIME_DIR/pulse/native`.
// @spec EARS-SRC-014
pub fn server_sockets(env: &ServerEnv<'_>) -> Result<Vec<PathBuf>, String> {
    if let Some(value) = env.pulse_server.map(str::trim).filter(|v| !v.is_empty()) {
        let ours = env.machine_id.map(str::trim).filter(|v| !v.is_empty());
        let candidates: Vec<PathBuf> = value
            .split_whitespace()
            .filter_map(|entry| {
                let (id, rest) = split_machine_id(entry);
                if let (Some(id), Some(ours)) = (id, ours)
                    && id != ours
                {
                    return None;
                }
                let path = rest.strip_prefix("unix:").unwrap_or(rest);
                path.starts_with('/').then(|| PathBuf::from(path))
            })
            .collect();
        if candidates.is_empty() {
            return Err(format!(
                "PULSE_SERVER={value} names no unix socket on this machine; the helper reaches \
                 PulseAudio over a unix socket only (unix:/path), not over TCP"
            ));
        }
        return Ok(candidates);
    }
    if let Some(dir) = env.pulse_runtime_path.filter(|v| !v.is_empty()) {
        return Ok(vec![PathBuf::from(dir).join("native")]);
    }
    if let Some(dir) = env.xdg_runtime_dir.filter(|v| !v.is_empty()) {
        return Ok(vec![PathBuf::from(dir).join("pulse/native")]);
    }
    Err(
        "no PulseAudio socket: set PULSE_SERVER (unix:/path) or XDG_RUNTIME_DIR to where the \
         server's socket is"
            .into(),
    )
}

/// Splits a `{machine-id}` prefix off a `PULSE_SERVER` entry.
fn split_machine_id(entry: &str) -> (Option<&str>, &str) {
    if let Some(inner) = entry.strip_prefix('{')
        && let Some(end) = inner.find('}')
    {
        return (Some(&inner[..end]), &inner[end + 1..]);
    }
    (None, entry)
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
    /// A source appeared, changed or went away.
    Source,
    Other,
}

/// What events ask the back end to check.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Wake {
    /// The default sink may have moved, so the follower asks for it again.
    pub default: bool,
    /// The captured source may have gone, so the back end asks whether it still exists.
    pub source: bool,
}

impl Wake {
    /// Both checks that either wake asks for.
    pub fn merge(self, other: Wake) -> Wake {
        Wake {
            default: self.default || other.default,
            source: self.source || other.source,
        }
    }
}

/// What an event of `facility` asks to check: a server or sink event the default sink, a source
/// event the captured source (a removed `--device` source, or a monitor gone with its sink).
// @spec EARS-SRC-019
pub fn wake_for(facility: Facility) -> Wake {
    match facility {
        Facility::Server | Facility::Sink => Wake {
            default: true,
            source: false,
        },
        Facility::Source => Wake {
            default: false,
            source: true,
        },
        Facility::Other => Wake::default(),
    }
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

/// How long an open, uncorked record stream may deliver nothing before it counts as stalled. A
/// recording stream gets audio (silence included) every fragment, so a longer gap means the server
/// dropped the stream without saying so (the client does not report a killed stream); the stall is
/// a read failure (EARS-SRC-019).
pub const STALL_AFTER: Duration = Duration::from_secs(2);

/// Whether a stream that last delivered audio `since_data` ago has stalled.
// @spec EARS-SRC-019
pub fn stalled(since_data: Duration) -> bool {
    since_data >= STALL_AFTER
}

/// Decodes the little-endian `f32` samples of a record stream, keeping a sample cut across
/// chunks until its last byte arrives.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    carry: Vec<u8>,
}

impl FrameDecoder {
    /// Appends the whole samples of `chunk` (after any bytes carried from earlier chunks) to `out`.
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
