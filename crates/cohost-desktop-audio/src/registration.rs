//! The connector registration of the helper (CONN-DESK-001, CONN-DESK-004, CONN-DESK-005).

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::retry::Backoff;
use crate::source::SourceChoice;

/// The connector id the helper registers under.
pub const CONNECTOR_ID: &str = "desktop";

/// The Redis registry the helper writes its key to. The Redis implementation wraps `cohost-bus`.
pub trait RegistryStore: Send + Sync + 'static {
    /// Writes `json` under the connector's key with a lease of `lease_ms`.
    fn write_registration(
        &self,
        id: &str,
        json: &str,
        lease_ms: u64,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn read_registration(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Option<String>, String>> + Send;
    fn delete_registration(&self, id: &str) -> impl Future<Output = Result<(), String>> + Send;
}

/// The fields of the registration that do not change while the helper runs.
#[derive(Debug, Clone)]
pub struct RegistrationConfig {
    interval_ms: u64,
    version: String,
    instance: String,
    detail: String,
    started_at_ms: u64,
}

impl RegistrationConfig {
    pub fn new(
        interval_ms: u64,
        version: &str,
        instance: &str,
        detail: &str,
        started_at_ms: u64,
    ) -> Self {
        Self {
            interval_ms,
            version: version.into(),
            instance: instance.into(),
            detail: detail.into(),
            started_at_ms,
        }
    }

    /// The registration's lease: three intervals (CONN-REG-002).
    fn lease_ms(&self) -> u64 {
        self.interval_ms * 3
    }

    // @spec CONN-DESK-001, CONN-DESK-004
    fn json(&self) -> String {
        serde_json::json!({
            "v": 1,
            "id": CONNECTOR_ID,
            "kind": "desktop",
            "version": self.version,
            "instance": self.instance,
            "pid": std::process::id(),
            "startedAt": self.started_at_ms,
            "intervalMs": self.interval_ms,
            "state": "ready",
            "detail": self.detail,
            "capabilities": [{
                "cap": "audio-in",
                "tag": "desktop",
                "format": { "rate": 16000, "channels": 1 },
                "ready": true,
                "transport": "http",
            }],
        })
        .to_string()
    }
}

/// The `detail` field: the device the helper captures.
// @spec CONN-DESK-004
pub fn detail_for(choice: &SourceChoice) -> String {
    match choice {
        SourceChoice::DefaultMonitor => "default sink monitor".into(),
        SourceChoice::Named(name) => name.clone(),
        SourceChoice::DefaultRender => "default render device".into(),
    }
}

/// Keeps the helper's key written. Create it after the capture device is open, so the first
/// registration is `ready`.
pub struct Registrar<S: RegistryStore> {
    store: Arc<S>,
    instance: String,
    displaced: Arc<AtomicBool>,
    stop_tx: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl<S: RegistryStore> Registrar<S> {
    /// Writes the first registration now, then rewrites it every interval.
    // @spec CONN-DESK-001, CONN-DESK-005
    pub fn start(store: Arc<S>, cfg: RegistrationConfig) -> Self {
        let displaced = Arc::new(AtomicBool::new(false));
        let (stop_tx, stop_rx) = oneshot::channel();
        let instance = cfg.instance.clone();
        let task = tokio::spawn(run(store.clone(), cfg, displaced.clone(), stop_rx));
        Self {
            store,
            instance,
            displaced,
            stop_tx,
            task,
        }
    }

    /// The displaced flag, shareable with the capture loop.
    pub fn displaced_flag(&self) -> Arc<AtomicBool> {
        self.displaced.clone()
    }

    /// True once another instance has taken the key; the helper then stops writing.
    // @spec CONN-DESK-004
    pub fn is_displaced(&self) -> bool {
        self.displaced.load(Ordering::SeqCst)
    }

    /// Stops the writes, then deletes the key only if it is absent or still this instance's, as
    /// read just before the delete (packages/bus registrar). A key another instance took after the
    /// last rewrite is left alone. Returns why the key was not deleted, or the delete error.
    // @spec CONN-DESK-004
    pub async fn stop(self) -> Option<String> {
        let Self {
            store,
            instance,
            stop_tx,
            task,
            ..
        } = self;
        let _ = stop_tx.send(());
        let _ = task.await;
        let held = match store.read_registration(CONNECTOR_ID).await {
            Ok(held) => held,
            Err(e) => {
                return Some(format!(
                    "registration not deleted: could not read the key ({e})"
                ));
            }
        };
        if held.is_some_and(|h| holds_other_instance(&h, &instance)) {
            return None;
        }
        store.delete_registration(CONNECTOR_ID).await.err()
    }
}

async fn run<S: RegistryStore>(
    store: Arc<S>,
    cfg: RegistrationConfig,
    displaced: Arc<AtomicBool>,
    mut stop: oneshot::Receiver<()>,
) {
    let json = cfg.json();
    let lease = cfg.lease_ms();
    let interval = Duration::from_millis(cfg.interval_ms);
    let mut backoff = Backoff::new();
    let mut first = true;
    loop {
        if !first {
            // Before each rewrite: another instance under the key ends the writes and the retries.
            if let Ok(Some(held)) = store.read_registration(CONNECTOR_ID).await
                && holds_other_instance(&held, &cfg.instance)
            {
                displaced.store(true, Ordering::SeqCst);
                return;
            }
        }
        first = false;
        let delay = match store.write_registration(CONNECTOR_ID, &json, lease).await {
            Ok(()) => {
                backoff.reset();
                interval
            }
            Err(_) => backoff.next_delay(),
        };
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = &mut stop => return,
        }
    }
}

fn holds_other_instance(held: &str, instance: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(held)
        .ok()
        .and_then(|v| v.get("instance")?.as_str().map(str::to_owned))
        .is_some_and(|other| other != instance)
}
