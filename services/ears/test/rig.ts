/**
 * Shared rig for the endpointing (EARS-VAD-*) and partial-transcript (EARS-PART-*) tests: the real ears service on a fake
 * bus, a scripted speech-activity detector and a scripted speech-to-text endpoint. No model, no network.
 *
 * Test seams the code phase must provide (the specs name none):
 *  - `createEarsService({ loadVad })`: `loadVad()` loads the detector once when a connector source starts (a rejection is
 *    EARS-VAD-006) and resolves to a factory; the service calls the factory once per speaker id (EARS-VAD-007) to get a
 *    `SpeechDetector` whose `probability(pcm)` is the speech probability of one 16 kHz mono s16le frame.
 *  - Speech-to-text is reached only through `fetch` on `<STT_URL>/v1/audio/transcriptions` (EARS-HEAR-005), which the rig
 *    replaces on `globalThis`; partials and finals share it.
 */
import { ConnectorFakeBus, recordingLog, testConfig } from "@cohost/testing";
import { runService, type Heartbeat } from "@cohost/shared";
import type { Frame } from "@cohost/bus";
import { createEarsService, type EarsServiceOptions } from "../src/service.js";
import { wavDurationMs } from "../src/audio.js";

export interface SpeechDetector { probability(pcm: Buffer): number | Promise<number> }
export type LoadVad = () => Promise<() => SpeechDetector>;
type Options = EarsServiceOptions & { loadVad?: LoadVad };

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

export async function boot(ears: Record<string, unknown>, o: { setup?: (bus: ConnectorFakeBus) => void; loadVad?: LoadVad } = {}) {
  const bus = Object.assign(new ConnectorFakeBus(), { resetGroup: async () => {}, subscribe: () => new Promise<void>(() => {}) });
  o.setup?.(bus);
  const log = recordingLog();
  const svc = createEarsService({ registryIntervalMs: 20, refreshMs: 20, ...(o.loadVad ? { loadVad: o.loadVad } : {}) } as Options);
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
  return {
    bus, log,
    heard: () => bus.of("speech.heard") as unknown as { speaker: string; speakerId?: string; source?: string; text: string; durationMs: number; utteranceId?: string; timing?: { audioEndedAt?: number } }[],
    partials: () => bus.of("speech.partial" as never) as unknown as { speaker: string; speakerId?: string; source: string; text: string; seq: number; utteranceId: string; timing?: { audioEndedAt?: number } }[],
    lastHeartbeat: () => bus.health.at(-1),
    stop: async () => { await shutdown?.(); await hb?.stop(); },
  };
}

/** Feed `n` frames of one speaker, `gapMs` apart; returns when the first and last were fed. */
export async function feed(bus: ConnectorFakeBus, n: number, o: { spk?: string; fill?: number; gapMs?: number } = {}) {
  const first = Date.now();
  for (let i = 0; i < n; i++) { bus.feed("in", "discord", frame(o.spk ?? "u1", o.fill ?? SPEECH)); if (o.gapMs) await sleep(o.gapMs); }
  return { first, last: Date.now() };
}

export interface SttCall { n: number; ms: number; startedAt: number; fields: Record<string, string> }
/**
 * Replace `fetch` for the STT endpoint: `answer` gets the call (n counts from 0 in start order, ms is the WAV's duration)
 * and returns the text, after any delay it wants; a throw is a 500. Returns the calls made and a restore function.
 */
export function fakeStt(answer: (c: SttCall) => string | Promise<string>) {
  const calls: SttCall[] = [];
  let inflight = 0;
  const stats = { maxInflight: 0, inflight: () => inflight };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (!String(url).endsWith("/v1/audio/transcriptions")) return real(url as never, init as never);
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    const call: SttCall = {
      n: calls.length, ms: wavDurationMs(Buffer.from(await file.arrayBuffer())), startedAt: Date.now(),
      fields: Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>,
    };
    calls.push(call);
    inflight++; stats.maxInflight = Math.max(stats.maxInflight, inflight);
    try {
      const text = await answer(call);
      return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
    } catch (err) {
      return new Response(String(err), { status: 500 });
    } finally { inflight--; }
  }) as typeof fetch;
  return { calls, stats, restore: () => { globalThis.fetch = real; } };
}

