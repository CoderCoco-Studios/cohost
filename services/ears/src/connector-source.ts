/**
 * A connector source: the listening source for a tag a connector serves (the Discord connector serves `discord`). It finds
 * the connector through the registry, reads `audio.in.<tag>` frames live, cuts each speaker's frames into utterances by the
 * gap between frames, and hands each to `Hearing`. A tag whose registration says `transport` `http` is read from ears'
 * `http` listener instead (EARS-SRC-009).
 */
import { randomUUID } from "node:crypto";
import { wavWrap } from "@cohost/shared";
import { FrameTracker, type Bus, type ConnectorRegistry } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { CaptureAdapter, HearClip } from "./capture.js";
import { hasWordCharacter, isDropPhrase } from "./transcript.js";
import type { LoadVad, SpeechDetector } from "./vad.js";

/** Frames of a connector source are 16 kHz mono (CONN-AUD-003). */
const IN_FORMAT = { rate: 16000, channels: 1 };

/** The `http` listener a stream-less tag shares with the `http` source: started on demand, ok while bound. */
export interface HttpListener {
  ensure(): Promise<void>;
  bound(): boolean;
}

export interface PartialDeps {
  /** `ears.partial_step_ms`. */
  stepMs: number;
  /** `ears.min_speech_ms`: no partial for less audio than this. */
  minSpeechMs: number;
  dropPhrases: readonly string[];
  /** 16 kHz mono WAV -> text through the batch STT request; not the tracked transcriber, so a failure never moves `deps.stt` (EARS-PART-010). */
  transcribe: (wav: Buffer) => Promise<string>;
  publish: (data: PartialData) => Promise<void>;
}

/** The payload of one `speech.partial` (BUS-EVT-026). */
export interface PartialData {
  speaker: string;
  speakerId: string;
  source: string;
  text: string;
  utteranceId: string;
  seq: number;
  timing: { audioEndedAt: number };
}

export interface ConnectorSourceDeps {
  /** The source tag, which is also the connector source's name. */
  name: string;
  bus: Pick<Bus, "tailAudio">;
  registry: ConnectorRegistry;
  hear: HearClip;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** `ears.silence_ms`: an utterance closes when no frame from its speaker has arrived for this long (and, with a detector, after this much audio since the last speech frame). */
  silenceMs: number;
  /** `ears.max_utterance_ms`; no cap when absent. */
  maxUtteranceMs?: number;
  /** The speech-activity detector (engine `silero`); absent means the frame-gap rule alone (engine `gap`). */
  vad?: { threshold: number; load: LoadVad };
  /** Partial transcripts; absent means none. */
  partials?: PartialDeps;
  listener?: HttpListener;
  /** Whether audio that ended at this time (epoch ms) falls inside the echo gate's open window (EARS-ECHO-005); absent means never. */
  echoBlocked?: (audioEndedAt: number) => boolean;
}

export interface ConnectorSource extends CaptureAdapter {
  /** `lost n, dropped m`, plus `<tag> connector not connected` while the source is down; for the heartbeat detail. */
  detail(): string;
  /** The frame accounting alone. */
  stats(): string;
}

/** 16 kHz mono s16le: bytes per millisecond. */
const BYTES_PER_MS = 32;
const PRE_ROLL_MS = 200;

interface Open {
  id: string;
  name: string;
  chunks: Buffer[];
  /** Arrival time of each chunk. */
  at: number[];
  bytes: number;
  /** Chunks up to and including the last speech frame: the clip. */
  speechEnd: number;
  /** Received audio since the last speech frame, bytes. */
  silentBytes: number;
  timer: ReturnType<typeof setTimeout>;
  closed: boolean;
  steps?: ReturnType<typeof setInterval>;
  inflight: boolean;
  /** The last successful partial transcription's words, for agreement. */
  prev?: string[];
  publishedWords: number;
  seq: number;
}

interface Speaker { detector?: SpeechDetector; open?: Open; ring: Buffer[]; ringAt: number[]; chain: Promise<void> }

const normWord = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// @spec EARS-CON-001, EARS-CON-003, EARS-CON-004, EARS-CON-005, EARS-HEAR-001, EARS-HEAR-002, EARS-SRC-009, EARS-SRC-012, EARS-SRC-004, CONN-AUD-004, CONN-DESK-003, EARS-VAD-001, EARS-VAD-002, EARS-VAD-003, EARS-VAD-004, EARS-VAD-005, EARS-VAD-006, EARS-VAD-007, EARS-VAD-008, EARS-PART-003, EARS-PART-004, EARS-PART-005, EARS-PART-006, EARS-PART-007, EARS-PART-008, EARS-PART-009, EARS-PART-010, EARS-PART-013, EARS-PART-014
export function createConnectorSource(d: ConnectorSourceDeps): ConnectorSource {
  const tracker = new FrameTracker(IN_FORMAT);
  const speakers = new Map<string, Speaker>();
  const inflight = new Set<Promise<unknown>>();
  let makeDetector: (() => SpeechDetector) | undefined;
  let stopped = false;
  let tailing = false;
  let unsubscribe: (() => void) | undefined;

  const transport = (): "stream" | "http" | undefined => d.registry.offer("audio-in", d.name)?.cap.transport;

  const stopSteps = (o: Open): void => {
    o.closed = true;
    clearTimeout(o.timer);
    if (o.steps) clearInterval(o.steps);
  };

  /** Close a speaker's open utterance and hand its clip, up to the last speech frame, to transcription (EARS-VAD-003). */
  const close = (sp: Speaker): void => {
    const o = sp.open;
    if (!o) return;
    stopSteps(o);
    sp.open = undefined;
    sp.ring = []; sp.ringAt = [];
    const spk = [...speakers.entries()].find(([, v]) => v === sp)![0];
    const end = Math.max(o.speechEnd, 1);
    const clip = { pcm: Buffer.concat(o.chunks.slice(0, end)), ...IN_FORMAT, audioEndedAt: o.at[end - 1]!, utteranceId: o.id };
    const p = d.hear(clip, o.name, d.name, spk)
      .catch((err) => d.log.error({ err: String(err), source: d.name }, "ears connector source: hearing failed"));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  // @spec EARS-PART-004, EARS-PART-005, EARS-PART-006, EARS-PART-007, EARS-PART-008, EARS-PART-009, EARS-PART-010, EARS-PART-014
  /** One partial step of an open utterance: transcribe all its audio so far, commit what two runs in a row agree on, publish growth. */
  const step = (spk: string, o: Open): void => {
    const pd = d.partials;
    if (!pd || o.closed || o.inflight) return; // a step due while one is in flight is skipped, not queued
    const end = o.speechEnd;
    const pcm = Buffer.concat(o.chunks.slice(0, end));
    if (pcm.length < pd.minSpeechMs * BYTES_PER_MS) return;
    const audioEndedAt = o.at[end - 1]!;
    if (d.echoBlocked?.(audioEndedAt)) return; // @spec EARS-ECHO-005
    o.inflight = true;
    void (async () => {
      let text: string;
      try {
        text = await pd.transcribe(wavWrap(pcm, IN_FORMAT.rate, IN_FORMAT.channels));
      } catch (err) {
        o.inflight = false;
        o.prev = undefined; // agreement needs two new successful transcriptions
        d.log.warn({ err: String(err), source: d.name }, "partial transcription failed");
        return;
      }
      o.inflight = false;
      if (o.closed || stopped) return; // a result that returns after the close is discarded
      const words = text.split(/\s+/u).filter((w) => w !== "");
      const prev = o.prev;
      o.prev = words;
      if (!prev) return;
      let k = 0;
      while (k < words.length && k < prev.length && normWord(words[k]!) === normWord(prev[k]!)) k++;
      if (k <= o.publishedWords) return;
      const committed = words.slice(0, k).join(" ");
      if (!hasWordCharacter(committed) || isDropPhrase(committed, pd.dropPhrases)) return;
      try {
        await pd.publish({ speaker: o.name, speakerId: spk, source: d.name, text: committed, utteranceId: o.id, seq: o.seq, timing: { audioEndedAt } });
        o.seq++;
        o.publishedWords = k;
      } catch (err) {
        d.log.warn({ err: String(err), source: d.name }, "speech.partial publish failed");
      }
    })();
  };

  const open = (sp: Speaker, spk: string, name: string, chunks: Buffer[], at: number[]): Open => {
    const o: Open = {
      id: randomUUID(), name, chunks, at, bytes: chunks.reduce((n, c) => n + c.length, 0), speechEnd: chunks.length, silentBytes: 0,
      timer: setTimeout(() => close(sp), d.silenceMs), closed: false, inflight: false, publishedWords: 0, seq: 0,
    };
    if (d.partials) { o.steps = setInterval(() => step(spk, o), d.partials.stepMs); o.steps.unref(); }
    sp.open = o;
    return o;
  };

  // @spec EARS-HEAR-001, CONN-AUD-004, EARS-VAD-002, EARS-VAD-003, EARS-VAD-005, EARS-VAD-007
  const onSpeaker = (sp: Speaker, spk: string, name: string, pcm: Buffer, speech: boolean): void => {
    if (stopped) return;
    const now = Date.now();
    const o = sp.open;
    if (!o) {
      if (!speech) { // no open utterance: keep only the pre-roll
        sp.ring.push(pcm); sp.ringAt.push(now);
        while (sp.ring.reduce((n, c) => n + c.length, 0) > PRE_ROLL_MS * BYTES_PER_MS) { sp.ring.shift(); sp.ringAt.shift(); }
        return;
      }
      const chunks = [...sp.ring, pcm], at = [...sp.ringAt, now];
      sp.ring = []; sp.ringAt = [];
      const fresh = open(sp, spk, name, chunks, at);
      if (d.maxUtteranceMs !== undefined && fresh.bytes >= d.maxUtteranceMs * BYTES_PER_MS) close(sp);
      return;
    }
    clearTimeout(o.timer);
    o.chunks.push(pcm); o.at.push(now);
    o.bytes += pcm.length;
    o.name = name;
    if (speech) { o.speechEnd = o.chunks.length; o.silentBytes = 0; } else o.silentBytes += pcm.length;
    if (d.maxUtteranceMs !== undefined && o.bytes >= d.maxUtteranceMs * BYTES_PER_MS) return close(sp);
    if (d.vad && o.silentBytes >= d.silenceMs * BYTES_PER_MS) return close(sp);
    o.timer = setTimeout(() => close(sp), d.silenceMs); // the frame-gap rule (EARS-VAD-004)
  };

  const onFrame = (decoded: Parameters<typeof tracker.accept>[0]): void => {
    if (stopped) return;
    const f = tracker.accept(decoded);
    if (!f) return;
    if (transport() === "http") return; // clips for this tag arrive on the listener, not the stream
    const spk = f.spk || d.name;
    const name = f.name || spk;
    let sp = speakers.get(spk);
    if (!sp) { sp = { ring: [], ringAt: [], chain: Promise.resolve(), ...(makeDetector ? { detector: makeDetector() } : {}) }; speakers.set(spk, sp); }
    const detector = sp.detector;
    if (!detector) return onSpeaker(sp, spk, name, f.pcm, true); // gap engine: every frame is part of the utterance
    const s = sp;
    s.chain = s.chain.then(async () => {
      const prob = await detector.probability(f.pcm);
      onSpeaker(s, spk, name, f.pcm, prob >= d.vad!.threshold);
    }).catch((err) => d.log.error({ err: String(err), source: d.name }, "ears connector source: detector failed"));
  };

  /** A registration with transport http needs the listener bound; start it when first seen. */
  const react = (): void => {
    if (stopped) return;
    if (transport() === "http") d.listener?.ensure().catch((err) => d.log.error({ err: String(err), source: d.name }, "ears http listener could not start"));
  };

  const status = (): "ok" | "down" => {
    const o = d.registry.ready("audio-in", d.name);
    if (!o) return "down";
    return o.cap.transport === "http" ? (d.listener?.bound() ? "ok" : "down") : tailing ? "ok" : "down";
  };

  return {
    name: d.name,
    status,
    stats: () => tracker.summary(),
    detail: () => (status() === "down" ? `${d.name} connector not connected; ${tracker.summary()}` : tracker.summary()),

    async start() {
      stopped = false;
      unsubscribe = d.registry.on(react);
      react();
      if (transport() === "http") return;
      // @spec EARS-VAD-006
      if (d.vad) {
        try { makeDetector = await d.vad.load(); } catch (err) { throw new Error(`vad unavailable: ${err instanceof Error ? err.message : String(err)}`); }
      }
      // The stream is read from the end for the whole run; a connector that appears later is picked up by the same read.
      tailing = true;
      d.bus.tailAudio("in", d.name, onFrame).then(
        () => { tailing = false; },
        (err) => { tailing = false; d.log.error({ err: String(err), source: d.name }, "ears connector source: audio.in read ended"); },
      );
    },

    // @spec EARS-SRC-004
    async stop() {
      stopped = true;
      unsubscribe?.();
      for (const sp of speakers.values()) if (sp.open) stopSteps(sp.open); // @spec EARS-PART-013
      speakers.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}
