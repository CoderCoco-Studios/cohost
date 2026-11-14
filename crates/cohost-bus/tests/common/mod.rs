//! Shared helpers for the integration tests: a Redis fixture with a unique prefix per test, a skip guard that
//! mirrors packages/bus/test/bus.test.ts, and a controllable TCP proxy for connection-failure scenarios.
#![allow(dead_code)]

use redis::AsyncCommands;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

pub fn redis_url() -> String {
    std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string())
}

/// `host:port` of `REDIS_URL`.
pub fn redis_addr() -> String {
    let url = redis_url();
    let rest = url.split("://").nth(1).unwrap_or(&url);
    let rest = rest.rsplit('@').next().unwrap_or(rest);
    rest.split('/').next().unwrap_or(rest).to_string()
}

/// `redis://<user>:@host:port` for ACL tests.
pub fn redis_url_as(user: &str) -> String {
    format!("redis://{user}:@{}", redis_addr())
}

pub struct Fixture {
    pub prefix: String,
    pub url: String,
    pub raw: redis::aio::MultiplexedConnection,
}

impl Fixture {
    /// `None` (after printing why) when Redis is unreachable, so the test skips instead of failing.
    pub async fn connect(name: &str) -> Option<Fixture> {
        let url = redis_url();
        let raw = match redis::Client::open(url.as_str()) {
            Ok(c) => match tokio::time::timeout(
                Duration::from_secs(2),
                c.get_multiplexed_async_connection(),
            )
            .await
            {
                Ok(Ok(conn)) => conn,
                _ => {
                    eprintln!("SKIP {name}: Redis unreachable at {url} (set REDIS_URL)");
                    return None;
                }
            },
            Err(_) => {
                eprintln!("SKIP {name}: bad REDIS_URL {url}");
                return None;
            }
        };
        // BUS-NAT-CI-002: a prefix of its own, never `cohost`.
        let prefix = format!("natbus-{name}-{}", uuid::Uuid::new_v4().simple());
        Some(Fixture { prefix, url, raw })
    }

    pub fn events(&self) -> String {
        format!("{}:events", self.prefix)
    }
    pub fn health(&self) -> String {
        format!("{}:health", self.prefix)
    }

    pub async fn cleanup(&mut self) {
        let keys: Vec<String> = self
            .raw
            .keys(format!("{}:*", self.prefix))
            .await
            .unwrap_or_default();
        for k in keys {
            let _: redis::RedisResult<i64> = self.raw.del(k).await;
        }
    }
}

/// Returns early from the test with a visible message when Redis is unreachable.
#[macro_export]
macro_rules! fixture_or_skip {
    ($name:expr) => {
        match common::Fixture::connect($name).await {
            Some(f) => f,
            None => return,
        }
    };
}

// ------------------------------------------------------------------ proxy

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Forward normally.
    Pass = 0,
    /// Close new connections at once (a reset).
    Reject = 1,
    /// Accept new connections and never answer them (a hung connect).
    Blackhole = 2,
}

struct State {
    accepted: AtomicUsize,
    mode: AtomicU8,
    /// Delay before forwarding a new connection starts.
    delay_ms: AtomicU64,
    /// Drop everything Redis sends on live connections (an established connection that went silent).
    mute_down: AtomicBool,
    kill: watch::Sender<u64>,
}

/// A TCP forwarder between a bus client and Redis that tests can break on demand.
pub struct Proxy {
    pub addr: SocketAddr,
    state: Arc<State>,
}

impl Proxy {
    pub async fn start() -> Proxy {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind proxy");
        let addr = listener.local_addr().unwrap();
        let (kill, _) = watch::channel(0u64);
        let state = Arc::new(State {
            accepted: AtomicUsize::new(0),
            mode: AtomicU8::new(Mode::Pass as u8),
            delay_ms: AtomicU64::new(0),
            mute_down: AtomicBool::new(false),
            kill,
        });
        let st = state.clone();
        let target = redis_addr();
        tokio::spawn(async move {
            loop {
                let Ok((client, _)) = listener.accept().await else {
                    return;
                };
                st.accepted.fetch_add(1, Ordering::SeqCst);
                let st2 = st.clone();
                let target = target.clone();
                tokio::spawn(async move { serve(client, target, st2).await });
            }
        });
        Proxy { addr, state }
    }

    pub fn url(&self) -> String {
        format!("redis://{}", self.addr)
    }
    pub fn accepted(&self) -> usize {
        self.state.accepted.load(Ordering::SeqCst)
    }
    pub fn set_mode(&self, m: Mode) {
        self.state.mode.store(m as u8, Ordering::SeqCst);
    }
    pub fn set_delay(&self, ms: u64) {
        self.state.delay_ms.store(ms, Ordering::SeqCst);
    }
    pub fn mute_down(&self, on: bool) {
        self.state.mute_down.store(on, Ordering::SeqCst);
    }
    /// Drop every live connection.
    pub fn kill_all(&self) {
        self.state.kill.send_modify(|g| *g += 1);
    }
}

async fn serve(mut client: TcpStream, target: String, st: Arc<State>) {
    let mut kill = st.kill.subscribe();
    match st.mode.load(Ordering::SeqCst) {
        m if m == Mode::Reject as u8 => return,
        m if m == Mode::Blackhole as u8 => {
            let _ = kill.changed().await;
            return;
        }
        _ => {}
    }
    let delay = st.delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let Ok(mut server) = TcpStream::connect(&target).await else {
        return;
    };
    let (mut cr, mut cw) = client.split();
    let (mut sr, mut sw) = server.split();
    let up = async {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match cr.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if sw.write_all(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    let down = async {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match sr.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if st.mute_down.load(Ordering::SeqCst) {
                        continue;
                    }
                    if cw.write_all(&buf[..n]).await.is_err() {
                        return;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
        _ = kill.changed() => {}
    }
}

/// A TCP address nothing listens on (bound then dropped), for "Redis unreachable" scenarios.
pub async fn dead_url() -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    drop(l);
    format!("redis://{a}")
}

/// `true` when `f` finishes within `ms`.
pub async fn within<F: std::future::Future>(ms: u64, f: F) -> Option<F::Output> {
    tokio::time::timeout(Duration::from_millis(ms), f)
        .await
        .ok()
}
