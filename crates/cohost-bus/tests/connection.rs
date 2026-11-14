//! Connection-failure behaviour of the native transport, driven through a TCP proxy that tests can break on demand
//! (BUS-NAT-CONN-*, BUS-NAT-ERR-009/010, BUS-NAT-ACK-004/006/007, BUS-NAT-TRN-003/004).
mod common;

use cohost_bus::ErrorCode;
use cohost_bus::transport::{EntryFields, EventStream, Transport, TransportOptions};
use common::{Mode, Proxy, within};
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::time::sleep;

fn opts(prefix: &str, fail_fast: bool) -> TransportOptions {
    TransportOptions {
        prefix: prefix.to_string(),
        fail_fast,
    }
}

fn entry(n: usize) -> EntryFields {
    EntryFields {
        r#type: "t".into(),
        ts: n.to_string(),
        source: "s".into(),
        data: "{}".into(),
    }
}

async fn pending(fx: &common::Fixture, group: &str) -> i64 {
    let mut conn = fx.raw.clone();
    let r: redis::Value = redis::cmd("XPENDING")
        .arg(fx.events())
        .arg(group)
        .query_async(&mut conn)
        .await
        .unwrap();
    match r {
        redis::Value::Array(v) => match v.first() {
            Some(redis::Value::Int(n)) => *n,
            _ => 0,
        },
        _ => 0,
    }
}

/// Retries `append` every 100 ms until it succeeds or `ms` pass.
async fn append_eventually(t: &Transport, ms: u64) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        if t.append(EventStream::Events, entry(0)).await.is_ok() {
            return true;
        }
        sleep(Duration::from_millis(100)).await;
    }
    false
}

// @spec BUS-NAT-TRN-004
#[tokio::test(flavor = "multi_thread")]
async fn trn_004_construction_never_blocks_or_fails_when_redis_is_unreachable() {
    let url = common::dead_url().await;
    let started = Instant::now();
    let t = Transport::new(&url, opts("natbus-trn004", false));
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "new() returns at once"
    );
    t.close().await;
}

// @spec BUS-NAT-TRN-003, BUS-NAT-CONN-001
#[tokio::test(flavor = "multi_thread")]
async fn trn_003_conn_001_reader_failure_rejects_at_once_without_retry_then_reconnects_on_next_call()
 {
    let fx = fixture_or_skip!("conn001");
    // A server that accepts and drops every connection, counting attempts.
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let c2 = count.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = l.accept().await {
            c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(s);
        }
    });
    let t = Transport::new(&format!("redis://{addr}"), opts(&fx.prefix, true));
    let r = t.open_reader();
    let before = count.load(std::sync::atomic::Ordering::SeqCst);
    let started = Instant::now();
    let err = r
        .read(EventStream::Events, "0", 10, 5000)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Connection);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "rejects at once"
    );
    sleep(Duration::from_millis(600)).await;
    let attempts = count.load(std::sync::atomic::Ordering::SeqCst) - before;
    assert_eq!(
        attempts, 1,
        "the reader made one connect attempt and did not retry (shared conn is failFast)"
    );
    // The next call opens a new connection.
    let _ = r.read(EventStream::Events, "0", 10, 50).await;
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst) - before, 2);
    t.close().await;
}

// @spec BUS-NAT-CONN-001
#[tokio::test(flavor = "multi_thread")]
async fn conn_001_dropped_blocked_read_rejects_connection_and_next_call_reconnects() {
    let mut fx = fixture_or_skip!("conn001b");
    let proxy = Proxy::start().await;
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert!(t.create_group("g").await.unwrap());
    let r = std::sync::Arc::new(t.open_reader());
    let r2 = r.clone();
    let blocked = tokio::spawn(async move { r2.read_group("g", "c1", ">", 10, 5000).await });
    sleep(Duration::from_millis(300)).await;
    proxy.kill_all();
    let res = within(2000, blocked)
        .await
        .expect("rejects at once")
        .unwrap();
    assert_eq!(res.unwrap_err().code, ErrorCode::Connection);
    let accepted = proxy.accepted();
    let ok = r.read_group("g", "c1", ">", 10, 50).await;
    assert!(ok.is_ok(), "the next call reconnected");
    assert!(proxy.accepted() > accepted);
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-CONN-004
#[tokio::test(flavor = "multi_thread")]
async fn conn_004_shared_connection_reconnects_in_the_background_with_doubling_delay() {
    let mut fx = fixture_or_skip!("conn004");
    let proxy = Proxy::start().await;
    proxy.set_mode(Mode::Reject);
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert_eq!(
        t.append(EventStream::Events, entry(1))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Connection
    );
    sleep(Duration::from_millis(1900)).await;
    // Attempts at about 0, 250, 750 and 1750 ms: more than one, fewer than a fixed-250 ms retry would make.
    let attempts = proxy.accepted();
    assert!(
        (3..=5).contains(&attempts),
        "doubling delay, got {attempts} attempts in 1.9 s"
    );
    proxy.set_mode(Mode::Pass);
    assert!(
        append_eventually(&t, 5000).await,
        "reconnects once Redis is reachable"
    );
    // An established connection that drops is reconnected too.
    proxy.kill_all();
    assert!(append_eventually(&t, 5000).await);
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-STREAM-009, BUS-NAT-CONN-004
#[tokio::test(flavor = "multi_thread")]
async fn conn_004_fail_fast_never_reconnects() {
    let mut fx = fixture_or_skip!("conn004ff");
    let proxy = Proxy::start().await;
    proxy.set_mode(Mode::Reject);
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, true));
    assert_eq!(
        t.append(EventStream::Events, entry(1))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Connection
    );
    proxy.set_mode(Mode::Pass);
    sleep(Duration::from_millis(1500)).await;
    let started = Instant::now();
    assert_eq!(
        t.append(EventStream::Events, entry(2))
            .await
            .unwrap_err()
            .code,
        ErrorCode::Connection
    );
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "rejects at once"
    );
    assert_eq!(proxy.accepted(), 1, "one connect attempt, ever");
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-CONN-005
#[tokio::test(flavor = "multi_thread")]
async fn conn_005_while_down_every_command_rejects_at_once_even_during_a_reconnect_attempt() {
    let mut fx = fixture_or_skip!("conn005");
    let proxy = Proxy::start().await;
    proxy.set_mode(Mode::Reject);
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert!(t.append(EventStream::Events, entry(1)).await.is_err());
    sleep(Duration::from_millis(300)).await;
    // From now on a reconnect attempt hangs in flight (Blackhole): commands must not wait for it.
    proxy.set_mode(Mode::Blackhole);
    sleep(Duration::from_millis(1500)).await;
    let started = Instant::now();
    let results = vec![
        t.append(EventStream::Events, entry(2)).await.map(|_| ()),
        t.append(EventStream::Health, entry(2)).await.map(|_| ()),
        t.recent(EventStream::Events, 1).await.map(|_| ()),
        t.create_group("g").await.map(|_| ()),
        t.move_group_to_latest("g").await,
        t.put_upload("u", &[0], 1000).await,
        t.take_upload("u").await.map(|_| ()),
        t.write_registration("c", "{}", 1000).await,
        t.read_registration("c").await.map(|_| ()),
        t.delete_registration("c").await,
        t.list_registrations().await.map(|_| ()),
        t.server_time().await.map(|_| ()),
    ];
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "all rejected at once, none queued"
    );
    for r in results {
        assert_eq!(r.unwrap_err().code, ErrorCode::Connection);
    }
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-CONN-006
#[tokio::test(flavor = "multi_thread")]
async fn conn_006_command_during_first_connect_waits_for_the_attempt_then_runs() {
    let mut fx = fixture_or_skip!("conn006");
    let proxy = Proxy::start().await;
    proxy.set_delay(600);
    let started = Instant::now();
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    let id = t
        .append(EventStream::Events, entry(1))
        .await
        .expect("waited for the first attempt, then ran");
    assert!(!id.is_empty());
    assert!(
        started.elapsed() >= Duration::from_millis(500),
        "it did wait for the connect"
    );
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-CONN-007, BUS-NAT-ERR-009
#[tokio::test(flavor = "multi_thread")]
async fn conn_007_connect_attempt_is_abandoned_after_10_seconds_naming_connect_timeout() {
    let mut fx = fixture_or_skip!("conn007");
    let proxy = Proxy::start().await;
    proxy.set_mode(Mode::Blackhole);
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, true));
    let reader = t.open_reader();
    let started = Instant::now();
    let (shared, read) = tokio::join!(
        t.append(EventStream::Events, entry(1)),
        reader.read(EventStream::Events, "0", 10, 50)
    );
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(9500) && took < Duration::from_secs(13),
        "10 s timeout, took {took:?}"
    );
    for e in [shared.unwrap_err(), read.unwrap_err()] {
        assert_eq!(e.code, ErrorCode::Connection);
        assert!(
            e.message.contains("connect timeout"),
            "message names the cause, got {:?}",
            e.message
        );
    }
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ERR-009
#[tokio::test(flavor = "multi_thread")]
async fn err_009_connection_error_message_names_the_os_error() {
    let url = common::dead_url().await;
    let t = Transport::new(&url, opts("natbus-err009", true));
    let e = t.append(EventStream::Events, entry(1)).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Connection);
    assert!(
        e.message.to_lowercase().contains("refused"),
        "OS error text, got {:?}",
        e.message
    );
    t.close().await;
}

// @spec BUS-NAT-ERR-010
#[tokio::test(flavor = "multi_thread")]
async fn err_010_close_during_first_connect_abandons_it_and_rejects_waiters_closed() {
    let mut fx = fixture_or_skip!("err010");
    let proxy = Proxy::start().await;
    proxy.set_mode(Mode::Blackhole);
    let t = std::sync::Arc::new(Transport::new(&proxy.url(), opts(&fx.prefix, false)));
    let t2 = t.clone();
    let waiter = tokio::spawn(async move { t2.append(EventStream::Events, entry(1)).await });
    sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    assert!(
        within(1500, t.close()).await.is_some(),
        "close() does not wait out the 10 s connect timeout"
    );
    assert!(started.elapsed() < Duration::from_millis(1500));
    let res = within(1000, waiter)
        .await
        .expect("waiter rejected")
        .unwrap();
    assert_eq!(res.unwrap_err().code, ErrorCode::Closed);
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-004
#[tokio::test(flavor = "multi_thread")]
async fn ack_004_queued_acks_survive_a_failed_pipeline_and_go_with_the_next_one() {
    let mut fx = fixture_or_skip!("ack004");
    let proxy = Proxy::start().await;
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert!(t.create_group("g").await.unwrap());
    for n in 0..2 {
        t.append(EventStream::Events, entry(n)).await.unwrap();
    }
    let r = t.open_reader();
    let entries = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    assert_eq!(entries.len(), 2);
    for e in &entries {
        r.ack("g", &e.id);
    }
    proxy.set_mode(Mode::Reject);
    proxy.kill_all();
    let err = r.read_group("g", "c1", ">", 10, 100).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Connection);
    assert_eq!(pending(&fx, "g").await, 2, "acks did not reach Redis");
    proxy.set_mode(Mode::Pass);
    r.read_group("g", "c1", ">", 10, 50).await.unwrap();
    assert_eq!(
        pending(&fx, "g").await,
        0,
        "the kept acks went with the next pipeline that reached Redis"
    );
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-006
#[tokio::test(flavor = "multi_thread")]
async fn ack_006_failed_close_flush_is_not_retried_and_close_still_resolves() {
    let mut fx = fixture_or_skip!("ack006");
    let proxy = Proxy::start().await;
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert!(t.create_group("g").await.unwrap());
    t.append(EventStream::Events, entry(1)).await.unwrap();
    let r = t.open_reader();
    let e = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    r.ack("g", &e[0].id);
    proxy.set_mode(Mode::Reject);
    proxy.kill_all();
    sleep(Duration::from_millis(100)).await;
    assert!(
        within(1500, t.close()).await.is_some(),
        "close() resolves although the flush failed"
    );
    proxy.set_mode(Mode::Pass);
    sleep(Duration::from_millis(500)).await;
    assert_eq!(pending(&fx, "g").await, 1, "no retry of the failed flush");
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-007
#[tokio::test(flavor = "multi_thread")]
async fn ack_007_close_abandons_a_hung_flush_after_2000_ms() {
    let mut fx = fixture_or_skip!("ack007");
    let proxy = Proxy::start().await;
    let t = Transport::new(&proxy.url(), opts(&fx.prefix, false));
    assert!(t.create_group("g").await.unwrap());
    t.append(EventStream::Events, entry(1)).await.unwrap();
    let r = t.open_reader();
    let e = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    r.ack("g", &e[0].id);
    proxy.mute_down(true); // Redis answers nothing from now on
    let started = Instant::now();
    assert!(within(5000, t.close()).await.is_some(), "close() resolves");
    let took = started.elapsed();
    assert!(
        took >= Duration::from_millis(1800) && took < Duration::from_millis(3200),
        "about 2 s, took {took:?}"
    );
    fx.cleanup().await;
}
