//! The delivery loop: waiting clips, the clip in a request, and the bounded exit.
use std::sync::{Arc, Mutex};

use cohost_desktop_audio::deliver::{ClipSender, Deliverer};
use cohost_desktop_audio::post::PostError;
use tokio::sync::Semaphore;

struct Fake {
    attempts: Mutex<Vec<Vec<i16>>>,
    delivered: Mutex<Vec<Vec<i16>>>,
    /// When set, a request waits for a permit before it answers.
    gate: Option<Arc<Semaphore>>,
    fail: bool,
}

impl Fake {
    fn new(gate: Option<Arc<Semaphore>>, fail: bool) -> Arc<Self> {
        Arc::new(Self { attempts: Mutex::default(), delivered: Mutex::default(), gate, fail })
    }
}

impl ClipSender for Fake {
    async fn send(&self, clip: &[i16]) -> Result<(), PostError> {
        self.attempts.lock().unwrap().push(clip.to_vec());
        if let Some(g) = &self.gate {
            g.acquire().await.unwrap().forget();
        }
        if self.fail {
            return Err(PostError::Status(503));
        }
        self.delivered.lock().unwrap().push(clip.to_vec());
        Ok(())
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

// @spec EARS-SRC-020
#[tokio::test(start_paused = true)]
async fn the_clip_in_a_request_is_not_dropped_and_does_not_count_toward_the_four_waiting() {
    let gate = Arc::new(Semaphore::new(0));
    let sender = Fake::new(Some(gate.clone()), false);
    let d = Deliverer::start(sender.clone());
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

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn exit_makes_one_attempt_for_the_held_clip_and_drops_the_waiting_ones() {
    let sender = Fake::new(None, true);
    let d = Deliverer::start(sender.clone());
    d.enqueue(vec![1]);
    d.enqueue(vec![2]);
    settle().await;
    assert_eq!(sender.attempts.lock().unwrap().len(), 1);
    let report = d.shutdown(Some(vec![9])).await;
    assert_eq!(report.dropped, 2);
    assert_eq!(*sender.attempts.lock().unwrap(), [vec![1], vec![9]]);
}

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn exit_lets_a_request_in_progress_finish_before_dropping() {
    let gate = Arc::new(Semaphore::new(0));
    let sender = Fake::new(Some(gate.clone()), false);
    let d = Deliverer::start(sender.clone());
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
    let sender = Fake::new(None, false);
    let d = Deliverer::start(sender.clone());
    let report = d.shutdown(None).await;
    assert_eq!(report.dropped, 0);
    assert!(sender.attempts.lock().unwrap().is_empty());
}
