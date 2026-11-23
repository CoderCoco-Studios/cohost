//! The HTTP post against a local listener standing in for ears' `POST /audio`.
use cohost_desktop_audio::post::{DEFAULT_URL, PostError, post_clip, resolve_token};
use cohost_desktop_audio::retry::{Backoff, ClipQueue, Disposition, FailureLog, disposition};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serves one request with `status` and returns its raw head (lowercased) and body.
async fn serve_once(status: u16) -> (String, tokio::task::JoinHandle<(String, Vec<u8>)>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/audio?source=desktop", l.local_addr().unwrap());
    let h = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut buf = Vec::new();
        let (head, body) = loop {
            let mut chunk = [0u8; 4096];
            let n = s.read(&mut chunk).await.unwrap();
            buf.extend_from_slice(&chunk[..n]);
            if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
                let want: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map(|v| v.trim().parse().unwrap())
                    .unwrap_or(0);
                if buf.len() >= p + 4 + want {
                    break (head, buf[p + 4..p + 4 + want].to_vec());
                }
            }
            assert!(n > 0, "connection closed early");
        };
        let reply =
            format!("HTTP/1.1 {status} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
        s.write_all(reply.as_bytes()).await.unwrap();
        (head, body)
    });
    (url, h)
}

// @spec EARS-SRC-015
#[tokio::test]
async fn posts_s16le_audio_l16_with_rate_and_channels_to_the_url() {
    let (url, srv) = serve_once(200).await;
    post_clip(&url, None, &[1, -2, 300]).await.unwrap();
    let (head, body) = srv.await.unwrap();
    assert!(head.starts_with("post /audio?source=desktop "), "{head}");
    let ct = head
        .lines()
        .find_map(|l| l.strip_prefix("content-type:"))
        .unwrap()
        .replace(' ', "");
    assert_eq!(ct, "audio/l16;rate=16000;channels=1");
    assert_eq!(body, [1, 0, 0xfe, 0xff, 0x2c, 0x01]);
    assert!(!head.contains("authorization:"));
}

// @spec EARS-SRC-021
#[tokio::test]
async fn sends_the_bearer_token_when_one_is_given() {
    let (url, srv) = serve_once(200).await;
    post_clip(&url, Some("s3cret"), &[0, 0]).await.unwrap();
    let (head, _) = srv.await.unwrap();
    assert!(head.contains("authorization: bearer s3cret"), "{head}");
}

// @spec EARS-SRC-020
#[tokio::test]
async fn a_refusal_or_an_unreachable_listener_is_an_error() {
    let (url, srv) = serve_once(401).await;
    assert!(post_clip(&url, None, &[0, 0]).await.is_err());
    srv.await.unwrap();
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/audio", dead.local_addr().unwrap());
    drop(dead);
    assert!(post_clip(&url, None, &[0, 0]).await.is_err());
}

// @spec EARS-SRC-015
#[test]
fn the_default_url_is_ears_loopback_listener_tagged_desktop() {
    assert_eq!(DEFAULT_URL, "http://127.0.0.1:8765/audio?source=desktop");
}

// @spec EARS-SRC-021
#[test]
fn the_flag_wins_over_the_environment_and_an_empty_value_counts_as_unset() {
    assert_eq!(
        resolve_token(Some("a".into()), Some("b".into())).as_deref(),
        Some("a")
    );
    assert_eq!(resolve_token(None, Some("b".into())).as_deref(), Some("b"));
    assert_eq!(
        resolve_token(Some(String::new()), Some("b".into())).as_deref(),
        Some("b")
    );
    assert_eq!(
        resolve_token(Some("a".into()), Some(String::new())).as_deref(),
        Some("a")
    );
    assert_eq!(
        resolve_token(Some(String::new()), Some(String::new())),
        None
    );
    assert_eq!(resolve_token(None, None), None);
}

// @spec EARS-SRC-020
#[tokio::test]
async fn connection_failures_and_400_408_429_5xx_are_retried_other_refusals_are_dropped() {
    for (status, retry) in [
        (400, true),
        (408, true),
        (429, true),
        (500, true),
        (503, true),
        (401, false),
        (404, false),
        (413, false),
        (415, false),
    ] {
        let (url, srv) = serve_once(status).await;
        let err = post_clip(&url, None, &[0, 0]).await.unwrap_err();
        srv.await.unwrap();
        assert_eq!(err.is_retryable(), retry, "status {status}");
    }
    let dead = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/audio", dead.local_addr().unwrap());
    drop(dead);
    assert!(
        post_clip(&url, None, &[0, 0])
            .await
            .unwrap_err()
            .is_retryable()
    );
}

// @spec EARS-SRC-020
#[test]
fn retry_delay_starts_at_500_ms_doubles_stops_at_30_s_and_resets_after_a_delivery() {
    let mut b = Backoff::new();
    let ms: Vec<u128> = (0..9).map(|_| b.next_delay().as_millis()).collect();
    assert_eq!(
        ms,
        [
            500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
        ]
    );
    b.reset();
    assert_eq!(b.next_delay(), Duration::from_millis(500));
}

// @spec EARS-SRC-020
#[test]
fn at_most_four_clips_wait_in_order_and_a_fifth_drops_the_oldest() {
    let mut q = ClipQueue::new();
    for n in 1..=4 {
        assert_eq!(q.push(vec![n]), None);
    }
    assert_eq!(q.push(vec![5]), Some(vec![1]));
    let order: Vec<_> = std::iter::from_fn(|| q.pop()).collect();
    assert_eq!(order, [vec![2], vec![3], vec![4], vec![5]]);
}

// @spec EARS-SRC-020
#[test]
fn a_failure_is_logged_when_first_seen_and_when_it_changes_not_while_it_repeats() {
    let mut log = FailureLog::new();
    assert!(
        log.observe(&PostError::Status(400))
            .unwrap()
            .contains("400")
    );
    assert_eq!(log.observe(&PostError::Status(400)), None);
    assert!(
        log.observe(&PostError::Status(503))
            .unwrap()
            .contains("503")
    );
    assert!(
        log.observe(&PostError::Network("refused".into()))
            .unwrap()
            .contains("refused")
    );
    log.clear();
    assert!(log.observe(&PostError::Network("refused".into())).is_some());
}

// @spec EARS-SRC-020
#[test]
fn a_dropped_refusal_carries_a_log_line_with_its_status() {
    match disposition(&PostError::Status(401)) {
        Disposition::Drop(line) => assert!(line.contains("401"), "{line}"),
        Disposition::Retry => panic!("401 must be dropped"),
    }
    assert!(matches!(
        disposition(&PostError::Status(400)),
        Disposition::Retry
    ));
    assert!(matches!(
        disposition(&PostError::Network("x".into())),
        Disposition::Retry
    ));
}

use cohost_desktop_audio::post::{PostTimeouts, parse_http_target, post_clip_timed};

// @spec EARS-SRC-020
#[tokio::test]
async fn a_response_that_never_comes_is_not_retried() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/audio", l.local_addr().unwrap());
    let h = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        while !seen.windows(4).any(|w| w == b"\r\n\r\n")
            || seen.len() < seen.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 6
        {
            let n = s.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            seen.extend_from_slice(&chunk[..n]);
        }
        tokio::time::sleep(Duration::from_secs(30)).await;
    });
    let t = PostTimeouts {
        connect: Duration::from_secs(2),
        send: Duration::from_secs(2),
        response: Duration::from_millis(200),
    };
    let err = post_clip_timed(&url, None, &[1], &t).await.unwrap_err();
    assert_eq!(err, PostError::NoResponse);
    assert!(!err.is_retryable());
    h.abort();
}

// @spec EARS-SRC-015
#[test]
fn http_targets_default_to_port_80_and_accept_bracketed_ipv6() {
    let t = parse_http_target("http://[::1]/audio?source=desktop").unwrap();
    assert_eq!(t.connect_addr, "[::1]:80");
    assert_eq!(t.path, "/audio?source=desktop");
    assert!(t.is_loopback());
    assert_eq!(
        parse_http_target("http://localhost:8765")
            .unwrap()
            .connect_addr,
        "localhost:8765"
    );
    assert!(
        !parse_http_target("http://192.168.1.5/x")
            .unwrap()
            .is_loopback()
    );
}

// @spec EARS-SRC-015
#[tokio::test]
async fn an_invalid_url_is_not_retryable() {
    let err = post_clip("https://h/x", None, &[1]).await.unwrap_err();
    assert!(matches!(err, PostError::InvalidUrl(_)));
    assert!(!err.is_retryable());
}

// @spec EARS-SRC-020
#[test]
fn the_default_timeouts_are_5_s_to_connect_10_s_to_send_and_120_s_for_a_response() {
    let t = PostTimeouts::default();
    assert_eq!(
        (t.connect.as_secs(), t.send.as_secs(), t.response.as_secs()),
        (5, 10, 120)
    );
}

// @spec EARS-SRC-020
#[tokio::test]
async fn a_connection_closed_before_the_status_line_after_a_complete_send_is_retried() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/audio", l.local_addr().unwrap());
    let h = tokio::spawn(async move {
        let (mut s, _) = l.accept().await.unwrap();
        let mut seen = Vec::new();
        let mut chunk = [0u8; 4096];
        // 2 body bytes follow the head for a one-sample clip.
        while !seen.windows(4).any(|w| w == b"\r\n\r\n")
            || seen.len() < seen.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 6
        {
            let n = s.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            seen.extend_from_slice(&chunk[..n]);
        }
        drop(s);
    });
    let err = post_clip(&url, None, &[1]).await.unwrap_err();
    h.await.unwrap();
    assert!(err.is_retryable(), "{err}");
}
