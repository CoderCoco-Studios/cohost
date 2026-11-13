/**
 * The `http` output: POSTs each line's WAV to a configured URL. The line is claimed and released like any sink (timed.ts), and
 * the delivery runs behind it from a bounded queue, with a per-attempt timeout and the shared `retryWithBackoff`, so a slow or
 * down endpoint never delays the co-host.
 */
import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { retryWithBackoff } from "@cohost/shared";
import type { Playback } from "./playback.js";
import type { MouthOutput } from "./session.js";
import { createTimedPlayback } from "./timed.js";

/** The `http` output's name, which is also its sink name (MOUTH-ROUTE-001). */
export const HTTP = "http";

/** One delivery attempt: resolves with the response status, rejects on a network error or when `signal` aborts. */
export type HttpPost = (url: string, init: { headers: Record<string, string>; body: Buffer; signal: AbortSignal }) => Promise<{ status: number }>;

const fetchPost: HttpPost = async (url, init) => {
  const res = await fetch(url, { method: "POST", headers: init.headers, body: new Uint8Array(init.body), signal: init.signal });
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status };
};

export interface HttpOutputDeps {
  bus: Publisher;
  log: Logger;
  /** `mouth.outputs.http.url`; empty leaves the output down. */
  url: string;
  timeoutMs: number;
  retries: number;
  maxQueue: number;
  fetchAudio?: (url: string) => Promise<Buffer>;
  /** Replacements for tests. */
  post?: HttpPost;
  backoff?: { baseMs: number; maxMs: number; sleep?: (ms: number) => Promise<void> };
}

export interface HttpOutput extends MouthOutput {
  playback: Playback;
  close(): void;
}

// @spec MOUTH-HTTP-001, MOUTH-HTTP-002, MOUTH-HTTP-003, MOUTH-HTTP-004, MOUTH-HTTP-005, MOUTH-HTTP-006
export function createHttpOutput({ bus, log, url, timeoutMs, retries, maxQueue, fetchAudio, post = fetchPost, backoff = { baseMs: 250, maxMs: 5000 } }: HttpOutputDeps): HttpOutput {
  if (url === "") log.error("mouth.outputs.http.url is not set: the http output is down and skips every line");

  const queue: { id: string; wav: Buffer }[] = [];
  const stop = new AbortController();
  let draining = false;

  /** One line: attempt, then retry with backoff until it is delivered, the retries run out (dropped) or the output closes. */
  async function deliver(item: { id: string; wav: Buffer }): Promise<void> {
    let attempts = 0;
    try {
      await retryWithBackoff(async () => {
        attempts++;
        const { status } = await post(url, {
          headers: { "content-type": "audio/wav", "x-cohost-utterance-id": item.id },
          body: item.wav,
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stop.signal]),
        });
        if (status < 200 || status > 299) throw new Error(`http ${status}`);
      }, {
        ...backoff,
        isStopped: () => stop.signal.aborted,
        isFatal: () => attempts > retries && !stop.signal.aborted,
        onFailure: (err, n) => log.warn({ err: String(err), id: item.id, attempt: n }, "http output: delivery attempt failed"),
      });
    } catch (err) {
      log.warn({ err: String(err), id: item.id }, "http output: dropped undelivered line");
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!stop.signal.aborted && queue.length > 0) await deliver(queue.shift()!);
    } finally {
      draining = false;
    }
  }

  const timed = createTimedPlayback({
    bus, log, sink: HTTP, fetchAudio,
    deliver: (wav, id) => {
      if (queue.length >= maxQueue) {
        const dropped = queue.shift()!;
        log.warn({ id: dropped.id }, "http output: queue full, dropped oldest undelivered line");
      }
      queue.push({ id, wav });
      void drain();
    },
  });

  return {
    name: HTTP,
    isReady: () => url !== "",
    playback: timed.playback,
    stop: (o) => timed.playback.stop(o),
    close() {
      stop.abort();
      queue.length = 0;
      timed.close();
    },
  };
}
