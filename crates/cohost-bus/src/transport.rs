//! The native `BusTransport` (event-bus LLD, "The `BusTransport` interface"). One shared multiplexed connection plus
//! one dedicated connection per `Reader`. No retries of its own on commands or reads (BUS-NAT-TRN-003).
use crate::consts::{
    AUDIO_STREAM_TTL_MS, CLOSE_FLUSH_TIMEOUT_MS, CONNECT_TIMEOUT_MS, EVENTS_MAXLEN, HEALTH_MAXLEN,
    MAX_FRAME_BYTES, RECONNECT_BASE_MS, RECONNECT_CAP_MS,
};
use crate::error::{BusError, ErrorCode, Result};
use crate::frame::{DecodedFrame, Direction, Frame, decode_frame, encode_frame};
use crate::keys::Keys;
use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Cmd, Pipeline, Value};
use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::task::Poll;
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio::time::{Instant, sleep, timeout};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventStream {
    Events,
    Health,
}

/// The four envelope fields as stored (BUS-STREAM-001).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryFields {
    pub r#type: String,
    pub ts: String,
    pub source: String,
    pub data: String,
}

/// One entry as read: only the envelope fields; none for a trimmed pending entry or invalid UTF-8 (BUS-NAT-TRN-014,
/// BUS-NAT-ERR-007).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawEntry {
    pub id: String,
    pub r#type: Option<String>,
    pub ts: Option<String>,
    pub source: Option<String>,
    pub data: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AckError {
    pub ids: Vec<String>,
    pub err: BusError,
}

/// `entries` is `None` when the block timed out with nothing to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupRead {
    pub entries: Option<Vec<RawEntry>>,
    pub ack_errors: Vec<AckError>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FrameEntry {
    pub id: String,
    pub decoded: DecodedFrame,
}

#[derive(Debug, Clone)]
pub struct TransportOptions {
    pub prefix: String,
    pub fail_fast: bool,
}

// ------------------------------------------------------------------ connection state

/// State of the shared connection. `Booting` lasts until the first connect attempt settles (BUS-NAT-CONN-006).
#[derive(Clone)]
enum ConnState {
    Booting,
    Up(MultiplexedConnection, u64),
    Down(BusError),
    Closed,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// One connect attempt: TCP, then a `PING`, abandoned after 10 s (BUS-NAT-CONN-007). Every failure is
/// `BUS_CONNECTION` naming the cause (BUS-NAT-ERR-009).
async fn connect(client: &redis::Client) -> Result<MultiplexedConnection> {
    let cfg = AsyncConnectionConfig::new()
        .set_connection_timeout(None)
        .set_response_timeout(None);
    let attempt = async {
        let mut c = client
            .get_multiplexed_async_connection_with_config(&cfg)
            .await?;
        redis::cmd("PING").query_async::<Value>(&mut c).await?;
        Ok::<_, redis::RedisError>(c)
    };
    match timeout(Duration::from_millis(CONNECT_TIMEOUT_MS), attempt).await {
        Ok(Ok(c)) => Ok(c),
        Ok(Err(e)) => Err(BusError::connection(match e.kind() {
            redis::ErrorKind::Server(_)
            | redis::ErrorKind::Extension
            | redis::ErrorKind::AuthenticationFailed => crate::error::redis_text(&e),
            _ => e.to_string(),
        })),
        Err(_) => Err(BusError::connection("connect timeout")),
    }
}

/// Opens the client for `url`. A URL that names a user but no password (`redis://user:@host`) authenticates that ACL
/// user with the empty password, as ioredis does, instead of skipping `AUTH`.
fn open_client(url: &str) -> redis::RedisResult<redis::Client> {
    use redis::IntoConnectionInfo;
    let mut info = url.into_connection_info()?;
    let settings = info.redis_settings().clone();
    if settings.username().is_some() && settings.password().is_none() {
        info = info.set_redis_settings(settings.set_password(""));
    }
    redis::Client::open(info)
}

struct Inner {
    client: std::result::Result<redis::Client, BusError>,
    keys: Keys,
    fail_fast: bool,
    state: watch::Sender<ConnState>,
    gate: AsyncMutex<()>,
    generation: AtomicU64,
    readers: Mutex<Vec<Weak<ReaderShared>>>,
    /// Held for the whole of `close()`; a second `close()` waits on it (BUS-NAT-ERR-008).
    close_lock: AsyncMutex<bool>,
}

fn is_closed_state(s: &ConnState) -> bool {
    matches!(s, ConnState::Closed)
}

impl Inner {
    /// The shared connection, waiting for the first attempt while booting and never for a later one.
    async fn conn(&self) -> Result<(MultiplexedConnection, u64)> {
        match &*self.state.borrow() {
            ConnState::Up(c, g) => return Ok((c.clone(), *g)),
            ConnState::Down(e) => return Err(e.clone()),
            ConnState::Closed => return Err(BusError::closed()),
            ConnState::Booting => {}
        }
        let mut rx = self.state.subscribe();
        loop {
            let s = rx.borrow_and_update().clone();
            match s {
                ConnState::Up(c, g) => return Ok((c, g)),
                ConnState::Down(e) => return Err(e),
                ConnState::Closed => return Err(BusError::closed()),
                ConnState::Booting => {
                    if rx.changed().await.is_err() {
                        return Err(BusError::closed());
                    }
                }
            }
        }
    }

    /// Records a failed shared connection and starts the background reconnect (never with `failFast`).
    fn mark_down(self: &Arc<Self>, generation: u64, err: &BusError) {
        let mut changed = false;
        self.state.send_if_modified(|s| {
            if matches!(s, ConnState::Up(_, g) if *g == generation) {
                *s = ConnState::Down(err.clone());
                changed = true;
            }
            changed
        });
        if changed && !self.fail_fast {
            tokio::spawn(connect_loop(self.clone()));
        }
    }

    /// Maps a client error from a shared-connection command, taking the connection down when it failed.
    fn fail(self: &Arc<Self>, generation: u64, e: &redis::RedisError) -> BusError {
        if is_closed_state(&self.state.borrow()) {
            return BusError::closed();
        }
        let be = BusError::from_redis(e);
        if be.is_connection() {
            self.mark_down(generation, &be);
        }
        be
    }

    /// Hands `fut` to the shared connection in call order (BUS-NAT-TRN-008): callers pass the `gate` (a fair FIFO
    /// lock, taken in call order) while they wait for the boot phase and while their command is first polled, which
    /// is what enqueues it on the multiplexed connection; they release it before awaiting the reply.
    async fn issue<T>(
        self: &Arc<Self>,
        make: impl FnOnce(
            MultiplexedConnection,
        )
            -> std::pin::Pin<Box<dyn Future<Output = redis::RedisResult<T>> + Send>>,
    ) -> Result<T> {
        let permit = self.gate.lock().await;
        let (c, g) = self.conn().await?;
        let mut fut = make(c);
        let first = std::future::poll_fn(|cx| match fut.as_mut().poll(cx) {
            Poll::Ready(v) => Poll::Ready(Some(v)),
            Poll::Pending => Poll::Ready(None),
        })
        .await;
        drop(permit);
        let r = match first {
            Some(v) => v,
            None => fut.await,
        };
        r.map_err(|e| self.fail(g, &e))
    }

    async fn cmd(self: &Arc<Self>, cmd: Cmd) -> Result<Value> {
        self.issue(move |mut c| Box::pin(async move { cmd.query_async::<Value>(&mut c).await }))
            .await
    }

    /// Runs a pipeline; a refused command comes back as a `Value::ServerError` in its slot.
    async fn pipe(self: &Arc<Self>, mut p: Pipeline) -> Result<Vec<Value>> {
        p.ignore_errors();
        self.issue(move |mut c| Box::pin(async move { p.query_async::<Vec<Value>>(&mut c).await }))
            .await
    }
}

/// Connects (and reconnects) the shared connection in the background (BUS-NAT-CONN-004, BUS-NAT-CONN-007).
async fn connect_loop(inner: Arc<Inner>) {
    let client = match &inner.client {
        Ok(c) => c.clone(),
        Err(e) => {
            let e = e.clone();
            inner.state.send_if_modified(|s| {
                let open = !is_closed_state(s);
                if open {
                    *s = ConnState::Down(e);
                }
                open
            });
            return;
        }
    };
    let mut closed = inner.state.subscribe();
    let wait_closed = |rx: &mut watch::Receiver<ConnState>| {
        let mut rx = rx.clone();
        async move {
            let _ = rx.wait_for(is_closed_state).await;
        }
    };
    let mut failures: u32 = 0;
    loop {
        let result = tokio::select! {
            biased;
            _ = wait_closed(&mut closed) => return,
            r = connect(&client) => r,
        };
        match result {
            Ok(c) => {
                let g = inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
                inner.state.send_if_modified(|s| {
                    let open = !is_closed_state(s);
                    if open {
                        *s = ConnState::Up(c, g);
                    }
                    open
                });
                return;
            }
            Err(e) => {
                failures += 1;
                inner.state.send_if_modified(|s| {
                    let open = !is_closed_state(s);
                    if open {
                        *s = ConnState::Down(e);
                    }
                    open
                });
                if inner.fail_fast {
                    return;
                }
                let delay = RECONNECT_BASE_MS
                    .saturating_mul(1u64 << (failures - 1).min(20))
                    .min(RECONNECT_CAP_MS);
                tokio::select! {
                    biased;
                    _ = wait_closed(&mut closed) => return,
                    _ = sleep(Duration::from_millis(delay)) => {}
                }
            }
        }
    }
}

// ------------------------------------------------------------------ reply parsing

fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    match v {
        Value::BulkString(b) => Some(b.clone()),
        Value::SimpleString(s) => Some(s.clone().into_bytes()),
        Value::Okay => Some(b"OK".to_vec()),
        Value::Int(n) => Some(n.to_string().into_bytes()),
        _ => None,
    }
}

fn unexpected(what: &str) -> BusError {
    BusError::internal(format!("unexpected reply shape: {what}"))
}

fn server_error_of(v: &Value) -> Option<BusError> {
    match v {
        Value::ServerError(se) => Some(BusError::new(
            ErrorCode::Redis,
            match se.details() {
                Some(d) => format!("{} {d}", se.code()),
                None => se.code().to_string(),
            },
        )),
        _ => None,
    }
}

/// An entry id with its raw flat field list.
type RawFields = (String, Vec<Vec<u8>>);

/// `[id, [field, value, ...] | nil]` as the id and the raw field list.
fn entry_parts(v: &Value) -> Result<RawFields> {
    let Value::Array(parts) = v else {
        return Err(unexpected("entry"));
    };
    let id = parts
        .first()
        .and_then(bytes_of)
        .ok_or_else(|| unexpected("entry id"))?;
    let id = String::from_utf8_lossy(&id).into_owned();
    let fields = match parts.get(1) {
        Some(Value::Array(f)) => f.iter().filter_map(bytes_of).collect(),
        _ => Vec::new(),
    };
    Ok((id, fields))
}

fn entry_list(v: &Value) -> Result<Vec<RawFields>> {
    match v {
        Value::Array(items) => items.iter().map(entry_parts).collect(),
        Value::Nil => Ok(Vec::new()),
        _ => Err(unexpected("entry list")),
    }
}

/// The envelope fields of one entry; none when any present envelope field is not valid UTF-8 (BUS-NAT-ERR-007,
/// BUS-NAT-TRN-014).
fn raw_entry(id: String, fields: &[Vec<u8>]) -> RawEntry {
    let mut slots: [Option<&[u8]>; 4] = [None; 4];
    for [name, value] in fields.as_chunks::<2>().0 {
        let slot = match name.as_slice() {
            b"type" => 0,
            b"ts" => 1,
            b"source" => 2,
            b"data" => 3,
            _ => continue,
        };
        slots[slot] = Some(value.as_slice());
    }
    let mut out: [Option<String>; 4] = [None, None, None, None];
    for (i, s) in slots.iter().enumerate() {
        if let Some(b) = s {
            match std::str::from_utf8(b) {
                Ok(t) => out[i] = Some(t.to_string()),
                Err(_) => {
                    return RawEntry {
                        id,
                        ..Default::default()
                    };
                }
            }
        }
    }
    let [r#type, ts, source, data] = out;
    RawEntry {
        id,
        r#type,
        ts,
        source,
        data,
    }
}

/// The entries of an `XREAD` / `XREADGROUP` reply for one stream; `None` when nothing was read.
fn stream_reply(v: &Value) -> Result<Option<Vec<RawFields>>> {
    let entries = match v {
        Value::Nil => return Ok(None),
        Value::Array(streams) => match streams.first() {
            None => return Ok(None),
            Some(Value::Array(pair)) => pair.get(1).ok_or_else(|| unexpected("stream pair"))?,
            Some(_) => return Err(unexpected("stream")),
        },
        Value::Map(streams) => match streams.first() {
            None => return Ok(None),
            Some((_, e)) => e,
        },
        _ => return Err(unexpected("stream reply")),
    };
    let list = entry_list(entries)?;
    Ok(if list.is_empty() { None } else { Some(list) })
}

fn stream_key(keys: &Keys, stream: EventStream) -> String {
    match stream {
        EventStream::Events => keys.events(),
        EventStream::Health => keys.health(),
    }
}

fn maxlen_of(stream: EventStream) -> usize {
    match stream {
        EventStream::Events => EVENTS_MAXLEN,
        EventStream::Health => HEALTH_MAXLEN,
    }
}

fn xadd(key: &str, maxlen: usize) -> Cmd {
    let mut c = redis::cmd("XADD");
    c.arg(key).arg("MAXLEN").arg("~").arg(maxlen).arg("*");
    c
}

fn id_reply(v: &Value) -> Result<String> {
    bytes_of(v)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .ok_or_else(|| unexpected("entry id"))
}

fn glob_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

// ------------------------------------------------------------------ Transport

pub struct Transport {
    inner: Arc<Inner>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self.inner.state.send_replace(ConnState::Closed);
    }
}

impl Transport {
    /// Begins opening the shared connection in the background; never blocks or fails (BUS-NAT-TRN-004). Must be
    /// called inside a tokio runtime.
    // @spec BUS-NAT-TRN-004, BUS-NAT-CONN-004, BUS-NAT-CONN-006, BUS-NAT-CONN-007
    pub fn new(url: &str, opts: TransportOptions) -> Transport {
        let client = open_client(url).map_err(|e| BusError::connection(e.to_string()));
        let (state, _) = watch::channel(ConnState::Booting);
        let inner = Arc::new(Inner {
            client,
            keys: Keys::new(&opts.prefix),
            fail_fast: opts.fail_fast,
            state,
            gate: AsyncMutex::new(()),
            generation: AtomicU64::new(0),
            readers: Mutex::new(Vec::new()),
            close_lock: AsyncMutex::new(false),
        });
        tokio::spawn(connect_loop(inner.clone()));
        Transport { inner }
    }

    // @spec BUS-NAT-TRN-001, BUS-NAT-TRN-008
    pub async fn append(&self, stream: EventStream, fields: EntryFields) -> Result<String> {
        let mut cmd = xadd(&stream_key(&self.inner.keys, stream), maxlen_of(stream));
        cmd.arg("type")
            .arg(&fields.r#type)
            .arg("ts")
            .arg(&fields.ts)
            .arg("source")
            .arg(&fields.source)
            .arg("data")
            .arg(&fields.data);
        id_reply(&self.inner.cmd(cmd).await?)
    }

    // @spec BUS-NAT-TRN-001, BUS-NAT-TRN-014
    pub async fn recent(&self, stream: EventStream, count: usize) -> Result<Vec<RawEntry>> {
        let mut cmd = redis::cmd("XREVRANGE");
        cmd.arg(stream_key(&self.inner.keys, stream))
            .arg("+")
            .arg("-")
            .arg("COUNT")
            .arg(count);
        let v = self.inner.cmd(cmd).await?;
        let mut entries: Vec<RawEntry> = entry_list(&v)?
            .into_iter()
            .map(|(id, f)| raw_entry(id, &f))
            .collect();
        entries.reverse();
        Ok(entries)
    }

    // @spec BUS-NAT-TRN-002
    pub async fn create_group(&self, group: &str) -> Result<bool> {
        let mut cmd = redis::cmd("XGROUP");
        cmd.arg("CREATE")
            .arg(self.inner.keys.events())
            .arg(group)
            .arg("$")
            .arg("MKSTREAM");
        match self.inner.cmd(cmd).await {
            Ok(_) => Ok(true),
            Err(e) if e.code == ErrorCode::Redis && e.message.starts_with("BUSYGROUP") => Ok(false),
            Err(e) => Err(e),
        }
    }

    // @spec BUS-NAT-TRN-001
    pub async fn move_group_to_latest(&self, group: &str) -> Result<()> {
        let mut cmd = redis::cmd("XGROUP");
        cmd.arg("SETID")
            .arg(self.inner.keys.events())
            .arg(group)
            .arg("$");
        self.inner.cmd(cmd).await.map(|_| ())
    }

    // @spec BUS-NAT-TRN-001, BUS-UPL-001
    pub async fn put_upload(&self, id: &str, bytes: &[u8], ttl_ms: u64) -> Result<()> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(self.inner.keys.upload(id))
            .arg(bytes)
            .arg("PX")
            .arg(ttl_ms);
        self.inner.cmd(cmd).await.map(|_| ())
    }

    // @spec BUS-NAT-TRN-001, BUS-UPL-002
    pub async fn take_upload(&self, id: &str) -> Result<Option<Vec<u8>>> {
        let mut cmd = redis::cmd("GETDEL");
        cmd.arg(self.inner.keys.upload(id));
        optional_bytes(&self.inner.cmd(cmd).await?)
    }

    // @spec BUS-NAT-TRN-001, CONN-REG-001
    pub async fn write_registration(&self, id: &str, json: &str, lease_ms: u64) -> Result<()> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(self.inner.keys.connector(id))
            .arg(json)
            .arg("PX")
            .arg(lease_ms);
        self.inner.cmd(cmd).await.map(|_| ())
    }

    // @spec BUS-NAT-TRN-001
    pub async fn read_registration(&self, id: &str) -> Result<Option<String>> {
        let mut cmd = redis::cmd("GET");
        cmd.arg(self.inner.keys.connector(id));
        Ok(optional_bytes(&self.inner.cmd(cmd).await?)?
            .map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    // @spec BUS-NAT-TRN-001, CONN-REG-003
    pub async fn delete_registration(&self, id: &str) -> Result<()> {
        let mut cmd = redis::cmd("DEL");
        cmd.arg(self.inner.keys.connector(id));
        self.inner.cmd(cmd).await.map(|_| ())
    }

    /// `SCAN MATCH <prefix>:connector:* COUNT 100` to cursor 0, de-duplicated, then one `MGET` (CONN-REG-006).
    // @spec BUS-NAT-TRN-001, CONN-REG-006
    pub async fn list_registrations(&self) -> Result<Vec<String>> {
        let pattern = format!("{}*", glob_escape(&self.inner.keys.connector("")));
        let mut cursor = "0".to_string();
        let mut seen = HashSet::new();
        let mut keys: Vec<Vec<u8>> = Vec::new();
        loop {
            let mut cmd = redis::cmd("SCAN");
            cmd.arg(&cursor)
                .arg("MATCH")
                .arg(&pattern)
                .arg("COUNT")
                .arg(100);
            let v = self.inner.cmd(cmd).await?;
            let Value::Array(parts) = &v else {
                return Err(unexpected("SCAN"));
            };
            let next = parts
                .first()
                .and_then(bytes_of)
                .ok_or_else(|| unexpected("SCAN cursor"))?;
            cursor = String::from_utf8_lossy(&next).into_owned();
            if let Some(Value::Array(found)) = parts.get(1) {
                for k in found.iter().filter_map(bytes_of) {
                    if seen.insert(k.clone()) {
                        keys.push(k);
                    }
                }
            }
            if cursor == "0" {
                break;
            }
        }
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let mut mget = redis::cmd("MGET");
        for k in &keys {
            mget.arg(k.as_slice());
        }
        let Value::Array(values) = self.inner.cmd(mget).await? else {
            return Err(unexpected("MGET"));
        };
        Ok(values
            .iter()
            .filter_map(bytes_of)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .collect())
    }

    // @spec BUS-NAT-FRM-001, BUS-NAT-FRM-002, BUS-NAT-FRM-003
    pub async fn append_frame(&self, dir: Direction, tag: &str, frame: &Frame) -> Result<String> {
        if !frame.flush {
            if frame.pcm.len() > MAX_FRAME_BYTES {
                return Err(BusError::invalid(format!(
                    "pcm of {} bytes exceeds MAX_FRAME_BYTES ({MAX_FRAME_BYTES})",
                    frame.pcm.len()
                )));
            }
            if !frame.pcm.len().is_multiple_of(2) {
                return Err(BusError::invalid("pcm has an odd byte count"));
            }
        }
        let key = self.inner.keys.audio(dir, tag);
        let mut add = xadd(&key, dir.maxlen());
        for f in encode_frame(frame) {
            add.arg(f);
        }
        let mut pipe = redis::pipe();
        pipe.add_command(add);
        pipe.cmd("PEXPIRE").arg(&key).arg(AUDIO_STREAM_TTL_MS);
        let vals = self.inner.pipe(pipe).await?;
        for v in &vals {
            if let Some(e) = server_error_of(v) {
                return Err(e);
            }
        }
        id_reply(vals.first().ok_or_else(|| unexpected("pipeline"))?)
    }

    /// Redis `TIME` as epoch milliseconds.
    // @spec BUS-NAT-TRN-001, CTRL-CHECK-004
    pub async fn server_time(&self) -> Result<u64> {
        let v = self.inner.cmd(redis::cmd("TIME")).await?;
        let Value::Array(parts) = &v else {
            return Err(unexpected("TIME"));
        };
        let num = |i: usize| -> Result<u64> {
            let b = parts
                .get(i)
                .and_then(bytes_of)
                .ok_or_else(|| unexpected("TIME"))?;
            String::from_utf8_lossy(&b)
                .parse::<u64>()
                .map_err(|_| unexpected("TIME"))
        };
        Ok(num(0)? * 1000 + num(1)? / 1000)
    }

    /// A reader with its own connection, for one blocking loop (opened lazily on its first call).
    // @spec BUS-NAT-TRN-005
    pub fn open_reader(&self) -> Reader {
        let (closed, _) = watch::channel(matches!(*self.inner.state.borrow(), ConnState::Closed));
        let shared = Arc::new(ReaderShared {
            inner: self.inner.clone(),
            conn: Mutex::new(None),
            acks: Mutex::new(Vec::new()),
            closed,
        });
        let mut readers = lock(&self.inner.readers);
        readers.retain(|w| w.strong_count() > 0);
        readers.push(Arc::downgrade(&shared));
        Reader { shared }
    }

    /// Flush every reader's queued acks (2000 ms bound), close everything; never fails; idempotent.
    // @spec BUS-NAT-ACK-005, BUS-NAT-ACK-006, BUS-NAT-ACK-007, BUS-NAT-ERR-008, BUS-NAT-ERR-010
    pub async fn close(&self) {
        let started = Instant::now();
        let mut done = self.inner.close_lock.lock().await;
        if *done {
            return;
        }
        let conn = match &*self.inner.state.borrow() {
            ConnState::Up(c, _) => Some(c.clone()),
            _ => None,
        };
        // Waiters on the first attempt wake with `Closed`; connect tasks stop.
        self.inner.state.send_replace(ConnState::Closed);
        let readers: Vec<Arc<ReaderShared>> = lock(&self.inner.readers)
            .drain(..)
            .filter_map(|w| w.upgrade())
            .collect();
        let mut acks = Vec::new();
        for r in &readers {
            acks.extend(r.take_acks());
            r.close();
        }
        if let (false, Some(mut c)) = (acks.is_empty(), conn) {
            let events = self.inner.keys.events();
            let mut pipe = redis::pipe();
            pipe.ignore_errors();
            for (group, id) in &acks {
                pipe.cmd("XACK").arg(&events).arg(group).arg(id);
            }
            let budget =
                Duration::from_millis(CLOSE_FLUSH_TIMEOUT_MS).saturating_sub(started.elapsed());
            // A failed or abandoned flush is neither retried nor reported (BUS-NAT-ACK-006, BUS-NAT-ACK-007).
            let _ = timeout(budget, pipe.query_async::<Vec<Value>>(&mut c)).await;
        }
        *done = true;
    }
}

fn optional_bytes(v: &Value) -> Result<Option<Vec<u8>>> {
    match v {
        Value::Nil => Ok(None),
        other => bytes_of(other)
            .map(Some)
            .ok_or_else(|| unexpected("bulk string")),
    }
}

// ------------------------------------------------------------------ Reader

struct ReaderShared {
    inner: Arc<Inner>,
    conn: Mutex<Option<MultiplexedConnection>>,
    /// Queued `(group, id)` acks, sent ahead of the next `XREADGROUP` (BUS-NAT-ACK-001).
    acks: Mutex<Vec<(String, String)>>,
    closed: watch::Sender<bool>,
}

impl ReaderShared {
    fn take_acks(&self) -> Vec<(String, String)> {
        std::mem::take(&mut *lock(&self.acks))
    }

    fn close(&self) {
        self.closed.send_replace(true);
        lock(&self.acks).clear();
        *lock(&self.conn) = None;
    }

    async fn connection(&self) -> Result<MultiplexedConnection> {
        if let Some(c) = lock(&self.conn).clone() {
            return Ok(c);
        }
        let client = self.inner.client.as_ref().map_err(|e| e.clone())?;
        let c = connect(client).await?;
        if *self.closed.borrow() {
            return Err(BusError::closed());
        }
        *lock(&self.conn) = Some(c.clone());
        Ok(c)
    }

    /// Runs `f` until the reader is closed, which interrupts it with `BUS_CLOSED` (BUS-NAT-ERR-001).
    async fn guarded<T>(&self, f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        let mut rx = self.closed.subscribe();
        if *rx.borrow() {
            return Err(BusError::closed());
        }
        tokio::select! {
            biased;
            _ = async { let _ = rx.wait_for(|c| *c).await; } => Err(BusError::closed()),
            r = f => r,
        }
    }

    /// Maps a client error; a connection failure drops the connection so the next call opens a new one
    /// (BUS-NAT-CONN-001).
    fn failed(&self, e: &redis::RedisError) -> BusError {
        if *self.closed.borrow() {
            return BusError::closed();
        }
        let be = BusError::from_redis(e);
        if be.is_connection() {
            *lock(&self.conn) = None;
        }
        be
    }

    async fn xread(
        &self,
        key: &str,
        from_id: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<Option<Vec<RawFields>>> {
        let mut c = self.connection().await?;
        let mut cmd = redis::cmd("XREAD");
        cmd.arg("COUNT")
            .arg(count)
            .arg("BLOCK")
            .arg(block_ms)
            .arg("STREAMS")
            .arg(key)
            .arg(from_id);
        let v = cmd
            .query_async::<Value>(&mut c)
            .await
            .map_err(|e| self.failed(&e))?;
        stream_reply(&v)
    }
}

pub struct Reader {
    shared: Arc<ReaderShared>,
}

impl Reader {
    /// Sends the queued acks, then `XREADGROUP`, in one pipeline (BUS-NAT-ACK-001, BUS-NAT-ACK-003,
    /// BUS-NAT-ACK-004).
    // @spec BUS-NAT-ACK-001, BUS-NAT-ACK-003, BUS-NAT-ACK-004, BUS-NAT-CONN-001, BUS-NAT-TRN-003
    pub async fn read_group(
        &self,
        group: &str,
        consumer: &str,
        cursor: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<GroupRead> {
        let s = &self.shared;
        s.guarded(async {
            let acks: Vec<(String, String)> = lock(&s.acks).clone();
            let events = s.inner.keys.events();
            let mut c = s.connection().await?;
            let mut pipe = redis::pipe();
            pipe.ignore_errors();
            for (g, id) in &acks {
                pipe.cmd("XACK").arg(&events).arg(g).arg(id);
            }
            pipe.cmd("XREADGROUP")
                .arg("GROUP")
                .arg(group)
                .arg(consumer)
                .arg("COUNT")
                .arg(count)
                .arg("BLOCK")
                .arg(block_ms)
                .arg("STREAMS")
                .arg(&events)
                .arg(cursor);
            let mut vals = pipe
                .query_async::<Vec<Value>>(&mut c)
                .await
                .map_err(|e| s.failed(&e))?;
            // The pipeline reached Redis: those acks are settled, refused or not.
            lock(&s.acks).drain(..acks.len());
            let read = vals.pop().ok_or_else(|| unexpected("pipeline"))?;
            if let Some(e) = server_error_of(&read) {
                return Err(e);
            }
            let mut ack_errors: Vec<AckError> = Vec::new();
            for ((_, id), v) in acks.iter().zip(&vals) {
                if let Some(err) = server_error_of(v) {
                    match ack_errors.iter_mut().find(|a| a.err == err) {
                        Some(a) => a.ids.push(id.clone()),
                        None => ack_errors.push(AckError {
                            ids: vec![id.clone()],
                            err,
                        }),
                    }
                }
            }
            let entries = stream_reply(&read)?.map(|list| {
                list.into_iter()
                    .map(|(id, f)| raw_entry(id, &f))
                    .collect::<Vec<_>>()
            });
            Ok(GroupRead {
                entries,
                ack_errors,
            })
        })
        .await
    }

    /// Synchronous: only queues the id (BUS-NAT-ACK-001).
    pub fn ack(&self, group: &str, id: &str) {
        if !*self.shared.closed.borrow() {
            lock(&self.shared.acks).push((group.to_string(), id.to_string()));
        }
    }

    // @spec BUS-NAT-TRN-001, BUS-NAT-TRN-014
    pub async fn read(
        &self,
        stream: EventStream,
        from_id: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<Option<Vec<RawEntry>>> {
        let s = &self.shared;
        let key = stream_key(&s.inner.keys, stream);
        s.guarded(async {
            Ok(s.xread(&key, from_id, count, block_ms)
                .await?
                .map(|list| list.into_iter().map(|(id, f)| raw_entry(id, &f)).collect()))
        })
        .await
    }

    // @spec BUS-NAT-FRM-004
    pub async fn read_frames(
        &self,
        dir: Direction,
        tag: &str,
        from_id: &str,
        count: usize,
        block_ms: u64,
    ) -> Result<Option<Vec<FrameEntry>>> {
        let s = &self.shared;
        let key = s.inner.keys.audio(dir, tag);
        s.guarded(async {
            Ok(s.xread(&key, from_id, count, block_ms).await?.map(|list| {
                list.into_iter()
                    .map(|(id, f)| FrameEntry {
                        id,
                        decoded: decode_frame(&f),
                    })
                    .collect()
            }))
        })
        .await
    }

    /// Closes this reader's connection, dropping its queued acks; a blocked read rejects `BUS_CLOSED`.
    pub fn close(&self) {
        self.shared.close();
    }
}
