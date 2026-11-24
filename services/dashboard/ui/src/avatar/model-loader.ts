// The model load state machine (DASH-AVP-023 to DASH-AVP-029). Generic in the model it builds, so the UI tests drive it
// with a fake in place of the glTF loader. No DOM and no 3D-library import: the page passes the platform calls in.

import { etagMatches } from "./etag";

/** A fetch that delivers no byte for this long is aborted and reported failed (DASH-AVP-027). */
export const IDLE_TIMEOUT_MS = 30_000;
/** The longest failure detail the relay gets, in code points (DASH-AVP-023). */
const DETAIL_MAX = 200;

/** One report to the relay: the version it concerns, the state and a detail of at most 200 code points. */
export interface ModelReport { version: string; state: "loading" | "ready" | "failed"; detail: string }

/** What to load: the URL to fetch and the version the relay or the preview named for it. */
export interface LoadTarget { url: string; version: string }

export interface ModelLoaderDeps<M> {
  fetchModel(url: string, opts: { signal: AbortSignal; bypassCache: boolean }): Promise<Response>;
  /** Builds the model from the fetched bytes; must throw when the signal is aborted before it returns. */
  build(bytes: ArrayBuffer, signal: AbortSignal): Promise<M>;
  dispose(model: M): void;
  report(r: ModelReport): void;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export interface ModelLoader<M> {
  /** Starts loading the target unless it is already held; a different one in flight is aborted. */
  request(target: LoadTarget): void;
  /** Disposes the held model, aborts a load in flight and draws no model (DASH-AVP-028). */
  clear(): void;
  current(): M | null;
  heldVersion(): string | null;
  loadingVersion(): string | null;
}

interface Job {
  version: string;
  controller: AbortController;
  timer: number | undefined;
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  done: boolean;
}

const cut = (s: string): string => Array.from(s).slice(0, DETAIL_MAX).join("");
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The load state machine. Only the newest request may finish: a request for another version aborts the fetch in flight,
 * and a half-built model that the newer request supersedes is disposed. The held model is replaced, and disposed, only
 * when the new one is ready, so a change never shows an empty frame. A response whose etag does not name the version is
 * fetched once more bypassing the cache, and that answer is used whatever it names.
 */
// @spec DASH-AVP-023, DASH-AVP-024, DASH-AVP-025
export function createModelLoader<M>(deps: ModelLoaderDeps<M>): ModelLoader<M> {
  let held: { model: M; version: string } | null = null;
  let active: Job | null = null;

  const current = (job: Job): boolean => active === job && !job.done;

  const disarm = (job: Job): void => {
    deps.clearTimeout(job.timer);
    job.timer = undefined;
  };

  const abortActive = (): void => {
    const job = active;
    if (job === null) return;
    job.done = true;
    disarm(job);
    active = null;
    job.controller.abort();
    job.reader?.cancel().catch(() => undefined);
  };

  const finish = (job: Job): void => {
    job.done = true;
    disarm(job);
    if (active === job) active = null;
  };

  const failJob = (job: Job, detail: string): void => {
    if (!current(job)) return;
    finish(job);
    deps.report({ version: job.version, state: "failed", detail: cut(detail) });
  };

  const armIdle = (job: Job): void => {
    disarm(job);
    job.timer = deps.setTimeout(() => {
      if (!current(job)) return;
      failJob(job, `no data for ${IDLE_TIMEOUT_MS / 1000} s; the fetch timed out`);
      job.controller.abort();
      job.reader?.cancel().catch(() => undefined);
    }, IDLE_TIMEOUT_MS);
  };

  /** Reads the body, restarting the idle clock on every chunk; resolves with the bytes or rejects when superseded. */
  const readBody = async (job: Job, res: Response): Promise<ArrayBuffer> => {
    if (res.body === null) return res.arrayBuffer();
    const reader = res.body.getReader();
    job.reader = reader;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (!current(job)) throw new Error("superseded");
      if (done) break;
      armIdle(job);
      chunks.push(value);
      total += value.byteLength;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out.buffer;
  };

  const run = async (job: Job, url: string, bypassCache: boolean): Promise<void> => {
    armIdle(job);
    let res: Response;
    try {
      res = await deps.fetchModel(url, { signal: job.controller.signal, bypassCache });
    } catch (e) {
      failJob(job, errorText(e));
      return;
    }
    if (!current(job)) return;
    if (!res.ok) {
      failJob(job, `HTTP ${res.status}`);
      return;
    }
    if (!bypassCache && !etagMatches(res.headers.get("etag"), job.version)) {
      res.body?.cancel().catch(() => undefined);
      return run(job, url, true);
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await readBody(job, res);
    } catch (e) {
      if (current(job)) failJob(job, errorText(e));
      return;
    }
    if (!current(job)) return;
    let model: M;
    try {
      model = await deps.build(bytes, job.controller.signal);
    } catch (e) {
      if (current(job)) failJob(job, errorText(e));
      return;
    }
    if (!current(job)) {
      deps.dispose(model);
      return;
    }
    finish(job);
    const old = held;
    held = { model, version: job.version };
    deps.report({ version: job.version, state: "ready", detail: "" });
    if (old !== null) deps.dispose(old.model);
  };

  return {
    request(target) {
      if (active !== null && active.version === target.version) return;
      if (active === null && held !== null && held.version === target.version) return;
      abortActive();
      if (held !== null && held.version === target.version) return;
      const job: Job = { version: target.version, controller: new AbortController(), timer: undefined, reader: undefined, done: false };
      active = job;
      deps.report({ version: target.version, state: "loading", detail: "" });
      void run(job, target.url, false);
    },
    clear() {
      abortActive();
      const old = held;
      held = null;
      if (old !== null) deps.dispose(old.model);
    },
    current: () => (held === null ? null : held.model),
    heldVersion: () => (held === null ? null : held.version),
    loadingVersion: () => (active === null ? null : active.version),
  };
}
