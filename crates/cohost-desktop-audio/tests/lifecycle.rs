//! The helper's stop: the last delivery attempt, the registration delete and the exit status, in order.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cohost_desktop_audio::deliver::{ClipSender, Deliverer};
use cohost_desktop_audio::lifecycle::{StopReason, stop};
use cohost_desktop_audio::post::PostError;
use cohost_desktop_audio::registration::{Registrar, RegistrationConfig, RegistryStore};

type Events = Arc<Mutex<Vec<String>>>;

struct Sender(Events);
impl ClipSender for Sender {
    async fn send(&self, clip: &[i16]) -> Result<(), PostError> {
        self.0.lock().unwrap().push(format!("send {}", clip[0]));
        Ok(())
    }
}

struct Store {
    events: Events,
    held: Mutex<Option<String>>,
}
impl RegistryStore for Store {
    async fn write_registration(&self, _id: &str, _json: &str, _lease_ms: u64) -> Result<(), String> {
        self.events.lock().unwrap().push("write".into());
        Ok(())
    }
    async fn read_registration(&self, _id: &str) -> Result<Option<String>, String> {
        Ok(self.held.lock().unwrap().clone())
    }
    async fn delete_registration(&self, _id: &str) -> Result<(), String> {
        self.events.lock().unwrap().push("delete".into());
        Ok(())
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

fn rig() -> (Events, Arc<Store>, Deliverer<Sender>, Registrar<Store>) {
    let events: Events = Arc::default();
    let store = Arc::new(Store { events: events.clone(), held: Mutex::new(None) });
    let reg = Registrar::start(store.clone(), RegistrationConfig::new(5_000, "0.1.0", "inst-1", "default sink monitor", 1));
    let d = Deliverer::start(Arc::new(Sender(events.clone())), |_| {});
    (events, store, d, reg)
}

fn position(events: &Events, what: &str) -> Option<usize> {
    events.lock().unwrap().iter().position(|e| e == what)
}

// @spec EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn an_orderly_stop_attempts_the_held_clip_before_it_deletes_the_registration_and_exits_zero() {
    let (events, _store, d, reg) = rig();
    settle().await;
    let stopped = stop(d, reg, Some(vec![9]), StopReason::Signal).await;
    assert_eq!(stopped.exit_code, 0);
    let (sent, deleted) = (position(&events, "send 9"), position(&events, "delete"));
    assert!(sent.is_some() && deleted.is_some() && sent < deleted, "{:?}", events.lock().unwrap());
}

// @spec EARS-SRC-022, EARS-SRC-019
#[tokio::test(start_paused = true)]
async fn a_device_failure_stops_the_same_way_and_exits_non_zero() {
    let (events, _store, d, reg) = rig();
    settle().await;
    let stopped = stop(d, reg, Some(vec![9]), StopReason::DeviceFailure).await;
    assert_ne!(stopped.exit_code, 0);
    assert!(position(&events, "send 9") < position(&events, "delete"));
    assert!(position(&events, "delete").is_some());
}

// @spec CONN-DESK-004, EARS-SRC-022
#[tokio::test(start_paused = true)]
async fn a_displaced_helper_flushes_without_deleting_the_key_and_exits_non_zero() {
    let (events, store, d, reg) = rig();
    settle().await;
    *store.held.lock().unwrap() = Some(r#"{"instance":"someone-else"}"#.into());
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert!(reg.is_displaced());
    let stopped = stop(d, reg, Some(vec![9]), StopReason::Displaced).await;
    assert_ne!(stopped.exit_code, 0);
    assert!(position(&events, "send 9").is_some());
    assert!(position(&events, "delete").is_none());
}
