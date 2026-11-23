/**
 * Shared rig for the endpointing (EARS-VAD-*), partial-transcript (EARS-PART-*), engine (EARS-ENG-*) and session (EARS-SES-*)
 * tests: the real ears service on a fake bus, a scripted speech-activity detector, a scripted batch speech-to-text endpoint
 * and a scripted streaming engine. No model, no network.
 *
 * Test seams the code phase must provide (the specs name none):
 *  - `createEarsService({ loadVad })`: `loadVad()` loads the detector once when a connector source starts (a rejection is
 *    EARS-VAD-006) and resolves to a factory; the service calls the factory once per speaker id (EARS-VAD-007) to get a
 *    `SpeechDetector` whose `probability(pcm)` is the speech probability of one 16 kHz mono s16le frame.
 *  - Batch speech-to-text is reached only through `fetch` on a `.../audio/transcriptions` route (`<STT_URL>/v1/...` for
 *    `speaches`, `<ears.openai.base_url>/...` for `openai`; EARS-HEAR-005, EARS-ENG-006), which the rig replaces on
 *    `globalThis`; partials and finals share it.
 *  - Streaming speech-to-text (EARS-ENG-001, EARS-SES-*): `createEarsService({ streamingEngine })` hands the service the
 *    `StreamingSttEngine` to use when `ears.stt_engine` is `nemotron` or `kyutai` (the real adapters are #188); `fakeStreaming`
 *    below is a scripted one. `createEarsService({ pingIntervalMs })` sets the re-probe period of EARS-HLTH-008 (default
 *    `STT_PING_INTERVAL_MS`, 10 s) so a test need not wait 10 s.
 */
import { ConnectorFakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService, wavWrap, type Heartbeat } from "@cohost/shared";
import type { Frame } from "@cohost/bus";
import { createEarsService, type EarsServiceOptions } from "../src/service.js";
import { wavDurationMs } from "../src/audio.js";
import type { StreamingSttEngine, SttSession } from "../src/engines.js"; // types only: erased at run time

export interface SpeechDetector { probability(pcm: Buffer): number | Promise<number> }
export type LoadVad = () => Promise<() => SpeechDetector>;
type Options = EarsServiceOptions & { loadVad?: LoadVad; streamingEngine?: StreamingSttEngine; pingIntervalMs?: number };

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const connectorOffer = [{ cap: "audio-in" as const, tag: "discord", format: { rate: 16000, channels: 1 }, ready: true, transport: "stream" as const }];

/** A detector scripted by the first byte of each frame: probability = byte / 100 (fill 80 is speech, fill 10 is silence at 0.5). */
export function fakeVad(over: { reject?: Error } = {}) {
  const state = { created: 0 };
  const load: LoadVad = async () => {
    if (over.reject) throw over.reject;
    return () => { state.created++; return { probability: (pcm) => (pcm[0] ?? 0) / 100 }; };
  };
  return { load, state };
}

let seq = 0;
export const resetSeq = () => { seq = 0; };
/** One 16 kHz mono frame of `ms` ms whose bytes are all `fill` (see `fakeVad`). */
export const frame = (spk: string, fill: number, ms = 20, skip = 0): Frame => { seq += skip; return { epoch: 1, seq: seq++, rate: 16000, ch: 1, pcm: Buffer.alloc((ms / 1000) * 16000 * 2, fill), spk, name: spk.toUpperCase() }; };
export const SPEECH = 80;
export const SILENCE = 10;

type Sub = { opts: { group: string; types: readonly string[]; start?: string }; handler: (ev: never) => Promise<void> };
const UPLOAD = "0123456789abcdef0123456789abcdef";

export async function boot(ears: Record<string, unknown>, o: { setup?: (bus: ConnectorFakeBus) => void; loadVad?: LoadVad; streaming?: StreamingSttEngine; pingIntervalMs?: number } = {}) {
  const subs: Sub[] = [];
  const bus = Object.assign(new ConnectorFakeBus(), { resetGroup: async () => {}, subscribe: (opts: Sub["opts"], handler: Sub["handler"]) => { subs.push({ opts, handler }); return new Promise<void>(() => {}); } });
  o.setup?.(bus);
  const log = recordingLog();
  const svc = createEarsService({
    registryIntervalMs: 20, refreshMs: 20, ...(o.loadVad ? { loadVad: o.loadVad } : {}),
    ...(o.streaming ? { streamingEngine: o.streaming } : {}), ...(o.pingIntervalMs ? { pingIntervalMs: o.pingIntervalMs } : {}),
  } as Options);
  let shutdown: (() => void | Promise<void>) | undefined;
  let hb: Heartbeat | undefined;
  await runService({
    service: "ears", health: svc.health,
    main: async (ctx) => { hb = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => testConfig({ ears }),
    createBus: () => bus as never,
    onShutdown: (fn) => { shutdown = fn; },
    exit: () => {}, log: log.log,
  });
  const deliver = async (ev: unknown) => { for (const s of subs) if (s.opts.types.includes((ev as { type: string }).type)) await s.handler(ev as never); };
  return {
    bus, log,
    heard: () => bus.of("speech.heard") as unknown as { speaker: string; speakerId?: string; source?: string; text: string; durationMs: number; utteranceId?: string; timing?: { audioEndedAt?: number } }[],
    partials: () => bus.of("speech.partial" as never) as unknown as { speaker: string; speakerId?: string; source: string; text: string; seq: number; utteranceId: string; timing?: { audioEndedAt?: number } }[],
    lastHeartbeat: () => bus.health.at(-1),
    /** Deliver an event to the handler the service subscribed (`inject.request`, `voice.playing`). */
    deliver,
    /** Inject a `ms` ms WAV (EARS-INJ-*) and return the `inject.result` it produced. */
    inject: async (id = "a1", ms = 1000) => {
      bus.uploads.set(UPLOAD, { bytes: wavWrap(Buffer.alloc((ms / 1000) * 32000), 16000, 1), ttlMs: 1000 });
      await deliver({ type: "inject.request", id: `i-${id}`, ts: Date.now(), source: "test", data: { id, target: "ears", kind: "audio", uploadId: UPLOAD, contentType: "audio/wav", remember: false } });
      await waitFor(() => (bus.of("inject.result") as unknown as { id: string }[]).some((x) => x.id === id), "inject.result");
      return (bus.of("inject.result") as unknown as { id: string; ok: boolean; detail?: string }[]).find((x) => x.id === id)!;
    },
    stop: async () => { await shutdown?.(); await hb?.stop(); },
  };
}

/** Feed `n` frames of one speaker, `gapMs` apart; returns when the first and last were fed. */
export async function feed(bus: ConnectorFakeBus, n: number, o: { spk?: string; fill?: number; gapMs?: number } = {}) {
  const first = Date.now();
  for (let i = 0; i < n; i++) { bus.feed("in", "discord", frame(o.spk ?? "u1", o.fill ?? SPEECH)); if (o.gapMs) await sleep(o.gapMs); }
  return { first, last: Date.now() };
}

export interface SttCall { n: number; ms: number; startedAt: number; fields: Record<string, string>; url: string; auth?: string }
/** Throw from a `fakeStt` answer to make the endpoint reply with this status instead of the default 500. */
export class SttStatus extends Error { constructor(readonly status: number, body = `status ${status}`) { super(body); } }
/**
 * Replace `fetch` for the STT endpoint: `answer` gets the call (n counts from 0 in start order, ms is the WAV's duration)
 * and returns the text, after any delay it wants; a throw is a 500 (or the status of a thrown `SttStatus`), a promise that
 * never settles is a server that never answers. Returns the calls made and a restore function.
 */
export function fakeStt(answer: (c: SttCall) => string | Promise<string>) {
  const calls: SttCall[] = [];
  let inflight = 0;
  const stats = { maxInflight: 0, inflight: () => inflight };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown; headers?: unknown }) => {
    if (!String(url).endsWith("/audio/transcriptions")) return real(url as never, init as never);
    const headers = new Headers(init?.headers as never);
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    const call: SttCall = {
      n: calls.length, ms: wavDurationMs(Buffer.from(await file.arrayBuffer())), startedAt: Date.now(),
      fields: Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>,
      url: String(url), ...(headers.has("authorization") ? { auth: headers.get("authorization")! } : {}),
    };
    calls.push(call);
    inflight++; stats.maxInflight = Math.max(stats.maxInflight, inflight);
    try {
      const text = await answer(call);
      return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      return new Response(String(err), { status: err instanceof SttStatus ? err.status : 500 });
    } finally { inflight--; }
  }) as typeof fetch;
  return { calls, stats, restore: () => { globalThis.fetch = real; } };
}

/** What a scripted streaming session records, and the levers a test pulls on it. */
export interface FakeSession {
  n: number;
  /** Every `push`, in order, with its arrival time. */
  pushed: Buffer[];
  pushAt: number[];
  openedAt: number;
  aborted: boolean;
  finishCalls: number;
  /** The server's current whole hypothesis changes (EARS-PART-016). */
  hypothesis(text: string): void;
  /** The connection drops or the server reports an error: `failed` settles. */
  fail(err?: Error): void;
  /** The concatenation of every pushed buffer. */
  audio(): Buffer;
}
export interface FakeStreamingOptions {
  name?: "nemotron" | "kyutai";
  destination?: string;
  /** Runs at every `open` (n counts from 0): throw to refuse, await to take time. */
  open?: (n: number) => void | Promise<void>;
  /** The final text; a throw or a never-settling promise is a failed `finish()`. Default: the last hypothesis. */
  finish?: (s: FakeSession) => string | Promise<string>;
  /** Readiness probe; absent means the engine has none (EARS-HLTH-008). */
  ping?: () => boolean | Promise<boolean>;
}
/** A scripted `StreamingSttEngine`: no network. `sessions` are the ones opened; `stats.opens` counts every `open` call, refused ones too. */
export function fakeStreaming(o: FakeStreamingOptions = {}) {
  const sessions: FakeSession[] = [];
  const stats = { opens: 0, pings: 0 };
  const engine: StreamingSttEngine = {
    kind: "streaming", name: o.name ?? "nemotron", ...(o.destination ? { destination: o.destination } : {}),
    ...(o.ping ? { ping: async () => { stats.pings++; return o.ping!(); } } : {}),
    async open() {
      const n = stats.opens++;
      await o.open?.(n);
      let last = "";
      let cb: ((t: string) => void) | undefined;
      let signalFailed!: (e: Error) => void;
      const failed = new Promise<Error>((res) => { signalFailed = res; });
      const s: FakeSession = {
        n, pushed: [], pushAt: [], openedAt: Date.now(), aborted: false, finishCalls: 0,
        hypothesis: (t) => { last = t; cb?.(t); },
        fail: (e = new Error("connection dropped")) => signalFailed(e),
        audio: () => Buffer.concat(s.pushed),
      };
      sessions.push(s);
      const session: SttSession = {
        push: (pcm) => { s.pushed.push(Buffer.from(pcm)); s.pushAt.push(Date.now()); },
        onHypothesis: (c) => { cb = c; },
        onEndOfTurn: () => {},
        finish: async () => { s.finishCalls++; return o.finish ? o.finish(s) : last; },
        abort: () => { s.aborted = true; },
        failed,
      };
      return session;
    },
  };
  return { engine, sessions, stats };
}
