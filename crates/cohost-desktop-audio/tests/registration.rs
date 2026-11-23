//! The connector registration life cycle against a recording stand-in for the Redis registry
//! (`cohost-bus`'s `write_registration` and `delete_registration`).
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cohost_desktop_audio::registration::{
    Registrar, RegistrationConfig, RegistryStore, detail_for,
};
use cohost_desktop_audio::source::SourceChoice;

#[derive(Debug, PartialEq)]
enum Call {
    Write {
        id: String,
        json: String,
        lease_ms: u64,
    },
    Delete {
        id: String,
    },
}

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<Call>>,
    /// Writes that fail before the first success.
    failing: Mutex<u32>,
    /// What a read of the helper's key returns.
    held: Mutex<Option<String>>,
    /// Makes reads fail.
    read_error: Mutex<bool>,
}

impl RegistryStore for Fake {
    async fn write_registration(&self, id: &str, json: &str, lease_ms: u64) -> Result<(), String> {
        self.calls.lock().unwrap().push(Call::Write {
            id: id.into(),
            json: json.into(),
            lease_ms,
        });
        let mut failing = self.failing.lock().unwrap();
        if *failing > 0 {
            *failing -= 1;
            return Err("redis unreachable".into());
        }
        Ok(())
    }
    async fn read_registration(&self, _id: &str) -> Result<Option<String>, String> {
        if *self.read_error.lock().unwrap() {
            return Err("redis unreachable".into());
        }
        Ok(self.held.lock().unwrap().clone())
    }
    async fn delete_registration(&self, id: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Delete { id: id.into() });
        Ok(())
    }
}

impl Fake {
    fn writes(&self) -> usize {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| matches!(c, Call::Write { .. }))
            .count()
    }
}

fn config() -> RegistrationConfig {
    RegistrationConfig::new(
        5_000,
        "0.1.0",
        "inst-1",
        "default sink monitor",
        1_700_000_000_000,
    )
}

async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

// @spec CONN-DESK-004
#[tokio::test(start_paused = true)]
async fn the_registration_carries_kind_version_instance_pid_state_and_the_device_detail() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    {
        let calls = store.calls.lock().unwrap();
        let Some(Call::Write { json, .. }) = calls.first() else {
            panic!("no write")
        };
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["kind"], "desktop");
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v["instance"], "inst-1");
        assert_eq!(v["pid"], std::process::id());
        assert_eq!(v["startedAt"], 1_700_000_000_000_u64);
        assert_eq!(v["state"], "ready");
        assert_eq!(v["detail"], "default sink monitor");
    }
    reg.stop().await;
}

// @spec CONN-DESK-005
#[tokio::test(start_paused = true)]
async fn failed_writes_retry_at_500_then_1000_ms_and_the_interval_cadence_resumes_after_a_success()
{
    let store = Arc::new(Fake {
        failing: Mutex::new(2),
        ..Fake::default()
    });
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    assert_eq!(store.writes(), 1);
    tokio::time::advance(Duration::from_millis(499)).await;
    settle().await;
    assert_eq!(store.writes(), 1);
    tokio::time::advance(Duration::from_millis(1)).await;
    settle().await;
    assert_eq!(store.writes(), 2);
    tokio::time::advance(Duration::from_millis(1_000)).await;
    settle().await;
    assert_eq!(store.writes(), 3);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert_eq!(store.writes(), 4);
    reg.stop().await;
}

// @spec CONN-DESK-001
#[tokio::test(start_paused = true)]
async fn registers_connector_desktop_with_an_http_audio_in_capability() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    {
        let calls = store.calls.lock().unwrap();
        let Some(Call::Write { id, json, lease_ms }) = calls.first() else {
            panic!("no write: {calls:?}")
        };
        assert_eq!(id, "desktop");
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["id"], "desktop");
        assert_eq!(v["intervalMs"], 5_000);
        assert_eq!(*lease_ms, 15_000);
        assert_eq!(
            v["capabilities"],
            serde_json::json!([{ "cap": "audio-in", "tag": "desktop", "format": { "rate": 16000, "channels": 1 }, "ready": true, "transport": "http" }])
        );
    }
    reg.stop().await;
}

// @spec CONN-DESK-001
#[tokio::test(start_paused = true)]
async fn rewrites_the_registration_every_interval() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    assert_eq!(store.writes(), 1);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert_eq!(store.writes(), 2);
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert_eq!(store.writes(), 3);
    reg.stop().await;
}

// @spec CONN-DESK-001
#[tokio::test(start_paused = true)]
async fn an_orderly_stop_deletes_the_registration_and_writes_no_more() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    reg.stop().await;
    {
        let calls = store.calls.lock().unwrap();
        assert_eq!(
            calls.last(),
            Some(&Call::Delete {
                id: "desktop".into()
            })
        );
    }
    let before = store.calls.lock().unwrap().len();
    tokio::time::advance(Duration::from_millis(30_000)).await;
    settle().await;
    assert_eq!(store.calls.lock().unwrap().len(), before);
}

// @spec CONN-DESK-004
#[test]
fn the_detail_names_the_captured_device() {
    assert_eq!(
        detail_for(&SourceChoice::DefaultMonitor),
        "default sink monitor"
    );
    assert_eq!(
        detail_for(&SourceChoice::Named("alsa_output.x.monitor".into())),
        "alsa_output.x.monitor"
    );
    assert_eq!(
        detail_for(&SourceChoice::DefaultRender),
        "default render device"
    );
}

// @spec CONN-DESK-004
#[tokio::test(start_paused = true)]
async fn a_different_instance_under_the_key_stops_the_writes_and_the_stop_leaves_the_key() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    *store.held.lock().unwrap() = Some(r#"{"instance":"someone-else"}"#.into());
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert_eq!(store.writes(), 1);
    assert!(reg.is_displaced());
    reg.stop().await;
    assert!(
        !store
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, Call::Delete { .. }))
    );
}

// @spec CONN-DESK-004
#[tokio::test(start_paused = true)]
async fn the_same_instance_under_the_key_keeps_the_writes_and_the_stop_deletes() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    *store.held.lock().unwrap() = Some(r#"{"instance":"inst-1"}"#.into());
    tokio::time::advance(Duration::from_millis(5_000)).await;
    settle().await;
    assert_eq!(store.writes(), 2);
    reg.stop().await;
    assert!(
        store
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, Call::Delete { .. }))
    );
}

// @spec CONN-DESK-005
#[tokio::test(start_paused = true)]
async fn a_different_instance_found_while_retrying_ends_the_retries() {
    let store = Arc::new(Fake {
        failing: Mutex::new(5),
        ..Fake::default()
    });
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    assert_eq!(store.writes(), 1);
    *store.held.lock().unwrap() = Some(r#"{"instance":"someone-else"}"#.into());
    tokio::time::advance(Duration::from_millis(30_000)).await;
    settle().await;
    assert_eq!(store.writes(), 1);
    reg.stop().await;
}

// @spec CONN-DESK-004
#[tokio::test(start_paused = true)]
async fn stop_leaves_a_key_another_instance_took_after_the_last_rewrite() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    *store.held.lock().unwrap() = Some(r#"{"instance":"someone-else"}"#.into());
    assert_eq!(reg.stop().await, None);
    assert!(
        !store
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, Call::Delete { .. }))
    );
}

// @spec CONN-DESK-004
#[tokio::test(start_paused = true)]
async fn stop_does_not_delete_a_key_it_cannot_read() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), config());
    settle().await;
    *store.read_error.lock().unwrap() = true;
    assert!(reg.stop().await.is_some());
    assert!(
        !store
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| matches!(c, Call::Delete { .. }))
    );
}
