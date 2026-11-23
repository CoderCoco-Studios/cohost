//! The capture loop (EARS-SRC-015, EARS-SRC-017, EARS-SRC-019, EARS-SRC-022): capture, resample,
//! cut into clips, queue for delivery, and stop with a reason. It blocks, so it runs on a
//! blocking thread.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::clip::{ClipConfig, ClipCutter};
use crate::deliver::{ClipSender, Deliverer};
use crate::lifecycle::StopReason;
use crate::pcm::Resampler;
use crate::source::{Capture, DeviceAction, Format, SourceChoice, on_device_event};

/// Why the loop ended. `held` is the clip cut at the end, for [`crate::lifecycle::stop`].
#[derive(Debug)]
pub struct Outcome {
    pub reason: StopReason,
    pub held: Option<Vec<i16>>,
    /// The failure to print, for a device failure.
    pub message: Option<String>,
}

/// Flushes the resampler and cutter, queueing the clips that close, and returns the open clip.
fn take_held<S: ClipSender>(
    resampler: &mut Resampler,
    cutter: &mut ClipCutter,
    deliverer: &Deliverer<S>,
) -> Option<Vec<i16>> {
    let tail = resampler.finish();
    for clip in cutter.push(&tail) {
        deliverer.enqueue(clip);
    }
    cutter.finish()
}

/// Runs the capture until a stop, displacement or a device failure. `format` is the format of the
/// already-opened capture.
#[allow(clippy::too_many_arguments)]
// @spec EARS-SRC-015, EARS-SRC-017, EARS-SRC-019, EARS-SRC-022
pub fn run_capture<S: ClipSender>(
    capture: &mut dyn Capture,
    choice: &SourceChoice,
    format: Format,
    clip: ClipConfig,
    deliverer: &Deliverer<S>,
    stop: &AtomicBool,
    displaced: &dyn Fn() -> bool,
    log: &dyn Fn(String),
) -> Outcome {
    let mut resampler = Resampler::new(format.rate, format.channels);
    let mut cutter = ClipCutter::new(clip);
    let mut samples = Vec::new();
    loop {
        if stop.load(Ordering::SeqCst) {
            let held = take_held(&mut resampler, &mut cutter, deliverer);
            return Outcome {
                reason: StopReason::Signal,
                held,
                message: None,
            };
        }
        if displaced() {
            let held = take_held(&mut resampler, &mut cutter, deliverer);
            return Outcome {
                reason: StopReason::Displaced,
                held,
                message: None,
            };
        }
        if let Some(event) = capture.event() {
            match on_device_event(choice, event) {
                DeviceAction::Continue => {}
                DeviceAction::Reopen => {
                    let held = take_held(&mut resampler, &mut cutter, deliverer);
                    if let Some(h) = held {
                        deliverer.enqueue(h);
                    }
                    match capture.open(choice) {
                        Ok(f) => {
                            log("capture re-opened on the new default device".into());
                            resampler = Resampler::new(f.rate, f.channels);
                        }
                        Err(e) => {
                            return Outcome {
                                reason: StopReason::DeviceFailure,
                                held: None,
                                message: Some(format!("could not re-open the capture device: {e}")),
                            };
                        }
                    }
                }
                DeviceAction::Fail(message) => {
                    let held = take_held(&mut resampler, &mut cutter, deliverer);
                    return Outcome {
                        reason: StopReason::DeviceFailure,
                        held,
                        message: Some(message),
                    };
                }
            }
        }
        samples.clear();
        if let Err(e) = capture.read(&mut samples) {
            let held = take_held(&mut resampler, &mut cutter, deliverer);
            return Outcome {
                reason: StopReason::DeviceFailure,
                held,
                message: Some(format!("capture failed: {e}")),
            };
        }
        let pcm = resampler.push(&samples);
        for c in cutter.push(&pcm) {
            deliverer.enqueue(c);
        }
    }
}
