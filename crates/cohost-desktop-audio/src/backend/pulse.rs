//! The Linux capture back end: the monitor of the default sink, or a named PulseAudio or PipeWire
//! source, recorded through the pure-Rust `pulseaudio` client over the server's unix socket, so
//! the helper needs no `libpulse` to build or run (EARS-SRC-023). A second connection subscribes
//! to server, sink and source events, which report default-sink changes and a captured source that
//! went away (EARS-SRC-019).
//!
//! The client does not report a stream the server killed, so a stream that delivers nothing for
//! [`STALL_AFTER`] also counts as a read failure: the session then asks whether the default moved
//! (a re-open) and otherwise stops on a device failure (EARS-SRC-019).
//!
//! The client's API is async; its own reactor thread drives the socket, so each call here is
//! waited on with a plain `block_on` on the capture thread.

use std::ffi::CString;
use std::io::BufReader;
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use futures::executor::block_on;
use pulseaudio::protocol::stream::{BufferAttr, StreamFlags};
use pulseaudio::protocol::{
    self, ChannelMap, RecordStreamParams, SampleFormat, SampleSpec, SubscriptionEventFacility,
    SubscriptionMask,
};
use pulseaudio::{Client, ClientError, RecordStream};

use crate::pulse_server::{
    Facility, FrameDecoder, STALL_AFTER, ServerEnv, Wake, default_changed, monitor_of,
    server_sockets, stalled, wake_for,
};
use crate::source::{Capture, DeviceEvent, Format, SourceChoice};

const APP: &std::ffi::CStr = c"cohost-desktop-audio";
/// The stream's `media.name`, which mixers such as `pavucontrol` show.
const MEDIA_NAME: &std::ffi::CStr = c"desktop audio";
/// Capture format asked of the server, which converts to it: 48 kHz little-endian float stereo.
/// The resampler takes it to 16 kHz mono.
const RATE: u32 = 48_000;
const CHANNELS: u8 = 2;
/// The server sends 100 ms of audio per fragment.
const FRAGMENT_BYTES: u32 = RATE * (CHANNELS as u32) * 4 / 10;
/// How long one `read` waits for audio, so a stop is seen within 100 ms even when the server
/// sends nothing.
const READ_WAIT: Duration = Duration::from_millis(100);
const LOST: &str = "the PulseAudio connection was lost";

/// The candidate sockets the environment names (`PULSE_SERVER`, `PULSE_RUNTIME_PATH`,
/// `XDG_RUNTIME_DIR`, `/etc/machine-id`).
fn sockets_from_env() -> Result<Vec<PathBuf>, String> {
    let (server, runtime, xdg) = (
        std::env::var("PULSE_SERVER").ok(),
        std::env::var("PULSE_RUNTIME_PATH").ok(),
        std::env::var("XDG_RUNTIME_DIR").ok(),
    );
    let machine_id = std::fs::read_to_string("/etc/machine-id").ok();
    server_sockets(&ServerEnv {
        pulse_server: server.as_deref(),
        pulse_runtime_path: runtime.as_deref(),
        xdg_runtime_dir: xdg.as_deref(),
        machine_id: machine_id.as_deref(),
    })
}

fn open_socket(path: &Path) -> Result<UnixStream, String> {
    UnixStream::connect(path)
        .map_err(|e| format!("could not connect to PulseAudio at {}: {e}", path.display()))
}

fn cookie() -> Option<Vec<u8>> {
    pulseaudio::cookie_path_from_env().and_then(|p| std::fs::read(p).ok())
}

fn describe(e: &ClientError) -> String {
    match e {
        ClientError::Io(io) => format!("I/O error: {io}"),
        ClientError::ServerError(err) => format!("the server answered {err:?}"),
        other => other.to_string(),
    }
}

/// Connects to the first candidate socket that answers, returning the client and that socket.
fn connect_client() -> Result<(Client, PathBuf), String> {
    let mut failures = Vec::new();
    for path in sockets_from_env()? {
        let attempt = open_socket(&path).and_then(|socket| {
            Client::new_unix(APP, socket, cookie()).map_err(|e| {
                format!(
                    "could not connect to PulseAudio at {}: {}",
                    path.display(),
                    describe(&e)
                )
            })
        });
        match attempt {
            Ok(client) => return Ok((client, path)),
            Err(message) => failures.push(message),
        }
    }
    Err(failures.join("; "))
}

/// The names of the sources the server offers.
pub fn list_sources() -> Result<Vec<String>, String> {
    // The client's reactor thread stays blocked on its socket after the client is dropped, until
    // the process exits. That is harmless: this runs once, at start.
    let (client, _) = connect_client()?;
    let sources = block_on(client.list_sources())
        .map_err(|e| format!("could not list the PulseAudio sources: {}", describe(&e)))?;
    Ok(sources
        .into_iter()
        .map(|s| s.name.to_string_lossy().into_owned())
        .collect())
}

/// What the subscription thread reports.
enum Notice {
    Event(Facility),
    Lost,
}

/// A connection that subscribes to server, sink and source events and forwards them from its own
/// thread. The thread ends when the connection closes; dropping this shuts the socket down to end
/// it.
struct Subscription {
    socket: UnixStream,
    notices: Receiver<Notice>,
}

impl Subscription {
    fn start(path: &Path) -> Result<Self, String> {
        let socket = open_socket(path)?;
        let fail = |e: protocol::ProtocolError| format!("could not subscribe to PulseAudio: {e}");
        let mut reader = BufReader::new(socket.try_clone().map_err(|e| e.to_string())?);
        protocol::write_command_message(
            reader.get_mut(),
            0,
            &protocol::Command::Auth(protocol::AuthParams {
                version: protocol::MAX_VERSION,
                supports_shm: false,
                supports_memfd: false,
                cookie: cookie().unwrap_or_default(),
            }),
            protocol::MAX_VERSION,
        )
        .map_err(fail)?;
        let (_, auth) =
            protocol::read_reply_message::<protocol::AuthReply>(&mut reader, protocol::MAX_VERSION)
                .map_err(fail)?;
        let version = protocol::MAX_VERSION.min(auth.version);
        let mut props = protocol::Props::new();
        props.set(protocol::Prop::ApplicationName, APP);
        protocol::write_command_message(
            reader.get_mut(),
            1,
            &protocol::Command::SetClientName(props),
            version,
        )
        .map_err(fail)?;
        protocol::read_reply_message::<protocol::SetClientNameReply>(&mut reader, version)
            .map_err(fail)?;
        let mask = SubscriptionMask::SERVER | SubscriptionMask::SINK | SubscriptionMask::SOURCE;
        protocol::write_command_message(
            reader.get_mut(),
            2,
            &protocol::Command::Subscribe(mask),
            version,
        )
        .map_err(fail)?;
        protocol::read_ack_message(&mut reader).map_err(fail)?;

        let (tx, notices) = mpsc::channel();
        std::thread::spawn(move || {
            loop {
                match protocol::read_command_message(&mut reader, version) {
                    Ok((_, protocol::Command::SubscribeEvent(event))) => {
                        let facility = match event.event_facility {
                            SubscriptionEventFacility::Server => Facility::Server,
                            SubscriptionEventFacility::Sink => Facility::Sink,
                            SubscriptionEventFacility::Source => Facility::Source,
                            _ => Facility::Other,
                        };
                        if tx.send(Notice::Event(facility)).is_err() {
                            return;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => {
                        let _ = tx.send(Notice::Lost);
                        return;
                    }
                }
            }
        });
        Ok(Self { socket, notices })
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// An open record stream and the channel its audio arrives on.
struct Recording {
    /// Held so the stream lives; dropping it deletes the stream on the server.
    _stream: RecordStream,
    data: Receiver<Vec<u8>>,
    /// The source recorded.
    device: String,
    /// When the stream last delivered audio (or was opened).
    last_data: Instant,
}

pub struct PulseCapture {
    client: Client,
    subscription: Subscription,
    /// The default sink the capture follows, `None` for a named source.
    followed_sink: Option<String>,
    recording: Option<Recording>,
    decoder: FrameDecoder,
    /// The last read failed on a stall; the next `event` asks whether the default moved.
    stalled: bool,
}

impl PulseCapture {
    pub fn connect() -> Result<Self, String> {
        let (client, path) = connect_client()?;
        let subscription = Subscription::start(&path)?;
        Ok(Self {
            client,
            subscription,
            followed_sink: None,
            recording: None,
            decoder: FrameDecoder::default(),
            stalled: false,
        })
    }

    fn default_sink(&self) -> Result<Option<String>, String> {
        let info = block_on(self.client.server_info()).map_err(|e| {
            format!(
                "could not ask PulseAudio for its default sink: {}",
                describe(&e)
            )
        })?;
        Ok(info
            .default_sink_name
            .map(|n| n.to_string_lossy().into_owned()))
    }

    /// An error naming the captured source when the server no longer has it.
    fn source_gone(&self) -> Option<String> {
        let device = &self.recording.as_ref()?.device;
        let name = CString::new(device.as_str()).ok()?;
        block_on(self.client.source_info_by_name(name))
            .err()
            .map(|e| format!("the source {device} went away: {}", describe(&e)))
    }
}

impl Capture for PulseCapture {
    fn open(&mut self, choice: &SourceChoice) -> Result<Format, String> {
        self.recording = None;
        self.decoder.reset();
        self.stalled = false;
        let (device, followed) = match choice {
            SourceChoice::DefaultMonitor => {
                let sink = self
                    .default_sink()?
                    .ok_or("PulseAudio has no default sink to capture")?;
                (monitor_of(&sink), Some(sink))
            }
            SourceChoice::Named(name) => (name.clone(), None),
            SourceChoice::DefaultRender => {
                return Err("the Linux helper captures a sink monitor, not a render device".into());
            }
        };
        let source_name = CString::new(device.clone())
            .map_err(|_| format!("the source name {device} holds a NUL byte"))?;
        let mut props = protocol::Props::new();
        props.set(protocol::Prop::MediaName, MEDIA_NAME);
        let params = RecordStreamParams {
            sample_spec: SampleSpec {
                format: SampleFormat::Float32Le,
                channels: CHANNELS,
                sample_rate: RATE,
            },
            channel_map: ChannelMap::stereo(),
            source_name: Some(source_name),
            buffer_attr: BufferAttr {
                fragment_size: FRAGMENT_BYTES,
                ..BufferAttr::default()
            },
            // The server never moves the stream to another source: a named source has no fallback
            // (EARS-SRC-018), and a followed default is re-opened by the helper itself.
            flags: StreamFlags {
                no_move: true,
                adjust_latency: true,
                ..StreamFlags::default()
            },
            props,
            ..RecordStreamParams::default()
        };
        let (tx, data) = mpsc::channel();
        let sink = move |chunk: &[u8]| {
            let _ = tx.send(chunk.to_vec());
        };
        let stream = block_on(self.client.create_record_stream(params, sink))
            .map_err(|e| format!("could not open the source {device}: {}", describe(&e)))?;
        let spec = *stream.sample_spec();
        if spec.format != SampleFormat::Float32Le {
            return Err(format!(
                "the source {device} records {:?}, not 32-bit float",
                spec.format
            ));
        }
        self.recording = Some(Recording {
            _stream: stream,
            data,
            device,
            last_data: Instant::now(),
        });
        self.followed_sink = followed;
        Ok(Format {
            rate: spec.sample_rate,
            channels: u16::from(spec.channels),
        })
    }

    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let recording = self.recording.as_mut().ok_or("the capture is not open")?;
        match recording.data.recv_timeout(READ_WAIT) {
            Ok(chunk) => self.decoder.push(&chunk, out),
            Err(RecvTimeoutError::Timeout) => {
                if stalled(recording.last_data.elapsed()) {
                    self.stalled = true;
                    return Err(format!(
                        "the source {} sent no audio for {} s",
                        recording.device,
                        STALL_AFTER.as_secs()
                    ));
                }
                return Ok(());
            }
            Err(RecvTimeoutError::Disconnected) => return Err(LOST.into()),
        }
        recording.last_data = Instant::now();
        // Take whatever else has arrived, so the reader keeps up with the server.
        loop {
            match recording.data.try_recv() {
                Ok(chunk) => self.decoder.push(&chunk, out),
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => return Err(LOST.into()),
            }
        }
    }

    fn event(&mut self) -> Option<DeviceEvent> {
        // Drain the events that arrived since the last call, without blocking.
        let mut wake = Wake::default();
        loop {
            match self.subscription.notices.try_recv() {
                Ok(Notice::Event(facility)) => wake = wake.merge(wake_for(facility)),
                Ok(Notice::Lost) | Err(TryRecvError::Disconnected) => {
                    return Some(DeviceEvent::Error(LOST.into()));
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        // A followed monitor that went away or stalled most likely went with its sink, so the
        // default is asked first: a new default is a re-open, not a failure.
        // A stall that is not a default change stays the read failure the session stops on.
        let stall = std::mem::take(&mut self.stalled);
        if let Some(followed) = self.followed_sink.as_deref()
            && (wake.default || wake.source || stall)
        {
            match self.default_sink() {
                Ok(now) if default_changed(Some(followed), now.as_deref()) => {
                    return Some(DeviceEvent::DefaultChanged);
                }
                Ok(_) => {}
                Err(message) => return Some(DeviceEvent::Error(message)),
            }
        }
        if wake.source {
            return self.source_gone().map(DeviceEvent::Error);
        }
        None
    }
}
