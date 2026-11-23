//! The HTTP post of one clip to ears' `POST /audio` listener (EARS-SRC-015, EARS-SRC-020, EARS-SRC-021).
//!
//! The listener is plain HTTP, so the request is written directly over a TCP stream rather than
//! through an HTTP client crate.

use std::fmt;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The listener the helper posts to unless `--url` names another.
pub const DEFAULT_URL: &str = "http://127.0.0.1:8765/audio?source=desktop";

/// How long each stage of a post may take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PostTimeouts {
    pub connect: Duration,
    /// Writing the request head and body.
    pub send: Duration,
    /// Waiting for ears' status line. ears answers only after transcription, so this is long, and a
    /// clip whose answer times out is dropped, not retried: the clip may already be in the bus, and
    /// a retry would publish its speech twice.
    pub response: Duration,
}

impl Default for PostTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(5),
            send: Duration::from_secs(10),
            response: Duration::from_secs(120),
        }
    }
}

/// Why a clip was not accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostError {
    /// ears answered with a non-2xx status.
    Status(u16),
    /// The connection failed, or ended before the clip was fully sent.
    Network(String),
    /// The clip was sent in full but ears gave no answer in time. ears may already have accepted it.
    NoResponse,
    /// The URL is not a usable `http://` target. Retrying cannot fix it.
    InvalidUrl(String),
}

impl PostError {
    /// Connection and send failures and 400, 408, 429 and 5xx are retried. A missing response, an
    /// invalid URL and other refusals are dropped.
    // @spec EARS-SRC-020
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Status(s) => matches!(s, 400 | 408 | 429 | 500..=599),
            Self::Network(_) => true,
            Self::NoResponse | Self::InvalidUrl(_) => false,
        }
    }
}

impl fmt::Display for PostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Status(s) => write!(f, "HTTP {s}"),
            Self::Network(m) => write!(f, "connection failed: {m}"),
            Self::NoResponse => write!(f, "ears did not answer the clip in time"),
            Self::InvalidUrl(m) => write!(f, "invalid URL: {m}"),
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

/// A parsed `http://` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTarget {
    /// `host:port` for connecting; IPv6 literals keep their brackets.
    pub connect_addr: String,
    /// The `Host` header value: the authority as written.
    pub host_header: String,
    /// The host without brackets.
    pub host: String,
    /// The request target: path and query, at least `/`.
    pub path: String,
}

impl HttpTarget {
    pub fn is_loopback(&self) -> bool {
        self.host == "localhost" || self.host == "::1" || self.host.starts_with("127.")
    }
}

/// Parses `http://host[:port][/path][?query]`. The port defaults to 80. A userinfo part, a missing
/// host, a port outside 1 to 65535 and any other scheme are errors.
// @spec EARS-SRC-015
pub fn parse_http_target(url: &str) -> Result<HttpTarget, String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("{url} must start with http://"))?;
    let cut = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(cut);
    if authority.contains('@') {
        return Err(format!("{url} must not carry user information"));
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after) = bracketed
            .split_once(']')
            .ok_or_else(|| format!("{url} has an unclosed IPv6 literal"))?;
        let port = match after {
            "" => None,
            p => Some(
                p.strip_prefix(':')
                    .ok_or_else(|| format!("{url} has a malformed port"))?,
            ),
        };
        (host, port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return Err(format!("{url} has no host"));
    }
    let port = match port {
        None => 80,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => n,
            _ => return Err(format!("{url} has an invalid port {p:?}")),
        },
    };
    let path = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('/') {
        tail.to_string()
    } else {
        format!("/{tail}")
    };
    let connect_addr = if authority.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    Ok(HttpTarget {
        connect_addr,
        host_header: authority.to_string(),
        host: host.to_string(),
        path,
    })
}

/// Posts one clip as `audio/L16` (little-endian 16-bit mono at 16 kHz) to `url`, with a bearer
/// token when given. Succeeds on a 2xx answer.
// @spec EARS-SRC-015, EARS-SRC-020, EARS-SRC-021
pub async fn post_clip(url: &str, token: Option<&str>, clip: &[i16]) -> Result<(), PostError> {
    post_clip_timed(url, token, clip, &PostTimeouts::default()).await
}

/// [`post_clip`] with explicit stage timeouts.
pub async fn post_clip_timed(
    url: &str,
    token: Option<&str>,
    clip: &[i16],
    timeouts: &PostTimeouts,
) -> Result<(), PostError> {
    let target = parse_http_target(url).map_err(PostError::InvalidUrl)?;
    let body: Vec<u8> = clip.iter().flat_map(|s| s.to_le_bytes()).collect();
    let mut head = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: audio/L16;rate=16000;channels=1\r\nContent-Length: {}\r\nConnection: close\r\n",
        target.path,
        target.host_header,
        body.len()
    );
    if let Some(t) = token {
        head += &format!("Authorization: Bearer {t}\r\n");
    }
    head += "\r\n";

    let mut stream =
        tokio::time::timeout(timeouts.connect, TcpStream::connect(&target.connect_addr))
            .await
            .map_err(|_| PostError::Network("connect timed out".into()))?
            .map_err(|e| PostError::Network(e.to_string()))?;

    let sent = tokio::time::timeout(timeouts.send, async {
        stream.write_all(head.as_bytes()).await?;
        stream.write_all(&body).await
    })
    .await;
    match sent {
        Err(_) => return Err(PostError::Network("send timed out".into())),
        Ok(Ok(())) => {}
        // ears may answer and close before the body is read; its status still decides.
        Ok(Err(e)) => {
            return match tokio::time::timeout(timeouts.connect, read_status(&mut stream)).await {
                Ok(Ok(code)) => status_result(code),
                _ => Err(PostError::Network(e.to_string())),
            };
        }
    }

    match tokio::time::timeout(timeouts.response, read_status(&mut stream)).await {
        Err(_) => Err(PostError::NoResponse),
        Ok(Ok(code)) => status_result(code),
        Ok(Err(e)) => Err(e),
    }
}

fn status_result(code: u16) -> Result<(), PostError> {
    if (200..300).contains(&code) {
        Ok(())
    } else {
        Err(PostError::Status(code))
    }
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
