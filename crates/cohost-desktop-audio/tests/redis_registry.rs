//! The registration against a real Redis: the key the helper writes is scoped by the prefix, and
//! a stop deletes the key only while it is this instance's. Runs when `REDIS_URL` is set (CI has
//! a Redis); skipped otherwise.
use std::sync::Arc;
use std::time::Duration;

use cohost_desktop_audio::redis_registry::BusRegistry;
use cohost_desktop_audio::registration::{Registrar, RegistrationConfig, RegistryStore};

fn redis_url() -> Option<String> {
    std::env::var("REDIS_URL").ok().filter(|u| !u.is_empty())
}

fn unique_prefix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("desktop-test-{}-{nanos}", std::process::id())
}

fn config(instance: &str) -> RegistrationConfig {
    RegistrationConfig::new(60_000, "0.1.0", instance, "default sink monitor", 1)
}

// @spec CONN-DESK-004, CONN-REG-003
#[tokio::test]
async fn the_key_is_scoped_by_the_prefix_and_a_stop_deletes_only_our_own_registration() {
    let Some(url) = redis_url() else {
        eprintln!("REDIS_URL not set: skipping the Redis registration test");
        return;
    };
    let prefix = unique_prefix();
    let store = Arc::new(BusRegistry::connect(&url, &prefix));

    let reg = Registrar::start(store.clone(), config("ours"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    let written = store
        .read_registration("desktop")
        .await
        .unwrap()
        .expect("first write");
    assert!(written.contains("\"instance\":\"ours\""), "{written}");

    let other_prefix = BusRegistry::connect(&url, &format!("{prefix}-other"));
    assert_eq!(
        other_prefix.read_registration("desktop").await.unwrap(),
        None
    );

    // Another instance takes the key after our last rewrite: our stop leaves it.
    store
        .write_registration("desktop", r#"{"instance":"theirs"}"#, 15_000)
        .await
        .unwrap();
    assert_eq!(reg.stop().await, None);
    assert_eq!(
        store.read_registration("desktop").await.unwrap().as_deref(),
        Some(r#"{"instance":"theirs"}"#)
    );

    // Our own key is deleted by an orderly stop.
    store.delete_registration("desktop").await.unwrap();
    let reg = Registrar::start(store.clone(), config("ours"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(reg.stop().await, None);
    assert_eq!(store.read_registration("desktop").await.unwrap(), None);
}
