// Shared rig for the renderer relay tests (DASH-AVR-*, DASH-AVP-*, the avatar share of DASH-HOST-002 and DASH-CTRL-005): a
// running dashboard (models-rig) on a bus that records and delivers avatar frames and avatar.state events, a fake clock, and a
// WebSocket test client. Everything is observed over HTTP and on the relay socket, so the tests name no module of the
// implementation; the two seams the implementation owes are declared here and passed as `dashboardService` dependencies:
//
//   clock  the one time source of the relay and of the feed's receive stamp of `avatar.state` (DASH-AVR-008): `now()` in epoch
//          milliseconds, plus setInterval / clearInterval / setTimeout / clearTimeout. Ping, terminate, the 1 s state tick,
//          the 2 s rate windows, the 5 s send timeout and `since` all run on it, so no test waits on wall time.
//   uiDir  the directory the built `avatar.html` is read from (default `locateUiDir()`).
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { event, waitFor } from "@cohost/testing";
import type { AvatarFrame } from "@cohost/bus";
import { DashBus, rig, type Rig, type RigOpts } from "./models-rig.js";

export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

interface Timer { id: number; due: number; every?: number; fn: () => void }

/** Timers that fire only when a test advances the clock; `advance` runs every due callback synchronously, in due order. */
export class FakeClock implements Clock {
  private t = Date.now();
  private seq = 0;
  private timers = new Map<number, Timer>();
  now(): number { return this.t; }
  private add(fn: () => void, ms: number, every?: number): number {
    const id = ++this.seq;
    this.timers.set(id, { id, due: this.t + ms, ...(every === undefined ? {} : { every }), fn });
    return id;
  }
  setInterval(fn: () => void, ms: number): unknown { return this.add(fn, ms, ms); }
  setTimeout(fn: () => void, ms: number): unknown { return this.add(fn, ms); }
  clearInterval(h: unknown): void { this.timers.delete(h as number); }
  clearTimeout(h: unknown): void { this.timers.delete(h as number); }
  /** Moves time forward by `ms`, firing each timer at its due time. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const x of this.timers.values()) if (x.due <= target && (!next || x.due < next.due || (x.due === next.due && x.id < next.id))) next = x;
      if (!next) break;
      this.t = Math.max(this.t, next.due);
      if (next.every === undefined) this.timers.delete(next.id); else next.due += next.every;
      next.fn();
    }
    this.t = target;
  }
  /** Advances to the next firing of a timer of period `every` (the relay's 1 s state tick); the tick has run when this returns. */
  toTick(every = 1000): void {
    let due = Infinity;
    for (const x of this.timers.values()) if (x.every === every && x.due < due) due = x.due;
    if (due === Infinity) throw new Error(`no interval of ${every} ms is registered on the clock`);
    this.advance(Math.max(0, due - this.t));
  }
}

/** A bus that records the relay's frame reader and delivers frames and events to the readers the dashboard started. */
export class RelayBus extends DashBus {
  /** Times the frame reader was started / stopped (the stop function `tailAvatarFrames` returned was called). */
  starts = 0;
  stops = 0;
  /** Calls of `tail` (the feed's one read of the event stream, DASH-AVR-020) and of `recent` (the feed's replay). */
  tails = 0;
  recents = 0;
  private reader?: (f: AvatarFrame, id: string) => void;
  private feed?: (ev: ReturnType<typeof event>) => void;
  private waiters: { want: () => boolean; resolve: () => void }[] = [];
  private seq = 0;

  tailAvatarFrames(handler: (f: AvatarFrame, id: string) => void): () => void {
    this.starts++;
    this.reader = handler;
    this.notify();
    return () => { if (this.reader === handler) this.reader = undefined; this.stops++; this.notify(); };
  }
  async tail(handler: (ev: never) => void): Promise<void> { this.tails++; this.feed = handler as never; }
  async recent(): Promise<never[]> { this.recents++; return []; }

  private notify(): void {
    this.waiters = this.waiters.filter((w) => { if (w.want()) { w.resolve(); return false; } return true; });
  }
  /** Resolves when `want()` holds, checked on each reader start and stop. */
  until(want: () => boolean): Promise<void> {
    return want() ? Promise.resolve() : new Promise<void>((resolve) => { this.waiters.push({ want, resolve }); });
  }
  get reading(): boolean { return this.reader !== undefined; }

  /** Delivers `frames` to the reader synchronously, as one batch (the real reader loops over one read's rows the same way). */
  batch(...frames: Partial<AvatarFrame>[]): void {
    if (!this.reader) throw new Error("no frame reader is running");
    for (const f of frames) this.reader(frame(f), `${Date.now()}-${++this.seq}`);
  }
  /** An `avatar.state` event as the feed's tail receives it; `ts` defaults to an hour ago (the receive time is what counts). */
  state(driver: string, ts = Date.now() - 3_600_000): void {
    if (!this.feed) throw new Error("the feed is not tailing");
    const ev = event("avatar.state", { emotion: "neutral", intensity: 0, mouthOpen: 0, mouthSmile: 0.15, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, driver, connected: true }, "avatar");
    this.feed({ ...ev, ts });
  }
}

export const frame = (o: Partial<AvatarFrame> = {}): AvatarFrame => ({
  mouthOpen: 0, mouthSmile: 0.15, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, emotion: "neutral", intensity: 0, expression: "", ...o,
});

type Msg = { type: string; [k: string]: unknown };

/** A relay client: every text message it receives is queued in order and read with `next`; `waitFor` conditions fail only on a hung test. */
export class Client {
  readonly msgs: Msg[] = [];
  private cursor = 0;
  private wake?: () => void;
  closed = false;
  closeCode?: number;
  pings = 0;
  constructor(readonly ws: WebSocket) {
    ws.on("message", (d, binary) => { if (!binary) this.msgs.push(JSON.parse(String(d))); this.wake?.(); });
    ws.on("close", (code) => { this.closed = true; this.closeCode = code; this.wake?.(); });
    ws.on("ping", () => { this.pings++; this.wake?.(); });
  }
  /** The next message, or the first later one for which `pred` holds (earlier ones are returned through `skipped`). */
  async next(pred: (m: Msg) => boolean = () => true, skipped: Msg[] = []): Promise<Msg> {
    for (;;) {
      while (this.cursor < this.msgs.length) {
        const m = this.msgs[this.cursor++]!;
        if (pred(m)) return m;
        skipped.push(m);
      }
      if (this.closed) throw new Error("the socket closed while waiting for a message");
      await new Promise<void>((r) => { this.wake = r; });
    }
  }
  /** Resolves when `cond()` holds, re-checked on each message, ping and close of this socket. */
  async until(cond: () => boolean): Promise<void> {
    while (!cond()) await new Promise<void>((r) => { this.wake = r; });
  }
  /** Messages already received and not yet read. */
  drain(): Msg[] { const out = this.msgs.slice(this.cursor); this.cursor = this.msgs.length; return out; }
  /** The connect pair: `view` then `status`, in that order and nothing else before them. */
  async hello(): Promise<{ view: Msg; status: Msg }> {
    const view = await this.next(), status = await this.next();
    if (view.type !== "view" || status.type !== "status") throw new Error(`connect sent ${view.type}, ${status.type}`);
    return { view, status };
  }
  /** Returns once the server has handled every frame this client sent before (it answers a ping after handling earlier messages). */
  async barrier(): Promise<void> { const p = once(this.ws, "pong"); this.ws.ping(); await p; }
  send(v: unknown): void { this.ws.send(typeof v === "string" ? v : JSON.stringify(v)); }
  close(): Promise<void> { if (this.closed) return Promise.resolve(); this.ws.close(); return once(this.ws, "close").then(() => undefined); }
}

export type Upgrade = { result: "open"; client: Client } | { result: number; headers: Record<string, string | string[] | undefined> };

/** Opens `/avatar/ws`: "open" with the client, or the refusing HTTP status. */
export function connect(port: number, o: { preview?: boolean; headers?: Record<string, string>; host?: string; autoPong?: boolean } = {}): Promise<Upgrade> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${o.host ?? "127.0.0.1"}:${port}/avatar/ws${o.preview ? "?preview=1" : ""}`, { headers: o.headers, autoPong: o.autoPong ?? true });
    ws.on("open", () => resolve({ result: "open", client: new Client(ws) }));
    ws.on("unexpected-response", (_req, res) => { res.resume(); resolve({ result: res.statusCode ?? 0, headers: res.headers }); });
    ws.on("error", (e) => { if (!/Unexpected server response/.test(String(e))) reject(e); });
  });
}

/** An open client that has read its connect pair. */
export async function join_(port: number, o: Parameters<typeof connect>[1] = {}): Promise<Client> {
  const u = await connect(port, o);
  if (u.result !== "open") throw new Error(`upgrade refused: ${u.result}`);
  await u.client.hello();
  return u.client;
}

export interface Relay extends Rig {
  clock: FakeClock;
  bus: RelayBus;
  /** `GET /avatar/renderer` on the full surface. */
  renderer: () => Promise<any>;
  /** Saves `renderer.zoom` and returns the `view` every open client then receives; also a barrier for what was sent before it. */
  zoom: (z: number) => Promise<void>;
}

/** The dashboard on a `RelayBus` and a `FakeClock`. */
export async function relay(t: { after: (fn: () => unknown) => void }, o: RigOpts & { uiDir?: string } = {}): Promise<Relay> {
  const clock = new FakeClock();
  const bus = new RelayBus();
  const { uiDir, ...rest } = o;
  const r = await rig(t, { ...rest, bus, deps: { clock, ...(uiDir ? { uiDir } : {}), ...o.deps } });
  return {
    ...r, clock, bus,
    renderer: async () => (await r.get("/avatar/renderer")).json(),
    zoom: async (z) => { const x = await r.save({ zoom: z }); if (x.status !== 200) throw new Error(`save answered ${x.status}: ${x.text}`); },
  };
}

/** A directory for a fake `dist-ui`. */
export const tmpUi = (): string => mkdtempSync(join(tmpdir(), "cohost-avatar-ui-"));

/** The address of a non-loopback IPv4 interface of this machine, or undefined (the tests that need a non-loopback peer skip then). */
export function externalAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return undefined;
}

/** Resolves when the async condition holds; the only bound is the timeout that fails a hung test. */
export async function eventually(cond: () => Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const t0 = performance.now();
  while (!(await cond())) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export { waitFor };
