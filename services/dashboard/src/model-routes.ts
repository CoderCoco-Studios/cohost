import http from "node:http";
import { authorized } from "./access.js";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { AppliedView } from "./applied.js";
import {
  derivedName, findStored, judgeHead, MODEL_MAX_COUNT, MODEL_MAX_TOTAL_BYTES, modelNameOk, ModelStore, READ_FLAGS, sameModel, type Stored,
} from "./models.js";

/** The idle limit of an upload: 30 s without a byte aborts it with 408 (DASH-MDL-023). */
export const UPLOAD_IDLE_MS = 30_000;
const MODELS_PREFIX = "/avatar/models/";

/** What the model routes need: the store, the applied view, the cap and the one lock. */
export interface ModelRoutes {
  store: ModelStore;
  applied: AppliedView;
  /** `dashboard.models.max_bytes`. */
  maxBytes: number;
  /** `CONTROL_TOKEN`: every mutating model route passes the gate of DASH-CTRL-011 (DASH-MDL-016). */
  token: string;
  /** The one upload slot: an upload runs at a time (DASH-MDL-017). */
  slot: { busy: boolean };
  idleMs?: number;
}

const send = (res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(value));
};

const notFound = (res: http.ServerResponse, detail: string): void => send(res, 404, { ok: false, detail });

/** A stored model as `GET /avatar/models` lists it (DASH-MDL-011). */
function entryJson(s: Stored, active: string | null) {
  const base = { name: s.name, bytes: s.bytes, modified: s.modified, active: s.name === active };
  if (!s.meta) return { ...base, error: s.error ?? "the file is not readable", vrm: null, title: null, authors: [], license: null, usage: [], expressions: [] };
  const m = s.meta;
  return { ...base, vrm: m.vrm, title: m.title, authors: m.authors, license: m.license, usage: m.usage, expressions: m.expressions };
}

/** A path segment decoded and held to the grammar, or undefined: nothing else reaches the listing (DASH-MDL-007). */
function decodeName(raw: string): string | undefined {
  let name: string;
  try { name = decodeURIComponent(raw); } catch { return undefined; }
  return modelNameOk(name) ? name : undefined;
}

/** True when `If-None-Match` is `*` or lists `etag` (weak comparison). */
function notModified(req: http.IncomingMessage, etag: string): boolean {
  const h = req.headers["if-none-match"];
  if (!h) return false;
  const tags = h.split(",").map((t) => t.trim());
  const strip = (t: string) => t.replace(/^W\//, "");
  return tags.includes("*") || tags.some((t) => strip(t) === strip(etag));
}

/** Streams a stored file: the headers of DASH-MDL-004, `304` for a current etag (DASH-MDL-005). The file is opened without following a link. */
// @spec DASH-MDL-004, DASH-MDL-005, DASH-MDL-007
async function serveFile(req: http.IncomingMessage, res: http.ServerResponse, s: Stored): Promise<void> {
  let fh: FileHandle;
  try { fh = await open(s.path, READ_FLAGS); } catch { return notFound(res, "the model file is not there"); }
  let st;
  try { st = await fh.stat({ bigint: true }); } catch { await fh.close(); return notFound(res, "the model file is not there"); }
  if (!st.isFile()) { await fh.close(); return notFound(res, "the model file is not there"); }
  const bytes = Number(st.size);
  const etag = `W/"${bytes.toString(16)}-${(st.mtimeNs / 1_000_000n).toString(16)}"`;
  if (notModified(req, etag)) {
    await fh.close();
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "model/gltf-binary", "content-length": String(bytes), "x-content-type-options": "nosniff", etag, "cache-control": "no-cache",
  });
  if (req.method === "HEAD") { await fh.close(); res.end(); return; }
  const stream = fh.createReadStream({ autoClose: true });
  stream.on("error", () => res.destroy()); // a read error after the headers cuts the connection
  // A client that leaves early must not leave the file open: the stream closes its handle with the response.
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** `GET`/`HEAD /avatar/model`: the applied model, on both listeners and ungated (DASH-MDL-008, DASH-MDL-006). */
// @spec DASH-MDL-006, DASH-MDL-008, DASH-AVR-026
async function serveApplied(m: ModelRoutes, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const cur = m.applied.get().model;
  if (!cur) return notFound(res, "no model is applied");
  const s = findStored(await m.store.stored(), cur.name);
  if (!s) return notFound(res, "the applied model has no file in the model store");
  return serveFile(req, res, s);
}

/** `GET /avatar/models`: the list, the applied name and the limits (DASH-MDL-010, DASH-MDL-011). */
// @spec DASH-MDL-010, DASH-MDL-011, DASH-AVR-026
async function list(m: ModelRoutes, res: http.ServerResponse): Promise<void> {
  const active = m.applied.get().model?.name ?? null;
  const models = (await m.store.stored()).map((s) => entryJson(s, active));
  send(res, 200, { models, active, maxBytes: m.maxBytes, maxModels: MODEL_MAX_COUNT, maxTotalBytes: MODEL_MAX_TOTAL_BYTES });
}

/** `GET`/`HEAD /avatar/models/<name>`: one listed model without an error, as `/avatar/model` serves it (DASH-MDL-009). */
// @spec DASH-MDL-009
async function serveNamed(m: ModelRoutes, req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
  const name = decodeName(raw);
  const s = name === undefined ? undefined : (await m.store.stored()).find((x) => sameModel(x.name, name) && x.error === undefined);
  if (!s) return notFound(res, "no listed model has that name");
  return serveFile(req, res, s);
}

const unauthorizedIfNeeded = (m: ModelRoutes, req: http.IncomingMessage): boolean => !authorized(m.token, req);

/**
 * Answers a request and closes its connection, writing the answer to the socket as it is (`connection: close`) and ending the
 * socket after it. Node's own response path would destroy the socket as soon as the FIN is out, and a socket closed with unread
 * input is reset, which can cost the client the answer. A refusal before the body (`drain: false`) reads no body byte: the
 * socket is paused, so the server takes in no more than the socket buffers hold. A stop in the middle of a body (`drain: true`)
 * drains the rest of the input for at most 2 s, then destroys the socket (or at once when the client has closed its end).
 */
// @spec DASH-MDL-017, DASH-MDL-021, DASH-MDL-023, DASH-MDL-024
function stopped(req: http.IncomingMessage, status: number, value: object, o: { headers?: Record<string, string>; drain: boolean }): void {
  const sock = req.socket;
  const body = JSON.stringify(value);
  const extra = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  sock.write(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? "Error"}\r\ncontent-type: application/json\r\ncache-control: no-store\r\n${extra}` +
    `connection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  sock.end();
  if (o.drain) req.resume();
  const t = setTimeout(() => sock.destroy(), 2000);
  t.unref?.();
  sock.once("close", () => clearTimeout(t));
}

/** A refusal before the body: the body is not read (DASH-MDL-017). */
const refuse = (req: http.IncomingMessage, status: number, value: object, headers?: Record<string, string>): void =>
  stopped(req, status, value, { drain: false, ...(headers ? { headers } : {}) });

/** The 401 of a gated route, answered before the body. */
const unauthorized = (req: http.IncomingMessage): void => refuse(req, 401, { ok: false, detail: "the control token is missing or wrong" }, { "www-authenticate": "Bearer" });

/** Answers a failed write or an upload that could not start: `507` for a full disk, `500` otherwise, with the error code only (DASH-MDL-029). */
function failure(req: http.IncomingMessage, err: unknown): void {
  const code = (err as NodeJS.ErrnoException)?.code;
  stopped(req, code === "ENOSPC" ? 507 : 500, { ok: false, detail: code ?? "the write failed" }, { drain: true });
}

type Body = { kind: "done"; total: number } | { kind: "stop"; status: number; detail: string } | { kind: "failed"; err: unknown } | { kind: "gone" };
/** The temporary file of an upload: its handle and its `.incoming-*` path. */
export interface Temp { fh: FileHandle; path: string }

/**
 * Streams an upload's body to the temporary file: the head is judged as its bytes arrive (DASH-MDL-024), the rest is written
 * with the request paused while a write is pending (DASH-MDL-022), the cap is refused at its first byte over (DASH-MDL-021), a
 * body longer than its Content-Length is refused as it passes it, and no byte for `idleMs` is a 408 (DASH-MDL-023). Only the
 * head is ever held in memory.
 */
// @spec DASH-MDL-021, DASH-MDL-022, DASH-MDL-023, DASH-MDL-024, DASH-MDL-027, DASH-MDL-030
function streamBody(req: http.IncomingMessage, o: { open: () => Promise<Temp>; maxBytes: number; declared?: number; idleMs: number; write: ModelStore["writeChunk"] }): Promise<Body> {
  return new Promise((resolve) => {
    let settled = false;
    let received = 0;
    let opened = false;
    let temp: Temp | undefined;
    let chain: Promise<void> = Promise.resolve();
    let pending: Buffer[] = [];
    let pendingLen = 0;
    let need = 12;
    let headTotal: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // The answer waits for the pending file open and writes, so the caller's cleanup sees the temporary file.
    const finish = (b: Body): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.pause();
      chain.then(() => resolve(b), () => resolve(b));
    };
    const idle = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => finish({ kind: "stop", status: 408, detail: "no byte arrived for 30 s" }), o.idleMs);
    };
    const flush = (b: Buffer): void => {
      req.pause();
      chain = chain
        .then(async () => { if (settled) return; await o.write(temp!.fh, b); if (!settled) req.resume(); })
        .catch((err: unknown) => finish({ kind: "failed", err }));
    };
    // The temporary file is made at the first byte, once the idle timer is running (DASH-MDL-022, DASH-MDL-023).
    const openOnce = (): void => {
      if (opened) return;
      opened = true;
      chain = chain.then(async () => { if (!settled) temp = await o.open(); }).catch((err: unknown) => finish({ kind: "failed", err }));
    };

    idle();
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      idle();
      received += chunk.length;
      openOnce();
      if (received > o.maxBytes) return finish({ kind: "stop", status: 413, detail: `the file is over ${o.maxBytes} bytes, dashboard.models.max_bytes` });
      if (headTotal !== undefined) return flush(chunk);
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen < need) return;
      const buf = Buffer.concat(pending);
      pending = [];
      pendingLen = 0;
      const v = judgeHead(buf);
      if ("need" in v) { need = v.need; pending = [buf]; pendingLen = buf.length; return; }
      if ("error" in v) return finish({ kind: "stop", status: 400, detail: v.error });
      if (v.total > o.maxBytes) return finish({ kind: "stop", status: 413, detail: `the header says ${v.total} bytes, over dashboard.models.max_bytes` });
      headTotal = v.total;
      flush(buf);
    });
    req.on("end", () => {
      if (settled) return;
      void chain.then(() => {
        if (settled) return;
        if (headTotal === undefined) return finish({ kind: "stop", status: 400, detail: "the body ends before its glTF head is complete" });
        if (received !== headTotal) return finish({ kind: "stop", status: 400, detail: `the body is ${received} bytes; its glTF header says ${headTotal}` });
        finish({ kind: "done", total: received });
      }, (err: unknown) => finish({ kind: "failed", err }));
    });
    req.on("close", () => { if (!req.complete) finish({ kind: "gone" }); });
    req.on("error", () => finish({ kind: "gone" }));
  });
}

/** The commit of a finished upload under the applied view's lock: the collision and total checks, then link or rename (DASH-MDL-028). */
// @spec DASH-MDL-019, DASH-MDL-020, DASH-MDL-028, DASH-AVR-027, DASH-AVR-028
async function commitUpload(m: ModelRoutes, tmp: string, name: string, replace: boolean, total: number): Promise<{ status: number; body: unknown }> {
  const listed = await m.store.stored();
  const existing = findStored(listed, name);
  if (existing && !replace) return { status: 409, body: { ok: false, detail: "a model of that name is stored; replace=1 replaces it", name: existing.name } };
  const others = listed.reduce((t, s) => t + s.bytes, 0) - (existing?.bytes ?? 0);
  if (others + total > MODEL_MAX_TOTAL_BYTES) return { status: 409, body: { ok: false, detail: `the stored models would total more than ${MODEL_MAX_TOTAL_BYTES} bytes; delete one first` } };
  if (!existing && listed.length >= MODEL_MAX_COUNT) return { status: 409, body: { ok: false, detail: `${MODEL_MAX_COUNT} models are stored, the most the store holds; delete one first` } };
  // An entry the listing does not show (a directory, a link, a case variant) holding the name is a collision too.
  const clash = (await m.store.names()).some((n) => sameModel(n, name) && n !== existing?.name);
  if (clash) return { status: 409, body: { ok: false, detail: "a file that is not a stored model holds that name", name } };
  const dest = existing ? existing.name : name;
  const r = await m.store.commit(tmp, join(m.store.dir, dest), existing !== undefined);
  if (r === "exists") return { status: 409, body: { ok: false, detail: "a model of that name was stored meanwhile", name } };
  m.applied.refresh(await m.store.loadable());
  const stored = findStored(await m.store.stored(), dest)!;
  return { status: 201, body: { ok: true, model: entryJson(stored, m.applied.get().model?.name ?? null) } };
}

/** `POST /avatar/models?name=`: checks, streamed write, head checks, length check and commit (DASH-MDL-015 to DASH-MDL-032). */
// @spec DASH-MDL-015, DASH-MDL-016, DASH-MDL-017, DASH-MDL-018, DASH-MDL-019, DASH-MDL-020, DASH-MDL-029, DASH-HTTP-015
async function upload(m: ModelRoutes, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (unauthorizedIfNeeded(m, req)) return unauthorized(req);
  const cl = req.headers["content-length"];
  const declared = cl === undefined ? undefined : Number(cl);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) return refuse(req, 400, { ok: false, detail: "Content-Length is not a byte count" });
  if (declared !== undefined && declared > m.maxBytes) return refuse(req, 413, { ok: false, detail: `the file is over ${m.maxBytes} bytes, dashboard.models.max_bytes` });
  const query = url.searchParams.get("name");
  if (!query) return refuse(req, 400, { ok: false, detail: "the name query is required" });
  const name = derivedName(query);
  if (!modelNameOk(name)) return refuse(req, 400, { ok: false, detail: "the name cannot be stored" });
  const replace = url.searchParams.get("replace") === "1";
  if (m.slot.busy) return refuse(req, 409, { ok: false, detail: "another upload is running" });

  m.slot.busy = true;
  try {
    const pre = await m.store.stored();
    const existing = findStored(pre, name);
    if (existing && !replace) return refuse(req, 409, { ok: false, detail: "a model of that name is stored; replace=1 replaces it", name: existing.name });
    const others = pre.reduce((t, s) => t + s.bytes, 0) - (existing?.bytes ?? 0);
    if (!existing && pre.length >= MODEL_MAX_COUNT) return refuse(req, 409, { ok: false, detail: `${MODEL_MAX_COUNT} models are stored, the most the store holds; delete one first` });
    if ((declared !== undefined && others + declared > MODEL_MAX_TOTAL_BYTES) || others > MODEL_MAX_TOTAL_BYTES) {
      return refuse(req, 409, { ok: false, detail: `the stored models would total more than ${MODEL_MAX_TOTAL_BYTES} bytes; delete one first` });
    }

    let tmp: Temp | undefined;
    let closed = false;
    const release = async (): Promise<void> => {
      if (!tmp) return;
      if (!closed) { closed = true; await tmp.fh.close().catch(() => undefined); }
      await unlink(tmp.path).catch(() => undefined);
    };

    const got = await streamBody(req, {
      open: async () => (tmp = await m.store.createTemp()),
      maxBytes: m.maxBytes, declared, idleMs: m.idleMs ?? UPLOAD_IDLE_MS, write: m.store.writeChunk,
    });
    if (got.kind === "gone") { await release(); return; }
    if (got.kind === "stop") { await release(); return stopped(req, got.status, { ok: false, detail: got.detail }, { drain: true }); }
    if (got.kind === "failed") { await release(); return failure(req, got.err); }

    try {
      if (!closed) { closed = true; await tmp!.fh.close(); }
      const out = await m.applied.lock.run(() => commitUpload(m, tmp!.path, name, replace, got.total));
      await release();
      return send(res, out.status, out.body);
    } catch (err) {
      await release();
      return failure(req, err);
    }
  } finally {
    m.slot.busy = false;
  }
}

/** `DELETE /avatar/models/<name>`: the name, then the applied model, under the lock (DASH-MDL-033 to DASH-MDL-036). */
// @spec DASH-MDL-033, DASH-MDL-034, DASH-MDL-035, DASH-MDL-036, DASH-AVR-028
async function remove(m: ModelRoutes, req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
  if (unauthorizedIfNeeded(m, req)) return unauthorized(req);
  const name = decodeName(raw);
  if (name === undefined) return notFound(res, "no stored model has that name");
  await m.applied.lock.run(async () => {
    const s = findStored(await m.store.stored(), name);
    if (!s) return notFound(res, "no stored model has that name");
    const cur = m.applied.get().model;
    if (cur && sameModel(cur.name, s.name)) return send(res, 409, { ok: false, detail: "that model is applied: select another model, or none, and save first" });
    await unlink(s.path);
    send(res, 200, { ok: true });
  });
}

/**
 * The avatar model routes on the full-surface listener (the LAN listener's allow-list passes only `GET`/`HEAD /avatar/model`,
 * DASH-HOST-002). Returns false for a request it does not own.
 */
// @spec DASH-MDL-008, DASH-MDL-009, DASH-MDL-010, DASH-MDL-015, DASH-MDL-033
export async function handleModels(m: ModelRoutes, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const method = req.method ?? "GET";
  const get = method === "GET" || method === "HEAD";
  if (p === "/avatar/model") {
    if (!get) return false;
    await serveApplied(m, req, res);
    return true;
  }
  if (p === "/avatar/models") {
    if (method === "GET") { await list(m, res); return true; }
    if (method === "POST") { await upload(m, req, res, url); return true; }
    return false;
  }
  if (p.startsWith(MODELS_PREFIX)) {
    const raw = p.slice(MODELS_PREFIX.length);
    if (get) { await serveNamed(m, req, res, raw); return true; }
    if (method === "DELETE") { await remove(m, req, res, raw); return true; }
  }
  return false;
}
