//! Delivery retry (EARS-SRC-020): the backoff, the bounded waiting queue and the failure log.

use std::collections::VecDeque;
use std::time::Duration;

use crate::post::PostError;

/// Clips that may wait for delivery; a fifth drops the oldest.
pub const MAX_WAITING: usize = 4;
const FIRST_DELAY: Duration = Duration::from_millis(500);
const MAX_DELAY: Duration = Duration::from_secs(30);

/// The delay before the next retry: 500 ms, doubling on each consecutive failure, capped at 30 s.
#[derive(Debug, Clone)]
pub struct Backoff {
    next: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self { next: FIRST_DELAY }
    }

    pub fn next_delay(&mut self) -> Duration {
        let delay = self.next;
        self.next = (self.next * 2).min(MAX_DELAY);
        delay
    }

    /// Called after a delivery succeeds.
    pub fn reset(&mut self) {
        self.next = FIRST_DELAY;
    }
}

/// Clips waiting for delivery, oldest first.
#[derive(Debug, Default)]
pub struct ClipQueue {
    items: VecDeque<Vec<i16>>,
}

impl ClipQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Queues a new clip; when the queue is full the oldest waiting clip is returned as dropped.
    // @spec EARS-SRC-020
    pub fn push(&mut self, clip: Vec<i16>) -> Option<Vec<i16>> {
        let dropped = if self.items.len() >= MAX_WAITING {
            self.items.pop_front()
        } else {
            None
        };
        self.items.push_back(clip);
        dropped
    }

    /// Returns a clip to the front after a retryable failure. It is the oldest, so when the queue
    /// is already full it is itself returned as dropped.
    pub fn push_front(&mut self, clip: Vec<i16>) -> Option<Vec<i16>> {
        if self.items.len() >= MAX_WAITING {
            return Some(clip);
        }
        self.items.push_front(clip);
        None
    }

    pub fn pop(&mut self) -> Option<Vec<i16>> {
        self.items.pop_front()
    }

    /// Discards every waiting clip and returns how many there were.
    pub fn discard(&mut self) -> usize {
        let n = self.items.len();
        self.items.clear();
        n
    }
}

/// Logs a failure when it is first seen after a delivery and whenever it changes, so a repeated
/// failure is logged once.
#[derive(Debug, Default)]
pub struct FailureLog {
    last: Option<PostError>,
}

impl FailureLog {
    pub fn new() -> Self {
        Self::default()
    }

    // @spec EARS-SRC-020
    pub fn observe(&mut self, err: &PostError) -> Option<String> {
        if self.last.as_ref() == Some(err) {
            return None;
        }
        self.last = Some(err.clone());
        Some(format!("delivery failed ({err}), retrying"))
    }

    /// Called after a delivery succeeds.
    pub fn clear(&mut self) {
        self.last = None;
    }
}

/// What to do with a clip whose post failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disposition {
    Retry,
    /// Drop the clip, with the line to log.
    Drop(String),
}

// @spec EARS-SRC-020
pub fn disposition(err: &PostError) -> Disposition {
    if err.is_retryable() {
        Disposition::Retry
    } else {
        Disposition::Drop(format!("ears refused a clip ({err}), dropped it"))
    }
}
