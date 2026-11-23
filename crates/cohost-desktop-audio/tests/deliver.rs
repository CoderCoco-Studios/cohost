//! The delivery loop: waiting clips, the clip in a request, what is logged, and the bounded exit.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cohost_desktop_audio::deliver::{ClipSender, Deliverer};
use cohost_desktop_audio::post::PostError;
use tokio::sync::Semaphore;

struct Fake {
    attempts: Mutex<Vec<Vec<i16>>>,
    delivered: Mutex<Vec<Vec<i16>>>,
    /// When set, a request waits for a permit before it answers.
    gate: Option<Arc<Semaphore>>,
    /// When set, every request is answered with this status.
    fail: Option<u16>,
}

impl Fake {
    fn new(gate: Option<Arc<Semaphore>>, fail: Option<u16>) -> Arc<Self> {
        Arc::new(Self {
            attempts: Mutex::default(),
            delivered: Mutex::default(),
            gate,
            fail,
        })
    }
}

impl ClipSender for Fake {
    async fn send(&self, clip: &[i16]) -> Result<(), PostError> {
        self.attempts.lock().unwrap().push(clip.to_vec());
        if let Some(g) = &self.gate {
            g.acquire().await.unwrap().forget();
        }
        if let Some(status) = self.fail {
            return Err(PostError::Status(status));
        }
        self.delivered.lock().unwrap().push(clip.to_vec());
        Ok(())
    }
}

type Logs = Arc<Mutex<Vec<String>>>;

fn start(sender: &Arc<Fake>) -> (Deliverer<Fake>, Logs) {
    let logs: Logs = Arc::default();
    let sink = logs.clone();
    (
        Deliverer::start(sender.clone(), move |line| sink.lock().unwrap().push(line)),
        logs,
    )
}

/// True when the line has the number `n` as a whole word and the word `dropped` (either order).
fn says_dropped(line: &str, n: usize) -> bool {
    let words: Vec<&str> = line.split(|c: char| !c.is_alphanumeric()).collect();
    words.contains(&n.to_string().as_str()) && words.contains(&"dropped")
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn the_clip_in_a_request_is_not_dropped_and_does_not_count_toward_the_four_waiting() {
    let gate = Arc::new(Semaphore::new(0));
    let sender = Fake::new(Some(gate.clone()), None);
    let (d, _) = start(&sender);
    assert_eq!(d.enqueue(vec![1]), None);
    settle().await;
    for n in 2..=5 {
        assert_eq!(d.enqueue(vec![n]), None, "clip {n}");
    }
    assert_eq!(d.enqueue(vec![6]), Some(vec![2]));
    gate.add_permits(100);
    settle().await;
    d.shutdown(None).await;
    let delivered = sender.delivered.lock().unwrap().clone();
    assert_eq!(delivered, [vec![1], vec![3], vec![4], vec![5], vec![6]]);
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn a_clip_waiting_out_a_retry_delay_counts_among_the_four_and_can_be_dropped_as_the_oldest() {
    let sender = Fake::new(None, Some(503));
    let (d, _) = start(&sender);
    d.enqueue(vec![1]);
    settle().await;
    assert_eq!(sender.attempts.lock().unwrap().len(), 1);
    for n in 2..=4 {
        assert_eq!(d.enqueue(vec![n]), None, "clip {n}");
    }
    assert_eq!(d.enqueue(vec![5]), Some(vec![1]));
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn each_overflow_drop_is_logged() {
    let sender = Fake::new(None, Some(503));
    let (d, logs) = start(&sender);
    for n in 1..=6 {
        d.enqueue(vec![n]);
    }
    let lines = logs
        .lock()
        .unwrap()
        .iter()
        .filter(|l| l.contains("dropped"))
        .count();
    assert_eq!(lines, 2);
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn a_refusal_that_cannot_recover_is_dropped_once_and_logged_with_its_status() {
    let sender = Fake::new(None, Some(401));
    let (d, logs) = start(&sender);
    d.enqueue(vec![1]);
    settle().await;
    advance(60_000).await;
    assert_eq!(sender.attempts.lock().unwrap().len(), 1);
    assert!(logs.lock().unwrap().iter().any(|l| l.contains("401")));
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn a_retried_400_is_logged_once_not_on_every_attempt() {
    let sender = Fake::new(None, Some(400));
    let (d, logs) = start(&sender);
    d.enqueue(vec![1]);
    settle().await;
    for ms in [500, 1_000, 2_000] {
        advance(ms).await;
    }
    assert!(sender.attempts.lock().unwrap().len() >= 4);
    assert_eq!(
        logs.lock()
            .unwrap()
            .iter()
            .filter(|l| l.contains("400"))
            .count(),
        1
    );
}

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn dropped_counts_the_held_clip_whose_attempt_fails_and_every_waiting_clip_and_is_logged() {
    let sender = Fake::new(None, Some(503));
    let (d, logs) = start(&sender);
    d.enqueue(vec![1]);
    d.enqueue(vec![2]);
    settle().await;
    assert_eq!(sender.attempts.lock().unwrap().len(), 1);
    let report = d.shutdown(Some(vec![9])).await;
    assert_eq!(report.dropped, 3);
    assert_eq!(*sender.attempts.lock().unwrap(), [vec![1], vec![9]]);
    assert!(
        logs.lock().unwrap().iter().any(|l| says_dropped(l, 3)),
        "{:?}",
        logs.lock().unwrap()
    );
}

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn exit_lets_a_request_in_progress_finish_before_dropping() {
    let gate = Arc::new(Semaphore::new(0));
    let sender = Fake::new(Some(gate.clone()), None);
    let (d, _) = start(&sender);
    d.enqueue(vec![1]);
    settle().await;
    let stopping = tokio::spawn(d.shutdown(None));
    settle().await;
    assert!(!stopping.is_finished());
    gate.add_permits(1);
    settle().await;
    let report = stopping.await.unwrap();
    assert_eq!(report.dropped, 0);
    assert_eq!(*sender.delivered.lock().unwrap(), [vec![1]]);
}

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn exit_with_nothing_held_or_waiting_makes_no_attempt() {
    let sender = Fake::new(None, None);
    let (d, _) = start(&sender);
    let report = d.shutdown(None).await;
    assert_eq!(report.dropped, 0);
    assert!(sender.attempts.lock().unwrap().is_empty());
}
