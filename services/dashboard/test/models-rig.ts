// Shared rig for the avatar model store tests (DASH-MDL-*, the applied view): glTF binary fixtures and a running dashboard
// (the real `dashboardService` on `runService`, both listeners, a throwaway data dir and config dir). Everything is
// observed over HTTP and on disk, so the tests name no module of the implementation.
import http from "node:http";
import net from "node:net";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import type { StackService, StackOps } from "../src/stack.js";
import type { ModelStore } from "../src/models.js";
import { dashboardService } from "../src/service.js";
import { configDir as makeConfigDir, configText } from "./config-fixture.js";

export const MiB = 1024 * 1024;
export const TOKEN = "tok";
/**
 * The longest a test waits for an answer or an event that should come at once. It only bounds a failing run: a passing one
 * returns as soon as the event happens, however loaded the machine is.
 */
export const ANSWER_CAP_MS = 15_000;

// ---- glTF binary fixtures ----

export interface GlbOpts {
  /** Bytes of the BIN chunk (zero filled) or its content; none when omitted. */
  bin?: number | Buffer;
  /** Overrides the total length in the header. */
  total?: number;
  magic?: string;
  version?: number;
  /** Overrides the first chunk's type (default JSON). */
  chunkType?: number;
  /** Overrides the JSON chunk's declared length (no bytes are added). */
  jsonLen?: number;
  /** Use this text as the JSON chunk instead of stringifying `json`. */
  rawJson?: string;
}

/** A glTF binary container: 12-byte header, the JSON chunk (padded with spaces to 4), an optional BIN chunk. */
export function glb(json: unknown, o: GlbOpts = {}): Buffer {
  let text = o.rawJson ?? JSON.stringify(json);
  while (Buffer.byteLength(text) % 4) text += " ";
  const jbuf = Buffer.from(text);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(o.jsonLen ?? jbuf.length, 0);
  jh.writeUInt32LE(o.chunkType ?? 0x4e4f534a, 4);
  const parts: Buffer[] = [jh, jbuf];
  if (o.bin !== undefined) {
    const b: Buffer = typeof o.bin === "number" ? Buffer.alloc(o.bin) : o.bin;
    const pad = (4 - (b.length % 4)) % 4;
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(b.length + pad, 0);
    bh.writeUInt32LE(0x004e4942, 4);
    parts.push(bh, b, Buffer.alloc(pad));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write(o.magic ?? "glTF", 0, "latin1");
  head.writeUInt32LE(o.version ?? 2, 4);
  head.writeUInt32LE(o.total ?? 12 + body.length, 8);
  return Buffer.concat([head, body]);
}

const base = (extra: Record<string, unknown> = {}) => ({ asset: { version: "2.0" }, ...extra });

/** A VRM 1.0 model. `meta` and `expressions` are the VRMC_vrm fields; `used`/`required` add to the extension lists. */
export function vrm1(o: { meta?: Record<string, unknown>; expressions?: { preset?: string[]; custom?: string[] }; used?: string[]; required?: string[]; bin?: GlbOpts["bin"]; more?: Record<string, unknown> } = {}): Buffer {
  const ex: Record<string, unknown> = {};
  if (o.expressions) {
    ex["expressions"] = {
      preset: Object.fromEntries((o.expressions.preset ?? []).map((n) => [n, {}])),
      custom: Object.fromEntries((o.expressions.custom ?? []).map((n) => [n, {}])),
    };
  }
  return glb(base({
    extensionsUsed: ["VRMC_vrm", ...(o.used ?? [])],
    ...(o.required ? { extensionsRequired: o.required } : {}),
    extensions: { VRMC_vrm: { specVersion: "1.0", meta: o.meta ?? { name: "Sample", authors: ["Someone"], licenseUrl: "https://example.test/license" }, ...ex } },
    ...o.more,
  }), { bin: o.bin ?? 16 });
}

/** A VRM 0.x model: `groups` are blend shape groups `{name, presetName}`. */
export function vrm0(o: { meta?: Record<string, unknown>; groups?: { name: string; presetName?: string }[]; used?: string[]; bin?: GlbOpts["bin"] } = {}): Buffer {
  return glb(base({
    extensionsUsed: ["VRM", ...(o.used ?? [])],
    extensions: { VRM: { exporterVersion: "x", meta: o.meta ?? { title: "Old", author: "Someone" }, blendShapeMaster: { blendShapeGroups: (o.groups ?? []).map((g) => ({ ...g, binds: [] })) } } },
  }), { bin: o.bin ?? 16 });
}

/** A valid model whose bytes differ by `tag` (so two of them differ in size and content). */
export const model = (tag = "a", bin: GlbOpts["bin"] = 16): Buffer => vrm1({ meta: { name: `Model ${tag}`, authors: [tag] }, bin });

/** A valid model of exactly `bytes` bytes. */
export function modelOfSize(bytes: number): Buffer {
  const probe = model("x", 0).length;
  const bin = bytes - probe; // the probe already holds the (empty) BIN chunk's header; `bytes - probe` is a multiple of 4 in every caller
  if (bin < 0 || bin % 4) throw new Error(`modelOfSize(${bytes}) is not a whole number of chunks`);
  const m = model("x", bin);
  if (m.length !== bytes) throw new Error(`modelOfSize(${bytes}) built ${m.length}`);
  return m;
}

// ---- raw HTTP ----

export interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string; json: () => any }

function finish(status: number, headers: http.IncomingHttpHeaders, body: Buffer): Res {
  return { status, headers, body, text: body.toString("utf8"), json: () => JSON.parse(body.toString("utf8")) };
}

/** An open request whose body is written by the caller; `done` resolves with the response (status 0 if the socket dies first). */
export function open(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { host: `127.0.0.1:${port}`, ...headers };
  const req = http.request({ host: "127.0.0.1", port, method, path, headers: h, setHost: false });
  const done = new Promise<Res>((resolve) => {
    let got = false;
    req.on("response", (res) => {
      got = true;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(finish(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))));
      res.on("close", () => resolve(finish(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))));
      res.on("error", () => resolve(finish(res.statusCode ?? 0, res.headers, Buffer.concat(chunks))));
    });
    req.on("error", () => { if (!got) resolve(finish(0, {}, Buffer.alloc(0))); });
  });
  return {
    req, done,
    write: (b: Buffer | string): boolean => req.write(b),
    end: (b?: Buffer | string): void => { req.end(b); },
    destroy: (): void => { req.destroy(); },
  };
}

/** One whole request. `chunked` sends no Content-Length. */
export async function send(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: Buffer | string; chunked?: boolean } = {}): Promise<Res> {
  const body = typeof o.body === "string" ? Buffer.from(o.body) : o.body;
  const headers = { ...(body && !o.chunked && !o.headers?.["content-length"] ? { "content-length": String(body.length) } : {}), ...o.headers };
  const r = open(port, method, path, headers);
  r.end(body);
  return r.done;
}

export const tick = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---- the running dashboard ----

export class DashBus extends FakeBus {
  stop(): void {}
  async recent(): Promise<never[]> { return []; }
  async tail(_handler: (ev: never) => void): Promise<void> {}
  async tailHealth(): Promise<void> {}
}

const idleStack = (s: StackService): void => {
  const ok = async () => ({ ok: true }) as never;
  const ops: StackOps = { status: async () => ({ docker: { ok: true }, services: [] }), launch: ok, rebuild: ok, stopAll: ok, restartAll: ok, consolidate: ok };
  s.attach(ops);
};

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export interface RigOpts {
  /** CONTROL_ENABLED=1 with CONTROL_TOKEN=tok. */
  control?: boolean;
  /** `renderer.*` of the loaded config and of config.yaml. */
  renderer?: { model?: string; zoom?: number; offset_y?: number; turn?: number };
  /** `dashboard.models.max_bytes`. */
  maxBytes?: number;
  /** Files placed in the model folder before start (this creates the folder). */
  seed?: Record<string, Buffer>;
  /** Whether to create the (empty) model folder before start. */
  folder?: boolean;
  /** Replaces the write of each upload chunk (the disk-full seam of DASH-MDL-029); the rig still counts the chunks it sees. */
  writeChunk?: ModelStore["writeChunk"];
  /** Delays every model listing (widens the race of DASH-AVR-028). */
  pause?: () => Promise<void>;
  /** The bus the dashboard runs on (default a `DashBus`); the relay tests pass one that records and delivers avatar frames. */
  bus?: DashBus;
  /** Extra `dashboardService` dependencies (the relay's clock seam, `uiDir`); spread last. */
  deps?: Record<string, unknown>;
  /** The LAN listener's address (default loopback; `0.0.0.0` lets a test connect from a non-loopback address). */
  lanHost?: string;
}

export interface Rig {
  /** The full-surface and LAN listeners' ports. */
  port: number; lanPort: number;
  /** `<dataDir>`, the model folder, the config directory and config.yaml. */
  data: string; models: string; cfgDir: string; cfgFile: string;
  rec: ReturnType<typeof recordingLog>;
  bus: DashBus;
  auth: Record<string, string>;
  /** Fetch against the full surface / the LAN listener. */
  get: (path: string, headers?: Record<string, string>) => Promise<Res>;
  lan: (method: string, path: string, headers?: Record<string, string>) => Promise<Res>;
  /** `PUT /config/renderer` with the current etag and `values`. */
  save: (values: Record<string, unknown>, o?: { dryRun?: boolean; etag?: string }) => Promise<Res>;
  /** The names in the model folder (empty when it does not exist). */
  ls: () => string[];
  /**
   * Resolves when the next upload writes its first chunk, which is after its temporary file exists. Call it BEFORE sending
   * the bytes that start the upload; the upload's head must be whole in the first 1 KiB sent, so that a chunk is written.
   */
  tempOpened: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Starts the dashboard on a fresh data dir and config dir. Call `stop` (or pass a `t.after`) when done. */
export async function rig(t: { after: (fn: () => unknown) => void }, o: RigOpts = {}): Promise<Rig> {
  const data = mkdtempSync(join(tmpdir(), "cohost-mdl-data-"));
  const models = join(data, "dashboard", "avatar-models");
  if (o.seed || o.folder) {
    mkdirSync(models, { recursive: true });
    for (const [n, b] of Object.entries(o.seed ?? {})) writeFileSync(join(models, n), b);
  }
  const renderer = o.renderer ?? {};
  const cfgDir = makeConfigDir(configText({ renderer }));
  Object.assign(process.env, { COHOST_DATA_DIR: data, CONFIG_DIR: cfgDir, COHOST_ENV_FILE: join(cfgDir, "no.env") });
  const port = await freePort(), lanPort = await freePort();
  const bus = o.bus ?? new DashBus();
  const rec = recordingLog();
  let shutdown: (() => void | Promise<void>) | undefined;
  const env: NodeJS.ProcessEnv = o.control ? { CONTROL_ENABLED: "1", CONTROL_TOKEN: TOKEN } : {};
  // The write seam: the first chunk of each upload's file handle marks that its temporary file exists (see Rig.tempOpened).
  const writeAll = o.writeChunk ?? (async (fh: FileHandle, c: Buffer): Promise<void> => {
    let off = 0;
    while (off < c.length) off += (await fh.write(c, off, c.length - off)).bytesWritten;
  });
  const seen = new WeakSet<FileHandle>();
  const openedWaiters: (() => void)[] = [];
  const writeChunk: ModelStore["writeChunk"] = async (fh, c) => {
    if (!seen.has(fh)) { seen.add(fh); for (const w of openedWaiters.splice(0)) w(); }
    return writeAll(fh, c);
  };
  const tempOpened = (): Promise<void> => new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no upload wrote its first chunk within ${ANSWER_CAP_MS} ms: its temporary file never opened`)), ANSWER_CAP_MS);
    openedWaiters.push(() => { clearTimeout(timer); ok(); });
  });
  const svc = dashboardService({ env, exit: () => {}, lanHost: o.lanHost ?? "127.0.0.1", attachStack: idleStack, writeModelChunk: writeChunk, modelPause: o.pause, ...o.deps } as never);
  await runService({
    service: "dashboard", health: svc.health, main: svc.main,
    loadConfig: () => testConfig({ dashboard: { port, lan_port: lanPort, ...(o.maxBytes ? { models: { max_bytes: o.maxBytes } } : {}) }, renderer }),
    createBus: () => bus as never, log: rec.log, onShutdown: (fn) => { shutdown = fn; }, exit: () => {},
  });
  await waitFor(() => rec.lines.some((l) => String(l.msg).startsWith("dashboard online:")), "dashboard online", 5000);
  const stop = async (): Promise<void> => { await shutdown?.(); };
  t.after(stop);
  const cfgFile = join(cfgDir, "config.yaml");
  const auth: Record<string, string> = o.control ? { authorization: `Bearer ${TOKEN}` } : {};
  return {
    port, lanPort, data, models, cfgDir, cfgFile, rec, bus, auth, stop,
    get: (path, headers) => send(port, "GET", path, { headers }),
    lan: (method, path, headers) => send(lanPort, method, path, { headers }),
    save: async (values, so = {}) => {
      const { createHash } = await import("node:crypto");
      const etag = so.etag ?? createHash("sha256").update(readFileSync(cfgFile, "utf8")).digest("hex");
      return send(port, "PUT", `/config/renderer${so.dryRun ? "?dryRun=1" : ""}`, { headers: auth, body: JSON.stringify({ etag, values }) });
    },
    ls: () => (existsSync(models) ? readdirSync(models).toSorted() : []),
    tempOpened,
  };
}

/** Every string anywhere in a JSON value, flattened (the metadata shapes are checked by their text, see the tests). */
export function texts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(texts);
  if (v && typeof v === "object") return Object.values(v).flatMap(texts);
  return [];
}
