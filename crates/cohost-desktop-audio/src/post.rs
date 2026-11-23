//! The HTTP post of one clip to ears' `POST /audio` listener (EARS-SRC-015, EARS-SRC-020, EARS-SRC-021).
//!
//! The listener is plain HTTP on loopback, so the request is written directly over a TCP stream
//! rather than through an HTTP client crate.

use std::fmt;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The listener the helper posts to unless `--url` names another.
pub const DEFAULT_URL: &str = "http://127.0.0.1:8765/audio?source=desktop";
const TIMEOUT: Duration = Duration::from_secs(30);

/// Why a clip was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostError {
    /// ears answered with a non-2xx status.
    Status(u16),
    /// The connection failed or ended before a response.
    Network(String),
}

impl PostError {
    /// Connection failures and 400, 408, 429 and 5xx are retried; other refusals are dropped.
    // @spec EARS-SRC-020
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Status(s) => matches!(s, 400 | 408 | 429 | 500..=599),
            Self::Network(_) => true,
        }
    }
}

impl fmt::Display for PostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status(s) => write!(f, "HTTP {s}"),
            Self::Network(m) => write!(f, "connection failed: {m}"),
        }
    }
}

impl std::error::Error for PostError {}

/// The bearer token: `--token` when non-empty, otherwise `EARS_HTTP_TOKEN` when non-empty.
// @spec EARS-SRC-021
pub fn resolve_token(flag: Option<String>, env: Option<String>) -> Option<String> {
    flag.filter(|t| !t.is_empty())
        .or_else(|| env.filter(|t| !t.is_empty()))
}

/// Posts one clip as `audio/L16` (little-endian 16-bit mono at 16 kHz) to `url`, with a bearer
/// token when given. Succeeds on a 2xx answer.
// @spec EARS-SRC-015, EARS-SRC-021
pub async fn post_clip(url: &str, token: Option<&str>, clip: &[i16]) -> Result<(), PostError> {
    tokio::time::timeout(TIMEOUT, post_once(url, token, clip))
        .await
        .unwrap_or_else(|_| Err(PostError::Network("timed out".into())))
}

async fn post_once(url: &str, token: Option<&str>, clip: &[i16]) -> Result<(), PostError> {
    let (authority, path) = split_url(url).map_err(PostError::Network)?;
    let addr = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    let body: Vec<u8> = clip.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: audio/L16;rate=16000;channels=1\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(t) = token {
        head += &format!("Authorization: Bearer {t}\r\n");
    }
    head += "\r\n";

    let net = |e: std::io::Error| PostError::Network(e.to_string());
    let mut stream = TcpStream::connect(&addr).await.map_err(net)?;
    let sent = async {
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&body).await
    }
    .await;
    // ears may answer and close before the body is read; its status still decides.
    match (read_status(&mut stream).await, sent) {
        (Ok(code), _) if (200..300).contains(&code) => Ok(()),
        (Ok(code), _) => Err(PostError::Status(code)),
        (Err(_), Err(e)) => Err(net(e)),
        (Err(e), Ok(())) => Err(e),
    }
}

/// Splits `http://host[:port][/path][?query]` into the authority and the request target.
fn split_url(url: &str) -> Result<(&str, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("unsupported URL {url}: only http:// is supported"))?;
    let cut = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(cut);
    if authority.is_empty() {
        return Err(format!("URL {url} has no host"));
    }
    let path = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    Ok((authority, path))
}

/// Reads the status line and returns its code; the rest of the response is not needed.
async fn read_status(stream: &mut TcpStream) -> Result<u16, PostError> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|e| PostError::Network(e.to_string()))?;
        if n == 0 {
            return Err(PostError::Network(
                "connection closed before a response".into(),
            ));
        }
        line.push(byte[0]);
        if line.len() > 1024 {
            return Err(PostError::Network("status line too long".into()));
        }
    }
    let text = String::from_utf8_lossy(&line);
    let mut parts = text.split_whitespace();
    match (
        parts.next(),
        parts.next().and_then(|c| c.parse::<u16>().ok()),
    ) {
        (Some(proto), Some(code)) if proto.starts_with("HTTP/") => Ok(code),
        _ => Err(PostError::Network(format!(
            "malformed status line {}",
            text.trim_end()
        ))),
    }
}
