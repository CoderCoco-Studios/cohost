//! napi-rs wrapper over `cohost-bus`: argument and result conversion and error mapping only (BUS-NAT-RS-002).
//!
//! Every I/O method returns a Promise settled from a future on the addon's tokio runtime (one runtime per process,
//! one worker thread; constraint N3). Rust never calls into JavaScript (constraint N1). A panic inside a future is
//! caught and rejects the call with `BUS_INTERNAL` (BUS-NAT-ERR-006). Nothing is written to stdout or stderr
//! (BUS-NAT-TRN-011).
//!
//! JavaScript surface (the `BusTransport` seam of `packages/bus/src/transport.ts`):
//! - `new Transport(url, prefix, failFast)`: `append`, `recent`, `createGroup`, `moveGroupToLatest`, `putUpload`,
//!   `takeUpload`, `writeRegistration`, `readRegistration`, `deleteRegistration`, `listRegistrations`,
//!   `serverTime`, `openReader`, `close`.
//! - `Reader` (from `openReader()`): `readGroup`, `ack`, `read`, `close`.
//! - Synchronous helper: `connectorKey`.
//! - Constants: `EVENTS_MAXLEN`, `HEALTH_MAXLEN`. The addon serves the events path only: no frame codec, tag grammar
//!   or audio stream naming (BUS-NAT-TRN-013).
#![deny(clippy::all)]

use cohost_bus::consts;
use cohost_bus::error::Result as BusResult;
use cohost_bus::transport::{
    EntryFields, EventStream, GroupRead, RawEntry, Reader as BusReader, Transport as BusTransport,
    TransportOptions,
};
use cohost_bus::{BusError, keys::Keys};
use napi::bindgen_prelude::{Buffer, Object, PromiseRaw};
use napi::{Env, JsValue};
use napi_derive::napi;
use std::cell::Cell;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

// ------------------------------------------------------------------ runtime and panic containment

thread_local! {
    /// Set while a bus future is being polled, so the panic hook stays silent for panics the binding catches.
    static IN_BUS_CALL: Cell<bool> = const { Cell::new(false) };
}

#[napi_derive::module_init]
fn init() {
    // One runtime per process with one worker: the bus is I/O-bound (BUS-NAT constraint N3).
    if let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
    {
        napi::bindgen_prelude::create_custom_tokio_runtime(rt);
    }
    // BUS-NAT-TRN-011: a caught panic must not print; every other panic goes to the previous hook.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if !IN_BUS_CALL.with(Cell::get) {
            previous(info);
        }
    }));
}

/// Polls `F` with panics caught: a panic becomes `Err(message)` (BUS-NAT-ERR-006).
struct Guarded<F>(Pin<Box<F>>);

impl<F: Future> Future for Guarded<F> {
    type Output = Result<F::Output, String>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        IN_BUS_CALL.with(|c| c.set(true));
        let polled = catch_unwind(AssertUnwindSafe(|| self.0.as_mut().poll(cx)));
        IN_BUS_CALL.with(|c| c.set(false));
        match polled {
            Ok(Poll::Ready(v)) => Poll::Ready(Ok(v)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(payload) => Poll::Ready(Err(panic_message(&payload))),
        }
    }
}

fn panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    let text = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string());
    format!("panic in the native bus: {text}")
}

/// A JS `Error` with `message` and the `code` of `e` (BUS-NAT-ERR-001).
fn coded_error(env: &Env, e: &BusError) -> napi::Error {
    let build = || -> napi::Result<napi::Error> {
        let mut obj = env.create_error(napi::Error::new(
            napi::Status::GenericFailure,
            e.message.clone(),
        ))?;
        obj.set("code", e.code.as_str())?;
        Ok(napi::Error::from(obj.to_unknown()))
    };
    build().unwrap_or_else(|_| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

/// Runs `fut` on the addon runtime and settles the Promise from its outcome; `conv` builds the JS value on the JS
/// thread (so `Buffer`s and objects are created there).
fn run<'env, T, V>(
    env: &'env Env,
    fut: impl Future<Output = BusResult<T>> + Send + 'static,
    conv: impl FnOnce(&'env Env, T) -> napi::Result<V> + 'static,
) -> napi::Result<PromiseRaw<'env, V>>
where
    T: Send + 'static,
    V: napi::bindgen_prelude::ToNapiValue,
{
    let guarded = async move {
        Ok::<BusResult<T>, napi::Error>(match Guarded(Box::pin(fut)).await {
            Ok(r) => r,
            Err(panic) => Err(BusError::internal(panic)),
        })
    };
    env.spawn_future_with_callback(guarded, move |env, r| match r {
        Ok(t) => conv(env, t),
        Err(e) => Err(coded_error(env, &e)),
    })
}

fn stream_of(s: &str) -> BusResult<EventStream> {
    match s {
        "events" => Ok(EventStream::Events),
        "health" => Ok(EventStream::Health),
        other => Err(BusError::invalid(format!("unknown stream {other:?}"))),
    }
}

fn millis(n: f64) -> BusResult<u64> {
    if n.is_finite() && n >= 0.0 {
        Ok(n as u64)
    } else {
        Err(BusError::invalid(format!("{n} is not a valid duration")))
    }
}

// ------------------------------------------------------------------ value conversion

#[napi(object)]
pub struct EntryFieldsJs {
    pub r#type: String,
    pub ts: String,
    pub source: String,
    pub data: String,
}

fn raw_entry_obj<'env>(env: &'env Env, e: RawEntry) -> napi::Result<Object<'env>> {
    let mut o = Object::new(env)?;
    o.set("id", e.id)?;
    if let Some(v) = e.r#type {
        o.set("type", v)?;
    }
    if let Some(v) = e.ts {
        o.set("ts", v)?;
    }
    if let Some(v) = e.source {
        o.set("source", v)?;
    }
    if let Some(v) = e.data {
        o.set("data", v)?;
    }
    Ok(o)
}

fn raw_entries<'env>(env: &'env Env, list: Vec<RawEntry>) -> napi::Result<Vec<Object<'env>>> {
    list.into_iter().map(|e| raw_entry_obj(env, e)).collect()
}

fn group_read_obj<'env>(env: &'env Env, g: GroupRead) -> napi::Result<Object<'env>> {
    let mut o = Object::new(env)?;
    match g.entries {
        Some(list) => o.set("entries", raw_entries(env, list)?)?,
        None => o.set("entries", napi::bindgen_prelude::Null)?,
    }
    let mut errs = Vec::with_capacity(g.ack_errors.len());
    for a in g.ack_errors {
        let mut e = Object::new(env)?;
        e.set("ids", a.ids)?;
        let err = coded_error(env, &a.err);
        let mut v = env.create_error(err)?;
        v.set("code", a.err.code.as_str())?;
        e.set("err", v)?;
        errs.push(e);
    }
    o.set("ackErrors", errs)?;
    Ok(o)
}

// ------------------------------------------------------------------ Transport

/// The shared connection and the factory of readers (`BusTransport`).
#[napi(js_name = "Transport")]
pub struct JsTransport {
    inner: Arc<BusTransport>,
}

#[napi]
impl JsTransport {
    /// Begins opening the shared connection in the background; never blocks or throws (BUS-NAT-TRN-004).
    // @spec BUS-NAT-TRN-004
    #[napi(constructor)]
    pub fn new(url: String, prefix: String, fail_fast: bool) -> Self {
        let inner = napi::bindgen_prelude::within_runtime_if_available(|| {
            BusTransport::new(&url, TransportOptions { prefix, fail_fast })
        });
        JsTransport {
            inner: Arc::new(inner),
        }
    }

    #[napi]
    pub fn append<'env>(
        &self,
        env: &'env Env,
        stream: String,
        fields: EntryFieldsJs,
    ) -> napi::Result<PromiseRaw<'env, String>> {
        let t = self.inner.clone();
        let fields = EntryFields {
            r#type: fields.r#type,
            ts: fields.ts,
            source: fields.source,
            data: fields.data,
        };
        run(
            env,
            async move { t.append(stream_of(&stream)?, fields).await },
            |_, id| Ok(id),
        )
    }

    #[napi]
    pub fn recent<'env>(
        &self,
        env: &'env Env,
        stream: String,
        count: u32,
    ) -> napi::Result<PromiseRaw<'env, Vec<Object<'env>>>> {
        let t = self.inner.clone();
        run(
            env,
            async move { t.recent(stream_of(&stream)?, count as usize).await },
            raw_entries,
        )
    }

    #[napi(js_name = "createGroup")]
    pub fn create_group<'env>(
        &self,
        env: &'env Env,
        group: String,
    ) -> napi::Result<PromiseRaw<'env, bool>> {
        let t = self.inner.clone();
        run(env, async move { t.create_group(&group).await }, |_, b| {
            Ok(b)
        })
    }

    #[napi(js_name = "moveGroupToLatest")]
    pub fn move_group_to_latest<'env>(
        &self,
        env: &'env Env,
        group: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let t = self.inner.clone();
        run(
            env,
            async move { t.move_group_to_latest(&group).await },
            |_, _| Ok(()),
        )
    }

    /// Copies `bytes` before returning (BUS-NAT-TRN-009).
    #[napi(js_name = "putUpload")]
    pub fn put_upload<'env>(
        &self,
        env: &'env Env,
        id: String,
        bytes: Buffer,
        ttl_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let t = self.inner.clone();
        let bytes = bytes.to_vec();
        run(
            env,
            async move { t.put_upload(&id, &bytes, millis(ttl_ms)?).await },
            |_, _| Ok(()),
        )
    }

    /// The bytes come back as a `Buffer` that owns the Rust allocation (BUS-NAT-TRN-010).
    #[napi(js_name = "takeUpload")]
    pub fn take_upload<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<PromiseRaw<'env, Option<Buffer>>> {
        let t = self.inner.clone();
        run(env, async move { t.take_upload(&id).await }, |_, b| {
            Ok(b.map(Buffer::from))
        })
    }

    #[napi(js_name = "writeRegistration")]
    pub fn write_registration<'env>(
        &self,
        env: &'env Env,
        id: String,
        json: String,
        lease_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let t = self.inner.clone();
        run(
            env,
            async move { t.write_registration(&id, &json, millis(lease_ms)?).await },
            |_, _| Ok(()),
        )
    }

    #[napi(js_name = "readRegistration")]
    pub fn read_registration<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<PromiseRaw<'env, Option<String>>> {
        let t = self.inner.clone();
        run(
            env,
            async move { t.read_registration(&id).await },
            |_, s| Ok(s),
        )
    }

    #[napi(js_name = "deleteRegistration")]
    pub fn delete_registration<'env>(
        &self,
        env: &'env Env,
        id: String,
    ) -> napi::Result<PromiseRaw<'env, ()>> {
        let t = self.inner.clone();
        run(
            env,
            async move { t.delete_registration(&id).await },
            |_, _| Ok(()),
        )
    }

    #[napi(js_name = "listRegistrations")]
    pub fn list_registrations<'env>(
        &self,
        env: &'env Env,
    ) -> napi::Result<PromiseRaw<'env, Vec<String>>> {
        let t = self.inner.clone();
        run(env, async move { t.list_registrations().await }, |_, v| {
            Ok(v)
        })
    }

    #[napi(js_name = "serverTime")]
    pub fn server_time<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, f64>> {
        let t = self.inner.clone();
        run(env, async move { t.server_time().await }, |_, ms| {
            Ok(ms as f64)
        })
    }

    #[napi(js_name = "openReader")]
    pub fn open_reader(&self) -> JsReader {
        JsReader {
            inner: Arc::new(self.inner.open_reader()),
        }
    }

    /// Never rejects.
    #[napi]
    pub fn close<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        let t = self.inner.clone();
        run(
            env,
            async move {
                t.close().await;
                Ok(())
            },
            |_, _| Ok(()),
        )
    }
}

// ------------------------------------------------------------------ Reader

/// A dedicated connection for one blocking loop (`BusReader`).
#[napi(js_name = "Reader")]
pub struct JsReader {
    inner: Arc<BusReader>,
}

#[napi]
impl JsReader {
    // @spec BUS-NAT-ACK-001
    #[napi(js_name = "readGroup")]
    pub fn read_group<'env>(
        &self,
        env: &'env Env,
        group: String,
        consumer: String,
        cursor: String,
        count: u32,
        block_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, Object<'env>>> {
        let r = self.inner.clone();
        run(
            env,
            async move {
                r.read_group(
                    &group,
                    &consumer,
                    &cursor,
                    count as usize,
                    millis(block_ms)?,
                )
                .await
            },
            group_read_obj,
        )
    }

    /// Synchronous: only queues the id.
    #[napi]
    pub fn ack(&self, group: String, id: String) {
        self.inner.ack(&group, &id);
    }

    #[napi]
    pub fn read<'env>(
        &self,
        env: &'env Env,
        stream: String,
        from_id: String,
        count: u32,
        block_ms: f64,
    ) -> napi::Result<PromiseRaw<'env, Option<Vec<Object<'env>>>>> {
        let r = self.inner.clone();
        run(
            env,
            async move {
                r.read(
                    stream_of(&stream)?,
                    &from_id,
                    count as usize,
                    millis(block_ms)?,
                )
                .await
            },
            |env, v| v.map(|list| raw_entries(env, list)).transpose(),
        )
    }

    #[napi]
    pub fn close(&self) {
        self.inner.close();
    }
}

// ------------------------------------------------------------------ synchronous helpers

/// `<prefix>:connector:<id>` (BUS-NAT-RS-006).
#[napi(js_name = "connectorKey")]
pub fn connector_key(prefix: String, id: String) -> String {
    Keys::new(&prefix).connector(&id)
}

/// Panics inside its future so a test can check BUS-NAT-ERR-006 (BUS-NAT-ERR-011). Exported only with the
/// `test-panic` feature.
#[cfg(feature = "test-panic")]
#[napi(js_name = "testPanic")]
pub fn test_panic(env: &Env) -> napi::Result<PromiseRaw<'_, ()>> {
    run(
        env,
        async move {
            if true {
                panic!("test-panic");
            }
            Ok(())
        },
        |_, _: ()| Ok(()),
    )
}

// ------------------------------------------------------------------ constants

#[napi]
pub const EVENTS_MAXLEN: u32 = consts::EVENTS_MAXLEN as u32;
#[napi]
pub const HEALTH_MAXLEN: u32 = consts::HEALTH_MAXLEN as u32;
