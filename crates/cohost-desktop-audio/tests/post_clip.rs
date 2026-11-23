//! The HTTP post against a local listener standing in for ears' `POST /audio`.
use cohost_desktop_audio::post::{DEFAULT_URL, post_clip, resolve_token};
use cohost_desktop_audio::retry::Backoff;
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
        let reply = format!("HTTP/1.1 {status} X\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
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
    let ct = head.lines().find_map(|l| l.strip_prefix("content-type:")).unwrap().replace(' ', "");
    assert_eq!(ct, "audio/l16;rate=16000;channels=1");
    assert_eq!(body, [1, 0, 0xfe, 0xff, 0x2c, 0x01]);
    assert!(!head.contains("authorization:"));
}

// @spec EARS-SRC-015
#[tokio::test]
async fn sends_the_bearer_token_when_one_is_given() {
    let (url, srv) = serve_once(200).await;
    post_clip(&url, Some("s3cret"), &[0, 0]).await.unwrap();
    let (head, _) = srv.await.unwrap();
    assert!(head.contains("authorization: bearer s3cret"), "{head}");
}

// @spec EARS-SRC-015
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

// @spec EARS-SRC-015
#[test]
fn the_token_comes_from_the_flag_or_the_environment_and_is_absent_when_neither_is_set() {
    assert_eq!(resolve_token(Some("a".into()), None).as_deref(), Some("a"));
    assert_eq!(resolve_token(None, Some("b".into())).as_deref(), Some("b"));
    assert_eq!(resolve_token(None, None), None);
}

// @spec EARS-SRC-015
#[test]
fn retry_delay_increases_across_consecutive_failures() {
    let mut b = Backoff::new();
    let d: Vec<_> = (0..3).map(|_| b.next_delay()).collect();
    assert!(d[0] < d[1] && d[1] < d[2], "{d:?}");
}
