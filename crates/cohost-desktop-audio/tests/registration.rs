//! The connector registration life cycle against a recording stand-in for the Redis registry
//! (`cohost-bus`'s `write_registration` and `delete_registration`).
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cohost_desktop_audio::registration::{Registrar, RegistryStore};

#[derive(Debug, PartialEq)]
enum Call {
    Write { id: String, json: String },
    Delete { id: String },
}

#[derive(Default)]
struct Fake(Mutex<Vec<Call>>);

impl RegistryStore for Fake {
    async fn write_registration(&self, id: &str, json: &str, _lease_ms: u64) -> Result<(), String> {
        self.0.lock().unwrap().push(Call::Write { id: id.into(), json: json.into() });
        Ok(())
    }
    async fn delete_registration(&self, id: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(Call::Delete { id: id.into() });
        Ok(())
    }
}

impl Fake {
    fn writes(&self) -> usize {
        self.0.lock().unwrap().iter().filter(|c| matches!(c, Call::Write { .. })).count()
    }
}

async fn settle() {
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
}

// @spec CONN-DESK-001
#[tokio::test(start_paused = true)]
async fn registers_connector_desktop_with_an_http_audio_in_capability() {
    let store = Arc::new(Fake::default());
    let reg = Registrar::start(store.clone(), 5_000);
    settle().await;
    {
        let calls = store.0.lock().unwrap();
        let Some(Call::Write { id, json }) = calls.first() else { panic!("no write: {calls:?}") };
        assert_eq!(id, "desktop");
        let v: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["v"], 1);
        assert_eq!(v["id"], "desktop");
        assert_eq!(v["intervalMs"], 5_000);
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
    let reg = Registrar::start(store.clone(), 5_000);
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
    let reg = Registrar::start(store.clone(), 5_000);
    settle().await;
    reg.stop().await;
    {
        let calls = store.0.lock().unwrap();
        assert_eq!(calls.last(), Some(&Call::Delete { id: "desktop".into() }));
    }
    let before = store.0.lock().unwrap().len();
    tokio::time::advance(Duration::from_millis(30_000)).await;
    settle().await;
    assert_eq!(store.0.lock().unwrap().len(), before);
}
