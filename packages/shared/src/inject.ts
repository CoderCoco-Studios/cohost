/**
 * Test injection shared by the services that take `inject.request` (chat, eyes, ears): the upload read from
 * Redis, the serial queue and the `inject.result` publishing. A service passes its target, the
 * kinds it accepts and its limits; what a kind does with the input stays in the service.
 */
import type { Bus, BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";

// @spec SHARED-INJ-008
/** Requests older than this are answered `stale` (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

/** An upload id as the dashboard mints it: 128 random bits, lowercase hex. */
const UPLOAD_ID = /^[0-9a-f]{32}$/;

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
  /** `Bus.takeUpload` of the service's bus: read and delete the upload's bytes, `null` when missing or expired. */
  takeUpload?: (id: string) => Promise<Buffer | null>;
  kinds: InjectKinds;
  /** Byte cap per upload kind (no cap for a kind that is absent). */
  maxBytes: { image?: number; audio?: number };
  /** Give up reading an upload from Redis after this long, ms (default 30000). */
  readTimeoutMs?: number;
  staleMs?: number;
  /** Wall clock compared with the publisher's event timestamp. */
  now?: () => number;
}

export interface InjectHandler {
  /** The subscription callback: queues the request and returns at once. */
  (ev: BusEvent<"inject.request">): void;
  /** Resolves once every queued request has been answered. */
  drain(): Promise<void>;
}

/** Requests waiting behind the one being processed; one more is answered `busy`. */
export const INJECT_QUEUE_LIMIT = 8;
const QUEUE_LIMIT = INJECT_QUEUE_LIMIT;

// @spec SHARED-INJ-001, SHARED-INJ-002, SHARED-INJ-003, SHARED-INJ-004, SHARED-INJ-005, SHARED-INJ-006, SHARED-INJ-007, SHARED-INJ-009, SHARED-INJ-010, SHARED-INJ-011, SHARED-INJ-012, SHARED-INJ-013
export function createInjectHandler(o: InjectHandlerOptions): InjectHandler {
  const now = o.now ?? Date.now;
  const staleMs = o.staleMs ?? INJECT_STALE_MS;
  const timeoutMs = o.readTimeoutMs ?? 30_000;
  const queue: BusEvent<"inject.request">[] = [];
  let running: Promise<void> | undefined;

  const result = async (id: string, ok: boolean, detail?: string): Promise<void> => {
    try {
      await o.bus.publish("inject.result", { id, ok, ...(detail ? { detail } : {}) });
    } catch (err) {
      o.log.warn({ err: String(err), id }, "inject.result publish failed");
    }
  };

  /** Takes the upload (deleting its key), bounded by the read timeout and the kind's byte cap. */
  async function readUpload(id: string, cap: number | undefined): Promise<{ bytes: Buffer } | { fail: string }> {
    // A ref'd timer: it keeps the loop alive until the read settles or the timeout fires.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    try {
      const got = await Promise.race([o.takeUpload!(id), timedOut]);
      if (got === "timeout") return { fail: `read upload timed out after ${timeoutMs} ms` };
      if (!got) return { fail: "upload expired or missing" };
      if (cap !== undefined && got.length > cap) return { fail: `upload larger than the ${cap} byte limit` };
      return { bytes: got };
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
        if (!r.uploadId || !UPLOAD_ID.test(r.uploadId)) return void (await result(r.id, false, "request carries no upload id"));
        if (!o.takeUpload) return void (await result(r.id, false, `${o.target} has no upload store`));
        const got = await readUpload(r.uploadId, o.maxBytes[kind]);
        if ("fail" in got) return void (await result(r.id, false, got.fail));
        outcome = await (fn as NonNullable<InjectKinds["image"]>)(got.bytes, r, { contentType: r.contentType ?? null });
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
