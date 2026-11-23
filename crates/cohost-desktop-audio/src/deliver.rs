//! The delivery loop (EARS-SRC-020, EARS-SRC-022): one clip in a request at a time, a bounded
//! waiting queue, retries with backoff, and the bounded exit.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::task::JoinHandle;

use crate::post::PostError;
use crate::retry::{Backoff, ClipQueue, Disposition, FailureLog, disposition};

/// Sends one clip. The HTTP implementation is [`crate::post::post_clip`].
pub trait ClipSender: Send + Sync + 'static {
    fn send(&self, clip: &[i16]) -> impl Future<Output = Result<(), PostError>> + Send;
}

/// What the exit left undelivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DeliveryReport {
    pub dropped: usize,
}

struct Shared {
    queue: Mutex<ClipQueue>,
    wake: Notify,
    stop: Notify,
    stopping: AtomicBool,
    sink: Box<dyn Fn(String) + Send + Sync>,
}

impl Shared {
    fn log(&self, line: String) {
        (self.sink)(line);
    }
}

/// Posts queued clips in order from a background task.
pub struct Deliverer<S: ClipSender> {
    sender: Arc<S>,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

impl<S: ClipSender> Deliverer<S> {
    /// Starts the delivery task. `log` receives each line the helper prints.
    pub fn start<F>(sender: Arc<S>, log: F) -> Self
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        let shared = Arc::new(Shared {
            queue: Mutex::new(ClipQueue::new()),
            wake: Notify::new(),
            stop: Notify::new(),
            stopping: AtomicBool::new(false),
            sink: Box::new(log),
        });
        let task = tokio::spawn(run(sender.clone(), shared.clone()));
        Self {
            sender,
            shared,
            task,
        }
    }

    /// Queues a clip for delivery. Returns the oldest waiting clip when the queue was full, which
    /// is dropped and logged.
    // @spec EARS-SRC-020
    pub fn enqueue(&self, clip: Vec<i16>) -> Option<Vec<i16>> {
        let dropped = self.shared.queue.lock().unwrap().push(clip);
        if dropped.is_some() {
            self.shared
                .log("dropped the oldest waiting clip: the queue was full".into());
        }
        self.shared.wake.notify_one();
        dropped
    }

    /// Stops the helper: lets a request in progress finish, makes one attempt for `held` (the clip
    /// cut at the stop), and drops every clip not delivered, logging how many.
    // @spec EARS-SRC-022
    pub async fn shutdown(self, held: Option<Vec<i16>>) -> DeliveryReport {
        self.shared.stopping.store(true, Ordering::SeqCst);
        self.shared.stop.notify_one();
        let _ = self.task.await;
        let mut dropped = 0;
        if let Some(clip) = held
            && let Err(err) = self.sender.send(&clip).await
        {
            dropped += 1;
            self.shared.log(match disposition(&err) {
                Disposition::Drop(line) => line,
                Disposition::Retry => format!("final delivery attempt failed ({err})"),
            });
        }
        dropped += self.shared.queue.lock().unwrap().discard();
        if dropped > 0 {
            self.shared
                .log(format!("dropped {dropped} undelivered clip(s) at exit"));
        }
        DeliveryReport { dropped }
    }
}

async fn run<S: ClipSender>(sender: Arc<S>, shared: Arc<Shared>) {
    let mut backoff = Backoff::new();
    let mut failures = FailureLog::new();
    while !shared.stopping.load(Ordering::SeqCst) {
        let next = shared.queue.lock().unwrap().pop();
        let Some(clip) = next else {
            tokio::select! {
                () = shared.wake.notified() => {}
                () = shared.stop.notified() => {}
            }
            continue;
        };
        match sender.send(&clip).await {
            Ok(()) => {
                backoff.reset();
                failures.clear();
            }
            Err(err) => match disposition(&err) {
                Disposition::Drop(line) => shared.log(line),
                Disposition::Retry => {
                    if let Some(line) = failures.observe(&err) {
                        shared.log(line);
                    }
                    // The clip waits out its retry delay still counted among the waiting clips.
                    let overflow = shared.queue.lock().unwrap().push_front(clip);
                    if overflow.is_some() {
                        shared.log("dropped the oldest waiting clip: the queue was full".into());
                    }
                    let delay: Duration = backoff.next_delay();
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {}
                        () = shared.stop.notified() => {}
                    }
                }
            },
        }
    }
}
