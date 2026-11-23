//! The capture loop against a scripted capture: clips, device events, reopen and the stop reasons.
//! No audio device is involved.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cohost_desktop_audio::clip::ClipConfig;
use cohost_desktop_audio::deliver::{ClipSender, Deliverer};
use cohost_desktop_audio::lifecycle::StopReason;
use cohost_desktop_audio::post::PostError;
use cohost_desktop_audio::session::{Outcome, run_capture};
use cohost_desktop_audio::source::{Capture, DeviceEvent, Format, SourceChoice};

const RATE: usize = 16_000;

enum Step {
    /// Mono samples, then an optional device event raised after the read.
    Samples(Vec<f32>, Option<DeviceEvent>),
    /// Sets the stop flag and returns no samples.
    Stop(Arc<AtomicBool>),
    Fail(String),
    /// A read error after which the capture reports a device event.
    FailWith(String, DeviceEvent),
}

#[derive(Default)]
struct Scripted {
    steps: VecDeque<Step>,
    pending: Option<DeviceEvent>,
    opens: usize,
    open_error: Option<String>,
}

impl Capture for Scripted {
    fn open(&mut self, _choice: &SourceChoice) -> Result<Format, String> {
        self.opens += 1;
        match &self.open_error {
            Some(e) => Err(e.clone()),
            None => Ok(Format {
                rate: RATE as u32,
                channels: 1,
            }),
        }
    }
    fn read(&mut self, out: &mut Vec<f32>) -> Result<(), String> {
        match self.steps.pop_front() {
            None => Err("script ended".into()),
            Some(Step::Samples(pcm, then)) => {
                out.extend(pcm);
                self.pending = then;
                Ok(())
            }
            Some(Step::Stop(flag)) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            Some(Step::Fail(m)) => Err(m),
            Some(Step::FailWith(m, event)) => {
                self.pending = Some(event);
                Err(m)
            }
        }
    }
    fn event(&mut self) -> Option<DeviceEvent> {
        self.pending.take()
    }
}

fn tone(ms: usize) -> Vec<f32> {
    (0..RATE * ms / 1000)
        .map(|i| (i as f32 * 0.3).sin() * 0.5)
        .collect()
}

fn silence(ms: usize) -> Vec<f32> {
    vec![0.0; RATE * ms / 1000]
}

#[derive(Default)]
struct Recorder(Mutex<Vec<usize>>);

impl ClipSender for Recorder {
    async fn send(&self, clip: &[i16]) -> Result<(), PostError> {
        self.0.lock().unwrap().push(clip.len());
        Ok(())
    }
}

fn run(
    capture: &mut Scripted,
    choice: &SourceChoice,
    displaced: bool,
    rec: &Arc<Recorder>,
) -> Outcome {
    let deliverer = Deliverer::start(rec.clone(), |_| {});
    let stop = AtomicBool::new(false);
    let logs = Mutex::new(Vec::new());
    let format = Format {
        rate: RATE as u32,
        channels: 1,
    };
    run_capture(
        capture,
        choice,
        format,
        ClipConfig::default(),
        &deliverer,
        &stop,
        &move || displaced,
        &|line| logs.lock().unwrap().push(line),
    )
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(200)).await;
}

// @spec EARS-SRC-015, EARS-SRC-017
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_failure_after_a_closed_clip_is_a_device_failure_and_the_clip_is_posted() {
    let mut c = Scripted {
        steps: VecDeque::from([
            Step::Samples(tone(1000), None),
            Step::Samples(silence(1000), None),
            Step::Fail("device gone".into()),
        ]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, false, &rec);
    settle().await;
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert!(out.message.unwrap().contains("device gone"));
    assert_eq!(rec.0.lock().unwrap().len(), 1);
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_default_change_queues_the_held_clip_and_reopens_the_new_default() {
    let mut c = Scripted {
        steps: VecDeque::from([
            Step::Samples(tone(500), Some(DeviceEvent::DefaultChanged)),
            Step::Samples(tone(500), None),
            Step::Samples(silence(1000), None),
            Step::Fail("gone".into()),
        ]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, false, &rec);
    settle().await;
    assert_eq!(c.opens, 1);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert_eq!(rec.0.lock().unwrap().len(), 2);
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_reopen_is_a_device_failure_naming_the_cause() {
    let mut c = Scripted {
        steps: VecDeque::from([Step::Samples(tone(300), Some(DeviceEvent::DefaultChanged))]),
        open_error: Some("no default sink".into()),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, false, &rec);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert!(out.message.unwrap().contains("no default sink"));
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_named_source_ignores_a_change_of_the_default() {
    let mut c = Scripted {
        steps: VecDeque::from([
            Step::Samples(tone(300), Some(DeviceEvent::DefaultChanged)),
            Step::Samples(silence(1000), None),
            Step::Fail("gone".into()),
        ]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let named = SourceChoice::Named("x.monitor".into());
    let out = run(&mut c, &named, false, &rec);
    settle().await;
    assert_eq!(c.opens, 0);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert_eq!(rec.0.lock().unwrap().len(), 1);
}

// @spec EARS-SRC-022
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_request_returns_the_clip_held_as_the_held_clip() {
    let flag = Arc::new(AtomicBool::new(false));
    let mut c = Scripted {
        steps: VecDeque::from([Step::Samples(tone(300), None), Step::Stop(flag.clone())]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let deliverer = Deliverer::start(rec.clone(), |_| {});
    let out = run_capture(
        &mut c,
        &SourceChoice::DefaultMonitor,
        Format {
            rate: RATE as u32,
            channels: 1,
        },
        ClipConfig::default(),
        &deliverer,
        &flag,
        &|| false,
        &|_| {},
    );
    assert_eq!(out.reason, StopReason::Signal);
    assert_eq!(out.held.map(|h| h.len()), Some(RATE * 300 / 1000));
}

// @spec CONN-DESK-004
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn displacement_stops_the_capture_with_the_displaced_reason() {
    let mut c = Scripted::default();
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, true, &rec);
    assert_eq!(out.reason, StopReason::Displaced);
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_error_event_fails_the_run_with_its_message() {
    let mut c = Scripted {
        steps: VecDeque::from([Step::Samples(
            tone(100),
            Some(DeviceEvent::Error("unplugged".into())),
        )]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultRender, false, &rec);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert!(out.message.unwrap().contains("unplugged"));
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_error_with_a_changed_default_reopens_instead_of_failing() {
    let mut c = Scripted {
        steps: VecDeque::from([
            Step::Samples(tone(500), None),
            Step::FailWith("device gone".into(), DeviceEvent::DefaultChanged),
            Step::Samples(tone(500), None),
            Step::Samples(silence(1000), None),
            Step::Fail("end of test".into()),
        ]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, false, &rec);
    settle().await;
    assert_eq!(c.opens, 1);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert!(out.message.unwrap().contains("end of test"));
    assert_eq!(rec.0.lock().unwrap().len(), 2);
}

// @spec EARS-SRC-019
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_error_with_an_unchanged_default_is_a_device_failure() {
    let mut c = Scripted {
        steps: VecDeque::from([Step::Fail("device gone".into())]),
        ..Scripted::default()
    };
    let rec = Arc::new(Recorder::default());
    let out = run(&mut c, &SourceChoice::DefaultMonitor, false, &rec);
    assert_eq!(c.opens, 0);
    assert_eq!(out.reason, StopReason::DeviceFailure);
    assert!(out.message.unwrap().contains("device gone"));
}
