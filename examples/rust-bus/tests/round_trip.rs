//! The example against a real Redis, with a stream prefix of its own (BUS-NAT-CI-002). Skips itself, printing why,
//! when Redis is unreachable, as the crate's integration tests do. Needs only what the example's own manifest names:
//! `cohost-bus`, `tokio` and `serde_json`.
use cohost_bus::codec::parse_heartbeat;
use cohost_bus::transport::{EntryFields, EventStream};
use cohost_bus::{Transport, TransportOptions};
use cohost_example_bus::run;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A writer the test can read while `run` holds the other end.
#[derive(Clone, Default)]
struct Lines(Arc<Mutex<Vec<u8>>>);

impl Write for Lines {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Lines {
    fn lines(&self) -> Vec<String> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .map(str::to_string)
            .collect()
    }
}

fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
}

fn unique_prefix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("exbus-{}-{nanos}", std::process::id())
}

/// A transport on the test's own prefix, or `None` (after printing why) when Redis is unreachable.
async fn fixture(name: &str, prefix: &str) -> Option<Transport> {
    let url = redis_url();
    let t = Transport::new(
        &url,
        TransportOptions {
            prefix: prefix.to_string(),
            fail_fast: true,
        },
    );
    match tokio::time::timeout(Duration::from_secs(2), t.server_time()).await {
        Ok(Ok(_)) => Some(t),
        _ => {
            eprintln!("SKIP {name}: Redis unreachable at {url} (set REDIS_URL)");
            t.close().await;
            None
        }
    }
}

async fn until<T, F, Fut>(what: &str, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Option<T>>,
{
    let t0 = Instant::now();
    loop {
        if let Some(v) = probe().await {
            return v;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(10),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn heartbeats(t: &Transport) -> Vec<cohost_bus::codec::Heartbeat> {
    t.recent(EventStream::Health, 50)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|e| serde_json::from_str::<serde_json::Value>(&e.data?).ok())
        .map(|v| parse_heartbeat(&v).expect("every heartbeat on the stream passes parse_heartbeat"))
        .collect()
}

// @spec BUS-NAT-EX-002, BUS-NAT-EX-003, BUS-NAT-EX-004, BUS-NAT-EX-005
#[tokio::test(flavor = "multi_thread")]
async fn heartbeats_reads_by_envelope_and_stops_with_a_stopping_heartbeat() {
    let prefix = unique_prefix();
    let Some(t) = fixture("round_trip", &prefix).await else {
        return;
    };
    let out = Lines::default();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let url = redis_url();
    let run_prefix = prefix.clone();
    let run_out = out.clone();
    let program = tokio::spawn(async move {
        run(
            &url,
            &run_prefix,
            async {
                let _ = stop_rx.await;
            },
            run_out,
        )
        .await
    });

    // BUS-NAT-EX-002: a ready heartbeat at once, for the service rust-example.
    let first = until("the first heartbeat", || async {
        heartbeats(&t).await.into_iter().next()
    })
    .await;
    let pid = std::process::id() as i64;
    assert_eq!(first.service, "rust-example");
    assert_eq!(first.state, "ready");
    assert_eq!(first.mode, "live");
    assert!(first.deps.is_empty());
    assert_eq!(first.interval_ms, 5000);
    assert_eq!(first.pid, pid);
    assert_eq!(first.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(first.instance, format!("{pid}-{}", first.started_at as u64));

    // BUS-NAT-EX-003: the group `rust-example` exists once the example has set it up (a second create reports it).
    until("the consumer group", || async {
        (!t.create_group("rust-example").await.unwrap()).then_some(())
    })
    .await;
    let append = |ty: &str, source: &str, data: &str| {
        t.append(
            EventStream::Events,
            EntryFields {
                r#type: ty.to_string(),
                ts: "1".to_string(),
                source: source.to_string(),
                data: data.to_string(),
            },
        )
    };
    append(
        "vision.summary",
        "tester",
        "{\"text\":\"a song\",\"changed\":true}",
    )
    .await
    .unwrap();
    append("brain.say", "cortex", "not even json, and never decoded")
        .await
        .unwrap();
    until("both lines", || async {
        (out.lines().len() >= 2).then_some(())
    })
    .await;
    assert_eq!(
        out.lines(),
        vec!["vision.summary from tester", "brain.say from cortex"]
    );

    // BUS-NAT-EX-004: asked to stop, it publishes `stopping`, returns Ok.
    let asked = Instant::now();
    stop_tx.send(()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(5), program)
        .await
        .expect("run returns after the stop")
        .unwrap();
    assert!(result.is_ok(), "{result:?}");
    assert!(
        asked.elapsed() < Duration::from_secs(4),
        "stopped within the read's block time plus one second"
    );
    let all = heartbeats(&t).await;
    assert_eq!(all.last().expect("heartbeats").state, "stopping");
    assert_eq!(all.last().unwrap().instance, first.instance);
    t.close().await;
}
