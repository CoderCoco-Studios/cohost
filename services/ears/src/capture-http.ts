import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "@cohost/config";
import { INJECT_QUEUE_LIMIT } from "@cohost/shared";
import { ClipError, decodeClip, type CaptureAdapter, type HearClip } from "./capture.js";
import { INJECT_READ_TIMEOUT_MS, INJECT_MAX_BYTES } from "./inject.js";

export interface HttpCaptureOptions {
  host: string;
  /** 0 picks a free port (read it from `HttpCapture.port` once started). */
  port: number;
  hear: HearClip;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** Largest accepted body (default `INJECT_MAX_BYTES`, the shared inject cap). */
  maxBytes?: number;
  /** Requests allowed to wait behind the one being processed (default `INJECT_QUEUE_LIMIT`). */
  queueLimit?: number;
  /** Time a body may take to arrive (default `INJECT_READ_TIMEOUT_MS`). */
  bodyTimeoutMs?: number;
}

export interface HttpCapture extends CaptureAdapter {
  /** The bound port; 0 until `start` resolves. */
  readonly port: number;
}

type Body = { ok: true; buf: Buffer } | { ok: false; why: "too-large" | "timeout" | "aborted" };

/** Reads a request body, giving up as soon as it passes `max` bytes, takes longer than `timeoutMs`, or the client goes away. */
function readBody(req: IncomingMessage, max: number, timeoutMs: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const done = (b: Body): void => {
      clearTimeout(timer);
      req.off("data", onData);
      resolve(b);
    };
    const timer = setTimeout(() => done({ ok: false, why: "timeout" }), timeoutMs);
    const onData = (c: Buffer): void => {
      total += c.length;
      if (total > max) done({ ok: false, why: "too-large" });
      else chunks.push(c);
    };
    req.on("data", onData);
    req.once("end", () => done({ ok: true, buf: Buffer.concat(chunks) }));
    req.once("error", () => done({ ok: false, why: "aborted" }));
    req.once("close", () => { if (!req.complete) done({ ok: false, why: "aborted" }); });
  });
}

// @spec EARS-CAP-005, EARS-CAP-006, EARS-CAP-007, EARS-CAP-012
/**
 * The `http` capture source: `POST /audio` carries one clip (WAV, or raw 16-bit PCM with `rate` and `channels`
 * parameters) and is answered once the clip has been through the `Hearing` path. Clips run one at a time; the body size,
 * body time and queue length are bounded by the shared inject limits.
 */
export function createHttpCapture(o: HttpCaptureOptions): HttpCapture {
  const maxBytes = o.maxBytes ?? INJECT_MAX_BYTES;
  const queueLimit = o.queueLimit ?? INJECT_QUEUE_LIMIT;
  const bodyTimeoutMs = o.bodyTimeoutMs ?? INJECT_READ_TIMEOUT_MS;
  let tail: Promise<unknown> = Promise.resolve();
  /** Accepted requests not yet answered: the one being processed plus those waiting (or still sending their body). */
  let inflight = 0;

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn, fn);
    tail = p.catch(() => undefined);
    return p;
  };

  const reply = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json", connection: "close", ...headers });
    res.end(JSON.stringify(body));
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/audio") return reply(res, 404, { error: "not found" });
    if (req.method !== "POST") return reply(res, 405, { error: "POST only" }, { allow: "POST" });
    if (inflight > queueLimit) return reply(res, 503, { error: "busy" });
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) return reply(res, 413, { error: `body over ${maxBytes} bytes` });
    inflight++;
    try {
      const body = await readBody(req, maxBytes, bodyTimeoutMs);
      if (!body.ok) {
        if (body.why === "too-large") return reply(res, 413, { error: `body over ${maxBytes} bytes` });
        if (body.why === "timeout") return reply(res, 408, { error: "body too slow" });
        return;
      }
      let clip;
      try {
        clip = decodeClip(body.buf, String(req.headers["content-type"] ?? ""));
      } catch (err) {
        if (err instanceof ClipError) return reply(res, err.code === "unsupported-type" ? 415 : 400, { error: err.message });
        throw err;
      }
      const speaker = url.searchParams.get("speaker")?.trim() || "http";
      const outcome = await serial(() => o.hear(clip, speaker));
      if (outcome.heard) return reply(res, 200, { heard: true, text: outcome.text });
      return reply(res, outcome.reason === "stt-error" ? 502 : 200, { heard: false, reason: outcome.reason });
    } finally {
      inflight--;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      o.log.error({ err: String(err) }, "ears http capture failed");
      if (!res.headersSent) reply(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  let listening = false;

  return {
    name: "http",
    get port() { return (server.address() as AddressInfo | null)?.port ?? 0; },
    status: () => (listening ? "ok" : "down"),
    start: () => new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => { listening = false; reject(err); };
      server.once("error", onError);
      server.listen(o.port, o.host, () => {
        server.off("error", onError);
        server.on("error", (err) => o.log.error({ err: String(err) }, "ears http listener error"));
        listening = true;
        o.log.info({ host: o.host, port: (server.address() as AddressInfo).port }, "ears http listening: POST /audio");
        resolve();
      });
    }),
    async stop() {
      listening = false;
      const closed = server.listening ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
      server.closeIdleConnections();
      await tail;
      await closed;
    },
  };
}
