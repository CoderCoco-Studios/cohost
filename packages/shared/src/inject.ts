/**
 * Test injection shared by the services that take `inject.request` (chat, eyes, ears): the upload guard, the
 * bounded upload fetch, the serial queue and the `inject.result` publishing. A service passes its target, the
 * kinds it accepts and its limits; what a kind does with the input stays in the service.
 */
import type { Bus, BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";

// @spec SHARED-INJ-008
/** Requests older than this are answered `stale` (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

// @spec SHARED-INJ-004, SHARED-INJ-008
/**
 * Returns the URL to fetch when it lies under `<dashboardUrl>/uploads/` (same origin, no
 * credentials, normalised path), else undefined. Guards against the bus being used to make a
 * service fetch arbitrary URLs.
 */
export function uploadUrl(raw: string | undefined, dashboardUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const base = new URL(dashboardUrl);
    if (u.origin !== base.origin || u.username || u.password) return undefined;
    const prefix = base.pathname.replace(/\/+$/, "") + "/uploads/";
    return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export type InjectRequest = BusEvent<"inject.request">["data"];
/** What a kind function returns: `ok` defaults to true, `detail` rides on the `inject.result`. */
export type InjectOutcome = { ok?: boolean; detail?: string } | void;
export interface UploadInfo { contentType: string | null }

export interface InjectKinds {
  text?: (req: InjectRequest) => Promise<InjectOutcome> | InjectOutcome;
  image?: (bytes: Buffer, req: InjectRequest, info: UploadInfo) => Promise<InjectOutcome> | InjectOutcome;
  audio?: (bytes: Buffer, req: InjectRequest, info: UploadInfo) => Promise<InjectOutcome> | InjectOutcome;
}

export interface InjectHandlerOptions {
  /** The service the handler answers for; a request for another target is ignored. */
  target: InjectRequest["target"];
  bus: Publisher;
  log: Pick<Logger, "warn" | "info">;
  /** `urls.dashboard()`: the only origin uploads may be fetched from. */
  dashboardUrl: string;
  kinds: InjectKinds;
  /** Byte cap per upload kind (no cap for a kind that is absent). */
  maxBytes: { image?: number; audio?: number };
  /** Abort an upload fetch (headers and body) after this long, ms (default 30000). */
  fetchTimeoutMs?: number;
  staleMs?: number;
  /** Wall clock compared with the publisher's event timestamp. */
  now?: () => number;
  fetch?: typeof fetch;
}

export interface InjectHandler {
  /** The subscription callback: queues the request and returns at once. */
  (ev: BusEvent<"inject.request">): void;
  /** Resolves once every queued request has been answered. */
  drain(): Promise<void>;
}

/** Requests waiting behind the one being processed; one more is answered `busy`. */
const QUEUE_LIMIT = 8;

const isTimeout = (err: unknown): boolean => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** Read a response body, giving up (undefined) as soon as it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    return undefined;
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

// @spec SHARED-INJ-001, SHARED-INJ-002, SHARED-INJ-003, SHARED-INJ-004, SHARED-INJ-005, SHARED-INJ-006, SHARED-INJ-007, SHARED-INJ-009, SHARED-INJ-010, SHARED-INJ-011, SHARED-INJ-012
export function createInjectHandler(o: InjectHandlerOptions): InjectHandler {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const staleMs = o.staleMs ?? INJECT_STALE_MS;
  const timeoutMs = o.fetchTimeoutMs ?? 30_000;
  const queue: BusEvent<"inject.request">[] = [];
  let running: Promise<void> | undefined;

  const result = async (id: string, ok: boolean, detail?: string): Promise<void> => {
    try {
      await o.bus.publish("inject.result", { id, ok, ...(detail ? { detail } : {}) });
    } catch (err) {
      o.log.warn({ err: String(err), id }, "inject.result publish failed");
    }
  };

  async function fetchUpload(target: string, cap: number | undefined): Promise<{ bytes?: Buffer; contentType: string | null } | { fail: string }> {
    // A ref'd timer, not `AbortSignal.timeout`: that one is unref'd, so on Node 22 a fetch that never
    // answers lets the event loop drain before the abort fires. Cleared once headers and body are in.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException("The operation timed out.", "TimeoutError")), timeoutMs);
    try {
      const res = await doFetch(target, { redirect: "error", signal: ctl.signal });
      if (!res.ok) return { fail: `fetch upload ${res.status}` };
      const contentType = res.headers.get("content-type");
      const bytes = cap === undefined ? Buffer.from(await res.arrayBuffer()) : await readCapped(res, cap);
      if (!bytes) return { fail: `upload larger than the ${cap} byte limit` };
      return { bytes, contentType };
    } catch (err) {
      if (!isTimeout(err)) throw err;
      return { fail: `fetch upload timed out after ${timeoutMs} ms` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(ev: BusEvent<"inject.request">): Promise<void> {
    const r = ev.data;
    try {
      if (now() - ev.ts > staleMs) return void (await result(r.id, false, "stale"));
      const kind = r.kind;
      const fn = o.kinds[kind];
      if (!fn) return void (await result(r.id, false, `${o.target} cannot handle kind '${kind}'`));
      let outcome: InjectOutcome;
      if (kind === "text") {
        outcome = await o.kinds.text!(r);
      } else {
        const target = uploadUrl(r.url, o.dashboardUrl);
        if (!target) return void (await result(r.id, false, "url is not an upload of this dashboard"));
        const got = await fetchUpload(target, o.maxBytes[kind]);
        if ("fail" in got) return void (await result(r.id, false, got.fail));
        outcome = await (fn as NonNullable<InjectKinds["image"]>)(got.bytes!, r, { contentType: got.contentType });
      }
      await result(r.id, outcome?.ok ?? true, outcome?.detail);
    } catch (err) {
      o.log.warn({ err: String(err), id: r.id }, `${r.kind} injection failed`);
      await result(r.id, false, String(err));
    }
  }

  let active = false;
  async function pump(): Promise<void> {
    try {
      for (let ev = queue.shift(); ev; ev = queue.shift()) await handle(ev);
    } finally { active = false; } // synchronous with the loop's end, so a request cannot slip in between
  }

  const callback = ((ev: BusEvent<"inject.request">): void => {
    if (ev.data.target !== o.target) return;
    if (queue.length >= QUEUE_LIMIT) { void result(ev.data.id, false, "busy"); return; }
    queue.push(ev);
    if (!active) { active = true; running = pump(); }
  }) as InjectHandler;
  callback.drain = async () => { while (active && running) await running; };
  return callback;
}

/** The slice of `Bus` the inject subscription needs. */
export type InjectBus = Pick<Bus, "resetGroup" | "subscribe">;

export interface SubscribeInjectOptions {
  bus: InjectBus;
  /** The service's consumer group. */
  group: string;
  handler: (ev: BusEvent<"inject.request">) => void | Promise<void>;
  log: Pick<Logger, "error">;
  /** Ends the process on a rejected subscription (default `process.exit`). */
  exit?: (code: number) => void;
}

/**
 * Subscribe `group` to `inject.request` with start mode `latest`. Resolves once the group exists (`resetGroup`
 * creates it at `$`), so the caller can signal `ready` only after the subscription is established; the read loop
 * keeps running in the background and a subscription that rejects is fatal (exit 1).
 */
// @spec SHARED-INJ-009
export async function subscribeInject({ bus, group, handler, log, exit = (c) => process.exit(c) }: SubscribeInjectOptions): Promise<void> {
  await bus.resetGroup(group);
  bus.subscribe({ group, types: ["inject.request"], start: "latest" }, handler).catch((err) => {
    log.error({ err }, "inject.request subscription failed");
    exit(1);
  });
}
