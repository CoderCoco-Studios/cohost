//! The Linux capture back end: the monitor of the default sink, or a named PulseAudio or PipeWire
//! source, read through the simple API. A context subscription reports default-sink changes
//! (EARS-SRC-019).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::subscribe::{Facility, InterestMaskSet};
use libpulse_binding::context::{Context, FlagSet, State};
use libpulse_binding::def::BufferAttr;
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::sample::{Format as PaFormat, Spec};
use libpulse_binding::stream::Direction;
use libpulse_simple_binding::Simple;

use crate::source::{Capture, DeviceEvent, Format, SourceChoice};

const APP: &str = "cohost-desktop-audio";
/// Capture format asked of the server, which converts to it: 48 kHz float stereo. The resampler
/// takes it to 16 kHz mono.
const RATE: u32 = 48_000;
const CHANNELS: u8 = 2;
/// One read is 100 ms of audio, so a stop is seen within 100 ms.
const FRAGMENT_BYTES: usize = (RATE as usize) * (CHANNELS as usize) * 4 / 10;

/// A connected context, with its mainloop. The context is declared first so it drops first.
struct Pulse {
    context: Context,
    mainloop: Mainloop,
}

impl Pulse {
    fn connect() -> Result<Self, String> {
        let mut mainloop = Mainloop::new().ok_or("could not create the PulseAudio mainloop")?;
        let mut context =
            Context::new(&mainloop, APP).ok_or("could not create the PulseAudio context")?;
        context
            .connect(None, FlagSet::NOFLAGS, None)
            .map_err(|e| format!("could not connect to PulseAudio: {e}"))?;
        loop {
            if !matches!(mainloop.iterate(true), IterateResult::Success(_)) {
                return Err("the PulseAudio mainloop failed".into());
            }
            match context.get_state() {
                State::Ready => break,
                State::Failed | State::Terminated => {
                    return Err("could not connect to PulseAudio".into());
                }
                _ => {}
            }
        }
        Ok(Self { context, mainloop })
    }

    /// Runs the mainloop until the callback fills `slot`.
    fn wait<T>(&mut self, slot: &Rc<RefCell<Option<T>>>) -> Result<T, String> {
        loop {
            if let Some(v) = slot.borrow_mut().take() {
                return Ok(v);
            }
            if !matches!(self.mainloop.iterate(true), IterateResult::Success(_)) {
                return Err("the PulseAudio mainloop failed".into());
            }
        }
    }

    fn default_sink(&mut self) -> Result<Option<String>, String> {
        let slot: Rc<RefCell<Option<Option<String>>>> = Rc::new(RefCell::new(None));
        let fill = slot.clone();
        let op = self.context.introspect().get_server_info(move |info| {
            *fill.borrow_mut() = Some(info.default_sink_name.as_ref().map(|n| n.to_string()));
        });
        let result = self.wait(&slot);
        drop(op);
        result
    }

    fn source_names(&mut self) -> Result<Vec<String>, String> {
        let names: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let done: Rc<RefCell<Option<Result<(), String>>>> = Rc::new(RefCell::new(None));
        let (push, finish) = (names.clone(), done.clone());
        let op = self
            .context
            .introspect()
            .get_source_info_list(move |item| match item {
                ListResult::Item(info) => {
                    if let Some(name) = &info.name {
                        push.borrow_mut().push(name.to_string());
                    }
                }
                ListResult::End => *finish.borrow_mut() = Some(Ok(())),
                ListResult::Error => {
                    *finish.borrow_mut() = Some(Err("could not list the PulseAudio sources".into()))
                }
            });
        let result = self.wait(&done);
        drop(op);
        result??;
        let list = names.borrow().clone();
        Ok(list)
    }
}

/// The names of the sources the server offers.
pub fn list_sources() -> Result<Vec<String>, String> {
    Pulse::connect()?.source_names()
}

pub struct PulseCapture {
    pulse: Pulse,
    server_changed: Rc<Cell<bool>>,
    /// The default sink the capture follows, `None` for a named source.
    followed_sink: Option<String>,
    simple: Option<Simple>,
    buf: Vec<u8>,
}

impl PulseCapture {
    pub fn connect() -> Result<Self, String> {
        let mut pulse = Pulse::connect()?;
        let server_changed = Rc::new(Cell::new(false));
        let flag = server_changed.clone();
        pulse
            .context
            .set_subscribe_callback(Some(Box::new(move |facility, _op, _index| {
                if matches!(facility, Some(Facility::Server)) {
                    flag.set(true);
                }
            })));
        let _subscription = pulse.context.subscribe(InterestMaskSet::SERVER, |_| {});
        Ok(Self {
            pulse,
            server_changed,
            followed_sink: None,
            simple: None,
            buf: vec![0; FRAGMENT_BYTES],
        })
    }
}

impl Capture for PulseCapture {
    fn open(&mut self, choice: &SourceChoice) -> Result<Format, String> {
        self.simple = None;
        let (device, followed) = match choice {
            SourceChoice::DefaultMonitor => {
                let sink = self
                    .pulse
                    .default_sink()?
                    .ok_or("PulseAudio has no default sink to capture")?;
                (format!("{sink}.monitor"), Some(sink))
            }
            SourceChoice::Named(name) => (name.clone(), None),
            SourceChoice::DefaultRender => {
                return Err("the Linux helper captures a sink monitor, not a render device".into());
            }
        };
        let spec = Spec {
            format: PaFormat::FLOAT32NE,
            channels: CHANNELS,
            rate: RATE,
        };
        let attr = BufferAttr {
            maxlength: u32::MAX,
            tlength: u32::MAX,
            prebuf: u32::MAX,
            minreq: u32::MAX,
            fragsize: FRAGMENT_BYTES as u32,
        };
        let simple = Simple::new(
            None,
            APP,
            Direction::Record,
            Some(&device),
            "desktop audio",
            &spec,
            None,
            Some(&attr),
        )
        .map_err(|e| format!("could not open the source {device}: {e}"))?;
        self.simple = Some(simple);
        self.followed_sink = followed;
        Ok(Format {
            rate: RATE,
            channels: u16::from(CHANNELS),
        })
    }

    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        let simple = self.simple.as_ref().ok_or("the capture is not open")?;
        simple
            .read(&mut self.buf)
            .map_err(|e| format!("reading the source failed: {e}"))?;
        let (frames, _) = self.buf.as_chunks::<4>();
        out.extend(frames.iter().map(|b| f32::from_le_bytes(*b)));
        Ok(())
    }

    fn event(&mut self) -> Option<DeviceEvent> {
        // Dispatch the server events that arrived since the last call, without blocking.
        let _ = self.pulse.mainloop.iterate(false);
        if matches!(
            self.pulse.context.get_state(),
            State::Failed | State::Terminated
        ) {
            return Some(DeviceEvent::Error(
                "the PulseAudio connection was lost".into(),
            ));
        }
        if !self.server_changed.replace(false) {
            return None;
        }
        let followed = self.followed_sink.clone()?;
        match self.pulse.default_sink() {
            Ok(Some(now)) if now != followed => Some(DeviceEvent::DefaultChanged),
            _ => None,
        }
    }
}
