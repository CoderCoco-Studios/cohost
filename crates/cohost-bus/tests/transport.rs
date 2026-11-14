//! Integration tests of the native transport against a real Redis (REDIS_URL; skipped with a message when it is
//! unreachable). Each test uses a stream prefix of its own (BUS-NAT-CI-002).
mod common;

use cohost_bus::ErrorCode;
use cohost_bus::frame::{DecodedFrame, Direction, Frame};
use cohost_bus::transport::{
    EntryFields, EventStream, FrameEntry, Reader, Transport, TransportOptions,
};
use redis::Value;

fn open(fx: &common::Fixture) -> Transport {
    Transport::new(
        &fx.url,
        TransportOptions {
            prefix: fx.prefix.clone(),
            fail_fast: false,
        },
    )
}

fn fields(n: usize) -> EntryFields {
    EntryFields {
        r#type: "t".into(),
        ts: n.to_string(),
        source: "s".into(),
        data: format!("{{\"n\":{n}}}"),
    }
}

fn frame(seq: f64, pcm: Vec<u8>) -> Frame {
    Frame {
        epoch: 1.0,
        seq,
        rate: 16000.0,
        ch: 1.0,
        pcm,
        spk: None,
        name: None,
        utt: None,
        last: false,
        flush: false,
    }
}

async fn q<T: redis::FromRedisValue>(fx: &common::Fixture, args: &[&str]) -> T {
    let mut conn = fx.raw.clone();
    let mut c = redis::cmd(args[0]);
    for a in &args[1..] {
        c.arg(*a);
    }
    c.query_async(&mut conn).await.expect("redis command")
}

async fn xlen(fx: &common::Fixture, key: &str) -> i64 {
    q(fx, &["XLEN", key]).await
}

async fn pending(fx: &common::Fixture, group: &str) -> i64 {
    let r: Value = q(fx, &["XPENDING", &fx.events(), group]).await;
    match r {
        Value::Array(v) => match v.first() {
            Some(Value::Int(n)) => *n,
            _ => 0,
        },
        _ => 0,
    }
}

async fn frame_entries(r: &Reader, dir: Direction, tag: &str) -> Vec<FrameEntry> {
    r.read_frames(dir, tag, "0", 100, 200)
        .await
        .expect("read_frames")
        .unwrap_or_default()
}

// @spec BUS-NAT-TRN-001
#[tokio::test(flavor = "multi_thread")]
async fn trn_001_every_method_issues_its_commands_under_the_prefix() {
    let mut fx = fixture_or_skip!("trn001");
    let t = open(&fx);

    // append: XADD <prefix>:events | :health, the four envelope fields, id returned.
    let id = t.append(EventStream::Events, fields(1)).await.unwrap();
    let hid = t.append(EventStream::Health, fields(2)).await.unwrap();
    let got: Vec<(String, Vec<(String, String)>)> =
        q(&fx, &["XRANGE", &fx.events(), "-", "+"]).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].0, id);
    let names: Vec<&str> = got[0].1.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(names, ["type", "ts", "source", "data"]);
    assert_eq!(xlen(&fx, &fx.health()).await, 1);
    assert_ne!(id, hid);

    // recent: XREVRANGE ... COUNT n, returned oldest first.
    t.append(EventStream::Events, fields(3)).await.unwrap();
    let recent = t.recent(EventStream::Events, 2).await.unwrap();
    assert_eq!(
        recent
            .iter()
            .map(|e| e.ts.clone().unwrap())
            .collect::<Vec<_>>(),
        ["1", "3"]
    );

    // createGroup / moveGroupToLatest: XGROUP CREATE ... $ MKSTREAM, XGROUP SETID ... $.
    assert!(t.create_group("g").await.unwrap());
    t.append(EventStream::Events, fields(4)).await.unwrap();
    t.move_group_to_latest("g").await.unwrap();
    let r = t.open_reader();
    let read = r.read_group("g", "c1", ">", 10, 100).await.unwrap();
    assert!(
        read.entries.is_none() || read.entries.as_ref().unwrap().is_empty(),
        "SETID $ skips entry 4"
    );

    // uploads: SET <prefix>:upload:<id> PX, GETDEL.
    t.put_upload("u1", &[1, 2, 3], 5000).await.unwrap();
    let pttl: i64 = q(&fx, &["PTTL", &format!("{}:upload:u1", fx.prefix)]).await;
    assert!(pttl > 0 && pttl <= 5000);
    assert_eq!(t.take_upload("u1").await.unwrap(), Some(vec![1, 2, 3]));
    assert_eq!(t.take_upload("u1").await.unwrap(), None);

    // registrations: SET ... PX lease, GET, DEL, SCAN + MGET.
    t.write_registration("conn-a", "{\"a\":1}", 15000)
        .await
        .unwrap();
    t.write_registration("conn-b", "{\"b\":2}", 15000)
        .await
        .unwrap();
    let pttl: i64 = q(&fx, &["PTTL", &format!("{}:connector:conn-a", fx.prefix)]).await;
    assert!(pttl > 0 && pttl <= 15000);
    assert_eq!(
        t.read_registration("conn-a").await.unwrap().as_deref(),
        Some("{\"a\":1}")
    );
    let mut listed = t.list_registrations().await.unwrap();
    listed.sort();
    assert_eq!(listed, ["{\"a\":1}", "{\"b\":2}"]);
    t.delete_registration("conn-a").await.unwrap();
    assert_eq!(t.read_registration("conn-a").await.unwrap(), None);

    // serverTime: TIME as epoch ms.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    assert!((t.server_time().await.unwrap() as i64 - now).abs() < 60_000);

    // appendFrame lands in audio.<dir>.<tag> (FRM-003 checks caps and expiry).
    t.append_frame(Direction::In, "mic", &frame(0.0, vec![0, 0]))
        .await
        .unwrap();
    assert_eq!(xlen(&fx, &format!("{}:audio.in.mic", fx.prefix)).await, 1);

    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-TRN-002, BUS-NAT-ERR-002
#[tokio::test(flavor = "multi_thread")]
async fn trn_002_create_group_true_false_or_redis_error() {
    let mut fx = fixture_or_skip!("trn002");
    let t = open(&fx);
    assert!(t.create_group("g").await.unwrap(), "created");
    assert!(!t.create_group("g").await.unwrap(), "BUSYGROUP");
    t.close().await;

    // Any other Redis error rejects BUS_REDIS with Redis's text.
    let _: () = q(&fx, &["DEL", &fx.events()]).await;
    let _: () = q(&fx, &["SET", &fx.events(), "x"]).await;
    let t = open(&fx);
    let err = t.create_group("g").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Redis);
    assert!(
        err.message.contains("WRONGTYPE"),
        "message is Redis's text, got {:?}",
        err.message
    );
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-TRN-005
#[tokio::test(flavor = "multi_thread")]
async fn trn_005_one_connection_plus_one_per_reader() {
    let mut fx = fixture_or_skip!("trn005");
    let proxy = common::Proxy::start().await;
    let t = Transport::new(
        &proxy.url(),
        TransportOptions {
            prefix: fx.prefix.clone(),
            fail_fast: false,
        },
    );
    t.append(EventStream::Events, fields(1)).await.unwrap();
    t.server_time().await.unwrap();
    t.recent(EventStream::Events, 1).await.unwrap();
    assert_eq!(
        proxy.accepted(),
        1,
        "every non-blocking command shares one connection"
    );

    let r1 = t.open_reader();
    let r2 = t.open_reader();
    r1.read(EventStream::Events, "0", 10, 50).await.unwrap();
    r2.read(EventStream::Health, "0", 10, 50).await.unwrap();
    r1.read(EventStream::Events, "0", 10, 50).await.unwrap();
    t.append(EventStream::Events, fields(2)).await.unwrap();
    assert_eq!(proxy.accepted(), 3, "one connection plus one per reader");
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-TRN-008
#[tokio::test(flavor = "multi_thread")]
async fn trn_008_unawaited_commands_reach_redis_in_call_order() {
    let mut fx = fixture_or_skip!("trn008");
    let t = open(&fx);
    let calls: Vec<_> = (0..200)
        .map(|n| t.append(EventStream::Events, fields(n)))
        .collect();
    for r in futures_in_order(calls).await {
        r.unwrap();
    }
    let got: Vec<(String, Vec<(String, String)>)> =
        q(&fx, &["XRANGE", &fx.events(), "-", "+"]).await;
    let order: Vec<usize> = got.iter().map(|(_, f)| f[1].1.parse().unwrap()).collect();
    assert_eq!(order, (0..200).collect::<Vec<_>>());
    t.close().await;
    fx.cleanup().await;
}

/// Polls the futures once in order (so each reaches the transport in call order), then awaits them all.
async fn futures_in_order<F: std::future::Future>(calls: Vec<F>) -> Vec<F::Output> {
    let mut handles = Vec::new();
    for c in calls {
        let mut c = Box::pin(c);
        // First poll happens here, in call order, before the next future is created.
        let first = futures_poll_once(&mut c).await;
        handles.push((c, first));
    }
    let mut out = Vec::new();
    for (c, first) in handles {
        out.push(match first {
            Some(v) => v,
            None => c.await,
        });
    }
    out
}

async fn futures_poll_once<F: std::future::Future + Unpin>(f: &mut F) -> Option<F::Output> {
    std::future::poll_fn(|cx| match std::pin::Pin::new(&mut *f).poll(cx) {
        std::task::Poll::Ready(v) => std::task::Poll::Ready(Some(v)),
        std::task::Poll::Pending => std::task::Poll::Ready(None),
    })
    .await
}

// @spec BUS-NAT-TRN-014
#[tokio::test(flavor = "multi_thread")]
async fn trn_014_entries_return_only_envelope_fields_and_trimmed_pending_has_none() {
    let mut fx = fixture_or_skip!("trn014");
    let t = open(&fx);
    // Extra field and a missing field.
    let _: String = q(
        &fx,
        &[
            "XADD",
            &fx.events(),
            "*",
            "type",
            "t",
            "extra",
            "x",
            "data",
            "d",
        ],
    )
    .await;
    let e = t.recent(EventStream::Events, 1).await.unwrap().remove(0);
    assert_eq!(
        (e.r#type.as_deref(), e.data.as_deref()),
        (Some("t"), Some("d"))
    );
    assert_eq!(
        (e.ts, e.source),
        (None, None),
        "missing fields stay undefined; `extra` is not returned"
    );

    // A pending entry whose stream entry was trimmed comes back as an id with no fields.
    assert!(t.create_group("g").await.unwrap());
    let id = t.append(EventStream::Events, fields(1)).await.unwrap();
    let r = t.open_reader();
    let read = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    assert_eq!(read.len(), 1);
    let _: i64 = q(&fx, &["XDEL", &fx.events(), &id]).await;
    let drained = r
        .read_group("g", "c1", "0", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    assert_eq!(drained.len(), 1);
    assert_eq!(drained[0].id, id);
    assert!(drained[0].r#type.is_none() && drained[0].data.is_none());
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ERR-007
#[tokio::test(flavor = "multi_thread")]
async fn err_007_invalid_utf8_envelope_field_returns_entry_without_fields() {
    let mut fx = fixture_or_skip!("err007");
    let t = open(&fx);
    let bad: &[u8] = &[0xff, 0xfe, 0xfd];
    let _: String = redis::cmd("XADD")
        .arg(fx.events())
        .arg("*")
        .arg("type")
        .arg("t")
        .arg("ts")
        .arg("1")
        .arg("source")
        .arg("s")
        .arg("data")
        .arg(bad)
        .query_async(&mut fx.raw)
        .await
        .unwrap();
    let e = t.recent(EventStream::Events, 1).await.unwrap().remove(0);
    assert!(!e.id.is_empty());
    assert!(e.r#type.is_none() && e.ts.is_none() && e.source.is_none() && e.data.is_none());
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-001
#[tokio::test(flavor = "multi_thread")]
async fn ack_001_ack_is_queued_and_sent_with_the_next_read_group() {
    let mut fx = fixture_or_skip!("ack001");
    let t = open(&fx);
    assert!(t.create_group("g").await.unwrap());
    for n in 0..3 {
        t.append(EventStream::Events, fields(n)).await.unwrap();
    }
    let r = t.open_reader();
    let entries = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(pending(&fx, "g").await, 3);
    for e in &entries {
        r.ack("g", &e.id); // synchronous; only queues
    }
    assert_eq!(pending(&fx, "g").await, 3, "ack() sends nothing by itself");
    let read = r.read_group("g", "c1", ">", 10, 50).await.unwrap();
    assert!(read.ack_errors.is_empty());
    assert_eq!(
        pending(&fx, "g").await,
        0,
        "the queued XACKs went with the next XREADGROUP"
    );
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-003
#[tokio::test(flavor = "multi_thread")]
async fn ack_003_refused_ack_is_reported_in_ack_errors() {
    let mut fx = fixture_or_skip!("ack003");
    // XACK is refused (NOPERM) for this ACL user while XREADGROUP and XADD succeed.
    let user = format!("natack{}", &fx.prefix[fx.prefix.len() - 12..]);
    let _: String = q(
        &fx,
        &[
            "ACL", "SETUSER", &user, "on", "nopass", "~*", "+@all", "-xack",
        ],
    )
    .await;
    let t = Transport::new(
        &common::redis_url_as(&user),
        TransportOptions {
            prefix: fx.prefix.clone(),
            fail_fast: false,
        },
    );
    assert!(t.create_group("g").await.unwrap());
    let id = t.append(EventStream::Events, fields(1)).await.unwrap();
    let r = t.open_reader();
    let entries = r
        .read_group("g", "c1", ">", 10, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    assert_eq!(entries[0].id, id);
    r.ack("g", &id);
    let read = r.read_group("g", "c1", ">", 10, 50).await.unwrap();
    assert_eq!(read.ack_errors.len(), 1);
    assert_eq!(read.ack_errors[0].ids, [id]);
    assert_eq!(read.ack_errors[0].err.code, ErrorCode::Redis);
    assert_eq!(pending(&fx, "g").await, 1, "the entry stays pending");
    t.close().await;
    let _: i64 = q(&fx, &["ACL", "DELUSER", &user]).await;
    fx.cleanup().await;
}

// @spec BUS-NAT-ACK-005
#[tokio::test(flavor = "multi_thread")]
async fn ack_005_close_flushes_queued_acks_of_every_reader() {
    let mut fx = fixture_or_skip!("ack005");
    let t = open(&fx);
    assert!(t.create_group("g").await.unwrap());
    for n in 0..4 {
        t.append(EventStream::Events, fields(n)).await.unwrap();
    }
    let (r1, r2) = (t.open_reader(), t.open_reader());
    let a = r1
        .read_group("g", "c1", ">", 2, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    let b = r2
        .read_group("g", "c2", ">", 2, 200)
        .await
        .unwrap()
        .entries
        .unwrap();
    for e in &a {
        r1.ack("g", &e.id);
    }
    for e in &b {
        r2.ack("g", &e.id);
    }
    assert_eq!(pending(&fx, "g").await, 4);
    t.close().await;
    assert_eq!(
        pending(&fx, "g").await,
        0,
        "close() sent both readers' queues"
    );
    fx.cleanup().await;
}

// @spec BUS-NAT-ERR-005
#[tokio::test(flavor = "multi_thread")]
async fn err_005_every_method_rejects_closed_after_close() {
    let mut fx = fixture_or_skip!("err005");
    let t = open(&fx);
    let r = t.open_reader();
    t.close().await;
    let closed = |e: cohost_bus::BusError| assert_eq!(e.code, ErrorCode::Closed, "{e}");
    closed(t.append(EventStream::Events, fields(1)).await.unwrap_err());
    closed(t.append(EventStream::Health, fields(1)).await.unwrap_err());
    closed(t.recent(EventStream::Events, 1).await.unwrap_err());
    closed(t.create_group("g").await.unwrap_err());
    closed(t.move_group_to_latest("g").await.unwrap_err());
    closed(t.put_upload("u", &[0], 1000).await.unwrap_err());
    closed(t.take_upload("u").await.unwrap_err());
    closed(t.write_registration("c", "{}", 1000).await.unwrap_err());
    closed(t.read_registration("c").await.unwrap_err());
    closed(t.delete_registration("c").await.unwrap_err());
    closed(t.list_registrations().await.unwrap_err());
    closed(
        t.append_frame(Direction::In, "mic", &frame(0.0, vec![]))
            .await
            .unwrap_err(),
    );
    closed(t.server_time().await.unwrap_err());
    closed(r.read_group("g", "c", ">", 1, 10).await.unwrap_err());
    closed(r.read(EventStream::Events, "0", 1, 10).await.unwrap_err());
    closed(
        r.read_frames(Direction::In, "mic", "0", 1, 10)
            .await
            .unwrap_err(),
    );
    fx.cleanup().await;
}

// @spec BUS-NAT-ERR-008
#[tokio::test(flavor = "multi_thread")]
async fn err_008_repeated_close_resolves() {
    let mut fx = fixture_or_skip!("err008");
    let t = open(&fx);
    t.server_time().await.unwrap();
    let (a, b) = tokio::join!(t.close(), t.close());
    let _ = (a, b);
    assert!(
        common::within(3000, t.close()).await.is_some(),
        "a later close() resolves"
    );
    fx.cleanup().await;
}

// @spec BUS-NAT-FRM-001, BUS-NAT-FRM-002
#[tokio::test(flavor = "multi_thread")]
async fn frm_001_002_invalid_frame_rejects_bus_invalid_and_writes_nothing() {
    let mut fx = fixture_or_skip!("frm001");
    let t = open(&fx);
    let key = format!("{}:audio.in.mic", fx.prefix);
    let too_big = t
        .append_frame(Direction::In, "mic", &frame(0.0, vec![0; 65536 + 2]))
        .await
        .unwrap_err();
    assert_eq!(too_big.code, ErrorCode::Invalid);
    let odd = t
        .append_frame(Direction::In, "mic", &frame(1.0, vec![0; 3]))
        .await
        .unwrap_err();
    assert_eq!(odd.code, ErrorCode::Invalid);
    let exists: i64 = q(&fx, &["EXISTS", &key]).await;
    assert_eq!(exists, 0, "nothing written");
    // Exactly MAX_FRAME_BYTES is accepted.
    t.append_frame(Direction::In, "mic", &frame(2.0, vec![0; 65536]))
        .await
        .unwrap();
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-FRM-003
#[tokio::test(flavor = "multi_thread")]
async fn frm_003_append_frame_caps_the_stream_and_refreshes_expiry() {
    let mut fx = fixture_or_skip!("frm003");
    let t = open(&fx);
    let key = format!("{}:audio.out.spk", fx.prefix);
    t.append_frame(Direction::Out, "spk", &frame(0.0, vec![0, 0]))
        .await
        .unwrap();
    let pttl: i64 = q(&fx, &["PTTL", &key]).await;
    assert!(pttl > 50_000 && pttl <= 60_000, "PEXPIRE 60000, got {pttl}");
    for n in 1..2500 {
        t.append_frame(Direction::Out, "spk", &frame(n as f64, vec![0, 0]))
            .await
            .unwrap();
    }
    let len = xlen(&fx, &key).await;
    assert!(
        (1500..=1700).contains(&len),
        "MAXLEN ~ 1500 for audio.out, got {len}"
    );
    t.close().await;
    fx.cleanup().await;
}

// @spec BUS-NAT-FRM-004
#[tokio::test(flavor = "multi_thread")]
async fn frm_004_read_frames_returns_rejections_instead_of_failing() {
    let mut fx = fixture_or_skip!("frm004");
    let t = open(&fx);
    let key = format!("{}:audio.in.mic", fx.prefix);
    let pcm_ok: &[u8] = &[1, 2, 3, 4];
    let odd: &[u8] = &[1, 2, 3];
    for (v, pcm) in [("1", pcm_ok), ("2", pcm_ok), ("1", odd)] {
        let _: String = redis::cmd("XADD")
            .arg(&key)
            .arg("*")
            .arg("v")
            .arg(v)
            .arg("epoch")
            .arg("1")
            .arg("seq")
            .arg("0")
            .arg("rate")
            .arg("16000")
            .arg("ch")
            .arg("1")
            .arg("pcm")
            .arg(pcm)
            .query_async(&mut fx.raw)
            .await
            .unwrap();
    }
    let r = t.open_reader();
    let got = frame_entries(&r, Direction::In, "mic").await;
    assert_eq!(got.len(), 3);
    assert!(matches!(&got[0].decoded, DecodedFrame::Ok(f) if f.pcm == pcm_ok));
    assert_eq!(got[1].decoded, DecodedFrame::Rejected("version".into()));
    assert_eq!(
        got[2].decoded,
        DecodedFrame::Rejected("odd byte count".into())
    );
    // A read that times out with nothing new is `None`, not an error.
    let last = got[2].id.clone();
    assert!(
        r.read_frames(Direction::In, "mic", &last, 10, 50)
            .await
            .unwrap()
            .is_none()
    );
    t.close().await;
    fx.cleanup().await;
}
