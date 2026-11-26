/**
 * The renderer relay: `/avatar/ws` on both listeners, one frame reader shared by every socket, the per-socket sender with
 * its slots, the state and driver the owner sees, and `GET /avatar/renderer`'s snapshot (DASH-AVR-001 to DASH-AVR-034).
 * Every timed step runs on the injected clock; nothing here reads the wall clock or a timer of its own.
 */
import type { Duplex } from "node:stream";
import type http from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { AvatarFrameSchema, type AvatarFrame, type Bus } from "@cohost/bus";
import { isLoopbackPeer } from "@cohost/control";
import type { Logger } from "@cohost/config";
import type { Applied, AppliedView } from "./applied.js";

/** The one time source of the relay: epoch milliseconds plus timers (tests pass a fake). */
export interface Clock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/** Epoch milliseconds that never step back (`performance.timeOrigin` plus the monotonic `performance.now()`). */
export const systemClock: Clock = {
  now: () => performance.timeOrigin + performance.now(),
  // Unref'd: the listeners keep the process up, and a timer alone must not.
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export type Listener = "full" | "lan";
type Slot = "view" | "status" | "frame";
/** The order a waiting set of slots goes out in: the view and status before a frame (DASH-AVR-013). */
const ORDER: readonly Slot[] = ["view", "status", "frame"];

export const MAX_PAGES = 4;
export const MAX_PREVIEWS = 2;
/** Renderer pages one remote (non-loopback) address may hold across both listeners (DASH-AVR-032). */
export const MAX_PAGES_PER_ADDRESS = 2;
/** A socket that sends more messages than this in one second is closed (DASH-AVR-033). */
export const MESSAGES_PER_SECOND = 20;
/** The largest message a socket may send, enforced by the WebSocket server on every socket (DASH-AVR-030). */
export const MAX_MESSAGE_BYTES = 4096;
const PING_MS = 10_000;
const SILENT_MS = 20_000;
const SEND_TIMEOUT_MS = 5_000;
const RATE_WINDOW_MS = 2_000;
const LIVE_MS = 1_000;
const OFF_MS = 3_000;
const TICK_MS = 1_000;
const DETAIL_MAX = 200;
const WARN_EVERY_MS = 10_000;

export interface Status { state: "live" | "off" | "waiting"; driver: string | null }

interface Sock {
  ws: WebSocket;
  listener: Listener;
  preview: boolean;
  address: string | undefined;
  loopback: boolean;
  since: number;
  lastPong: number;
  /** The last `model` report of a loopback socket: `{state, detail}` (DASH-AVR-016, DASH-AVR-017). */
  model: { state: string; detail: string } | null;
  busy: boolean;
  sendTimer: unknown;
  pingTimer: unknown;
  slots: Partial<Record<Slot, string>>;
  /** Finish times of this socket's `frame` sends (sentFps, DASH-AVR-019). */
  sent: number[];
  /** Arrival times of this socket's messages (the rate limit, DASH-AVR-033). */
  inbound: number[];
}

/** One renderer page or preview as `GET /avatar/renderer` lists it. */
export interface RendererStatus {
  state: Status["state"];
  driver: string | null;
  fps: number | null;
  applied: { model: string | null; configuredModel: string; zoom: number; offsetY: number; turn: number };
  pages: { sentFps: number; model: { state: string; detail: string } | null; since: number }[];
  previews: number;
  maxPages: number;
  maxPreviews: number;
}

export interface RelayDeps {
  bus: Pick<Bus, "tailAvatarFrames">;
  applied: Pick<AppliedView, "get" | "onChange">;
  clock: Clock;
  log: Pick<Logger, "warn">;
}

export interface AvatarRelay {
  /** Completes a `/avatar/ws` upgrade the listener's guards have passed, or answers it 503 when a cap is reached (DASH-AVR-003). */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, listener: Listener): void;
  /** The feed saw an `avatar.state` naming `driver`: its receive time is this clock's now (DASH-AVR-008, DASH-AVR-020). */
  observeState(driver: string): void;
  renderer(): RendererStatus;
  stop(): void;
}

/** The `model` report's keys, exactly (DASH-AVR-016). */
const REPORT_KEYS = ["detail", "state", "type", "version"];
const STATES: ReadonlySet<unknown> = new Set(["loading", "ready", "failed"]);

/** The `model` report of a loopback socket, or undefined for any other shape. `detail` is cut at 200 UTF-16 code units. */
// @spec DASH-AVR-016, DASH-AVR-017
export function parseReport(raw: unknown): { state: string; detail: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o).toSorted();
  if (keys.length !== REPORT_KEYS.length || keys.some((k, i) => k !== REPORT_KEYS[i])) return undefined;
  if (o["type"] !== "model" || typeof o["version"] !== "string" || typeof o["detail"] !== "string" || !STATES.has(o["state"])) return undefined;
  return { state: o["state"] as string, detail: o["detail"].slice(0, DETAIL_MAX) };
}

const RETRY_503 = "HTTP/1.1 503 Service Unavailable\r\nretry-after: 5\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

/**
 * Answers a refused upgrade with `response` and frees the raw socket once it is written. An error on the socket (a reset
 * while the response is written) is absorbed and destroys it, so no refusal can raise an uncaught exception.
 */
// @spec DASH-AVR-002, DASH-AVR-003
export function refuseUpgrade(socket: Duplex, response: string): void {
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end(response);
}

/** A peer address as the caps compare it: lower-cased, with an IPv4-mapped `::ffff:` prefix removed (DASH-AVR-032). */
export function addressKey(addr: string | undefined): string | undefined {
  return addr === undefined ? undefined : addr.toLowerCase().replace(/^::ffff:/, "");
}

/** Drops the timestamps older than the rate window, so a list never grows past the window (DASH-AVR-019). */
function prune(times: number[], t: number): void {
  let i = 0;
  while (i < times.length && t - times[i]! >= RATE_WINDOW_MS) i++;
  if (i > 0) times.splice(0, i);
}

/** The count of the timestamps in the rate window per second, rounded (DASH-AVR-019). */
function rateOf(times: number[], t: number): number {
  prune(times, t);
  return Math.round(times.length / (RATE_WINDOW_MS / 1000));
}

/** The view a socket receives: `model.name` only for a preview (DASH-AVR-006). */
const viewMessage = (preview: boolean, a: Applied): string => JSON.stringify({
  type: "view",
  model: a.model === null ? null : preview ? { version: a.model.version, name: a.model.name } : { version: a.model.version },
  framing: { zoom: a.zoom, offsetY: a.offsetY, turn: a.turn },
});

const statusMessage = (s: Status): string => JSON.stringify({ type: "status", state: s.state, driver: s.driver });

/** The renderer relay (DASH-AVR-001 to DASH-AVR-034). */
// @spec DASH-AVR-001, DASH-AVR-011, DASH-AVR-013, DASH-AVR-021
export function createAvatarRelay(d: RelayDeps): AvatarRelay {
  const { clock } = d;
  const now = (): number => clock.now();
  const socks = new Set<Sock>();
  // `maxPayload` applies to every socket, whatever its address (DASH-AVR-030).
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let stopped = false;
  let stopReaderFn: (() => void) | undefined;
  const frameTimes: number[] = [];
  let latest: AvatarFrame | undefined;
  let lastFrameAt: number | undefined;
  let flushPending = false;
  let avatarState: { driver: string; at: number } | undefined;
  let lastStatus: Status = { state: "waiting", driver: null };
  let lastWarnAt = -Infinity;
  /** Timers that terminate an over-rate socket whose close handshake stalls (DASH-AVR-033). */
  const closing = new Set<unknown>();

  // @spec DASH-AVR-021
  const unsubscribe = d.applied.onChange((snap) => {
    for (const s of socks) offer(s, "view", viewMessage(s.preview, snap));
  });
  // @spec DASH-AVR-009
  const tick = clock.setInterval(evaluate, TICK_MS);

  /** The state of DASH-AVR-008 at this instant. */
  function status(): Status {
    const t = now();
    const recent = avatarState !== undefined && t - avatarState.at <= OFF_MS;
    const driver = recent ? avatarState!.driver : null;
    if (lastFrameAt !== undefined && t - lastFrameAt <= LIVE_MS) return { state: "live", driver };
    if (recent && driver !== "browser") return { state: "off", driver };
    return { state: "waiting", driver };
  }

  // @spec DASH-AVR-009
  function evaluate(): void {
    const s = status();
    if (s.state === lastStatus.state && s.driver === lastStatus.driver) return;
    lastStatus = s;
    const msg = statusMessage(s);
    for (const x of socks) offer(x, "status", msg);
  }

  // @spec DASH-AVR-013
  function offer(s: Sock, slot: Slot, msg: string): void {
    if (stopped || !socks.has(s)) return;
    s.slots[slot] = msg; // newest wins: the slot holds one message
    pump(s);
  }

  function pump(s: Sock): void {
    if (s.busy || !socks.has(s)) return;
    for (const slot of ORDER) {
      const msg = s.slots[slot];
      if (msg === undefined) continue;
      delete s.slots[slot];
      send(s, slot, msg);
      return;
    }
  }

  function send(s: Sock, slot: Slot, msg: string): void {
    s.busy = true;
    s.sendTimer = clock.setTimeout(() => {
      s.sendTimer = undefined;
      // Nothing queued in the socket means the write reached the kernel and only its completion callback is pending: not stuck.
      if (s.ws.bufferedAmount > 0) drop(s);
    }, SEND_TIMEOUT_MS);
    s.ws.send(msg, (err) => {
      if (s.sendTimer !== undefined) clock.clearTimeout(s.sendTimer);
      s.sendTimer = undefined;
      s.busy = false;
      if (!err && slot === "frame") { const t = now(); s.sent.push(t); prune(s.sent, t); }
      pump(s);
    });
  }

  /** Forgets a socket and its timers; the reader stops with the last one (DASH-AVR-011). */
  function cleanup(s: Sock): void {
    if (!socks.delete(s)) return;
    if (s.pingTimer !== undefined) clock.clearInterval(s.pingTimer);
    if (s.sendTimer !== undefined) clock.clearTimeout(s.sendTimer);
    s.pingTimer = undefined;
    s.sendTimer = undefined;
    s.slots = {};
    if (socks.size === 0) stopReader();
  }

  /** Terminates a socket: a stuck send past 5 s, a silent one past 20 s, or a stop. */
  function drop(s: Sock): void {
    cleanup(s);
    s.ws.terminate();
  }

  // @spec DASH-AVR-011, DASH-AVR-020
  function startReader(): void {
    if (stopReaderFn !== undefined || stopped) return;
    stopReaderFn = d.bus.tailAvatarFrames(onFrame);
  }

  function stopReader(): void {
    const f = stopReaderFn;
    stopReaderFn = undefined;
    f?.();
  }

  // @spec DASH-AVR-012, DASH-AVR-034
  function onFrame(frame: AvatarFrame): void {
    const parsed = AvatarFrameSchema.safeParse(frame);
    if (!parsed.success) { warnFrame(parsed.error.issues[0]?.message ?? "invalid"); return; }
    const t = now();
    lastFrameAt = t;
    frameTimes.push(t);
    prune(frameTimes, t);
    latest = parsed.data;
    // A batch is the frames one synchronous turn delivers: the flush after it sends only the newest.
    if (!flushPending) { flushPending = true; queueMicrotask(flush); }
  }

  function flush(): void {
    flushPending = false;
    if (latest === undefined) return;
    const msg = JSON.stringify({ type: "frame", frame: latest });
    for (const s of socks) offer(s, "frame", msg);
  }

  function warnFrame(reason: string): void {
    const t = now();
    if (t - lastWarnAt < WARN_EVERY_MS) return;
    lastWarnAt = t;
    d.log.warn({ reason }, "dropped an avatar frame that fails AvatarFrameSchema");
  }

  // @spec DASH-AVR-033
  function onMessage(s: Sock, data: RawData, isBinary: boolean): void {
    const t = now();
    while (s.inbound.length > 0 && t - s.inbound[0]! >= 1000) s.inbound.shift();
    s.inbound.push(t);
    if (s.inbound.length > MESSAGES_PER_SECOND) {
      cleanup(s);
      s.ws.close(1008, "too many messages");
      const h: unknown = clock.setTimeout(() => { closing.delete(h); s.ws.terminate(); }, 1000);
      closing.add(h);
      return;
    }
    // Only a loopback socket speaks, and only with a model report (DASH-AVR-015, DASH-AVR-016).
    if (isBinary || !s.loopback) return;
    let raw: unknown;
    try { raw = JSON.parse(String(data)); } catch { return; }
    const report = parseReport(raw);
    if (report !== undefined) s.model = report;
  }

  // @spec DASH-AVR-004
  function ping(s: Sock): void {
    if (now() - s.lastPong >= SILENT_MS) { drop(s); return; }
    if (s.ws.readyState === WebSocket.OPEN) s.ws.ping();
  }

  // @spec DASH-AVR-003, DASH-AVR-032
  function refused(preview: boolean, listener: Listener, loopback: boolean, address: string | undefined): boolean {
    const all = [...socks];
    if (preview) return all.filter((s) => s.preview).length >= MAX_PREVIEWS;
    const pages = all.filter((s) => !s.preview);
    if (pages.filter((s) => s.listener === listener).length >= MAX_PAGES) return true;
    return !loopback && pages.filter((s) => !s.loopback && s.address === address).length >= MAX_PAGES_PER_ADDRESS;
  }

  return {
    // @spec DASH-AVR-001, DASH-AVR-002, DASH-AVR-003
    upgrade(req, socket, head, listener) {
      let preview = false;
      try { preview = listener === "full" && new URL(req.url ?? "/", "http://x").searchParams.get("preview") === "1"; } catch { /* no query */ }
      const raw = req.socket.remoteAddress;
      const address = addressKey(raw);
      const loopback = isLoopbackPeer(raw);
      if (stopped || refused(preview, listener, loopback, address)) { refuseUpgrade(socket, RETRY_503); return; }
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, { listener, preview, address, loopback }));
    },

    observeState(driver) {
      avatarState = { driver, at: now() };
    },

    // @spec DASH-AVR-018, DASH-AVR-019
    renderer(): RendererStatus {
      const t = now();
      const st = status();
      const a = d.applied.get();
      const all = [...socks];
      return {
        state: st.state,
        driver: st.driver,
        fps: st.state === "live" ? rateOf(frameTimes, t) : null,
        applied: { model: a.model?.name ?? null, configuredModel: a.configuredModel, zoom: a.zoom, offsetY: a.offsetY, turn: a.turn },
        pages: all.filter((s) => !s.preview).map((s) => ({ sentFps: rateOf(s.sent, t), model: s.model, since: s.since })),
        previews: all.filter((s) => s.preview).length,
        maxPages: MAX_PAGES,
        maxPreviews: MAX_PREVIEWS,
      };
    },

    // @spec DASH-HTTP-010, DASH-HTTP-016
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clock.clearInterval(tick);
      for (const h of closing) clock.clearTimeout(h);
      closing.clear();
      for (const s of [...socks]) drop(s);
      stopReader();
      wss.close();
    },
  };

  /** Completes an admitted upgrade: its socket joins the relay, the reader runs, and it gets the connect pair (DASH-AVR-005). */
  function accept(ws: WebSocket, o: { listener: Listener; preview: boolean; address: string | undefined; loopback: boolean }): void {
    const t = now();
    const s: Sock = {
      ws, ...o, since: t, lastPong: t, model: null, busy: false,
      sendTimer: undefined, pingTimer: undefined, slots: {}, sent: [], inbound: [],
    };
    socks.add(s);
    startReader();
    ws.on("pong", () => { s.lastPong = now(); });
    ws.on("message", (data: RawData, isBinary: boolean) => { if (socks.has(s)) onMessage(s, data, isBinary); });
    ws.on("close", () => cleanup(s));
    ws.on("error", () => cleanup(s));
    s.pingTimer = clock.setInterval(() => { if (socks.has(s)) ping(s); }, PING_MS);
    offer(s, "view", viewMessage(s.preview, d.applied.get()));
    offer(s, "status", statusMessage(status()));
  }
}
