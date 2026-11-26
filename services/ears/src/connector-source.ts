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
import type { CaptureAdapter, Clip, HearClip, HearOutcome } from "./capture.js";
import type { SttSession } from "./engines.js";
import type { HeardMeta } from "./hearing.js";
import type { SttRouter } from "./stt.js";
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
  /** 16 kHz mono WAV -> text through the batch engine's request; not the router's whole-clip call, so a failure never moves `deps.stt` (EARS-PART-010). */
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

/** The payload of one `speech.early` (BUS-EVT-052). */
export interface EarlyData {
  speaker: string;
  speakerId: string;
  source: string;
  text: string;
  utteranceId: string;
  seq: number;
  sttMs: number;
  timing: { audioEndedAt: number };
}

/** The payload of one `speech.retracted` (BUS-EVT-053). */
export interface RetractedData {
  speaker: string;
  speakerId: string;
  source: string;
  utteranceId: string;
  seq: number;
}

/** The four early counts since start, as the heartbeat reports them (EARS-EARLY-022, 023). */
export interface EarlyCounts { published: number; retracted: number; reused: number; late: number }

/** Early reply (EARS-EARLY-*) for the connector sources of a batch engine; absent where it is off, for a streaming engine, stub or echo-suppressed source. */
export interface EarlyDeps {
  /** `ears.early.after_ms`. */
  afterMs: number;
  /** `ears.early.max_per_utterance`. */
  max: number;
  /** `ears.min_speech_ms`: no snapshot for less audio than this, counted up to the last speech frame. */
  minSpeechMs: number;
  dropPhrases: readonly string[];
  /** 16 kHz mono WAV -> text through the batch engine's request, which never moves `deps.stt` (EARS-EARLY-007), bounded by `ears.stt_timeout_ms`. */
  transcribe: (wav: Buffer) => Promise<string>;
  publish: (data: EarlyData) => Promise<void>;
  publishRetracted: (data: RetractedData) => Promise<void>;
  counts: EarlyCounts;
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
  /** The selected engine streams: partials come from session hypotheses, not from batch re-reads (EARS-PART-004, 016). */
  streaming?: boolean;
  /** Sessions for this source's utterances (EARS-SES-*); absent when none may open (batch selected, a configuration gap, or an echo-suppressed source). */
  stream?: { router: SttRouter; minSpeechMs: number };
  /** A streamed utterance's final → `speech.heard` through the word and drop-phrase checks (EARS-SES-004). */
  hearText?: (text: string, durationMs: number, meta: HeardMeta) => Promise<HearOutcome>;
  /** Early reply; absent means no early snapshots (EARS-EARLY-*). */
  early?: EarlyDeps;
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

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The streaming session of one utterance: `connecting` holds the audio until the session takes it (EARS-SES-002). */
interface Stream {
  /** `starting`: connected, the buffered start is being pushed (EARS-SES-002, 003). */
  state: "connecting" | "starting" | "live" | "finishing" | "failed" | "done";
  session?: SttSession;
  /** Frames received while connecting or starting, pushed in order once the session is live. */
  pending: Buffer[];
  /** A session that fails while it can serve: aborted, reported, and its waiting close falls back (EARS-SES-010). */
  fail?: (err: unknown) => void;
  /** Aborts the connect when the source stops (EARS-SES-007). */
  ac: AbortController;
  /** The utterance closed while the connect was pending: its clip waits for the connect to settle (EARS-SES-004). */
  closeWith?: { clip: Clip; spk: string };
}

/** One early transcription in flight: `discard` is set when speech resumes or the cap closes the utterance (EARS-EARLY-014). */
interface EarlyCall {
  discard: boolean;
  /** The result is in the utterance's publish chain (EARLY-013). */
  publishing?: boolean;
  failed?: true;
  text?: string;
  /** The early transcript this call published, once it did. */
  published?: Unresolved;
  /** Settles once the result is known and, when it is publishable and the utterance is still open, published. */
  promise: Promise<void>;
}

/** A published early transcript not yet retracted or reused as the final (EARS-EARLY-013, 016). */
interface Unresolved { seq: number; text: string; sttMs: number; audioEndedAt: number }

interface Open {
  id: string;
  name: string;
  /** The speaker id the source gave. */
  spk: string;
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
  stream?: Stream;
  /** Whether this utterance holds one of `ears.max_stt_sessions`. */
  slot: boolean;
  /** Streamed partials: the latest hypothesis, the last one published and when, and the pending trailing publish. */
  latest?: string;
  lastText?: string;
  lastPubAt?: number;
  hypTimer?: ReturnType<typeof setTimeout>;
  /** A hypothesis that arrived before `ears.min_speech_ms` of audio, held until the minimum is reached (EARS-PART-018). */
  held?: string;
  /** Streamed partials of this utterance are published one after another (EARS-PART-014). */
  pubChain: Promise<void>;
  /** Early reply: the timer of the next snapshot (gap measure), the snapshots taken (EARS-EARLY-004), the seq of the next published early transcript. */
  earlyTimer?: ReturnType<typeof setTimeout>;
  earlyCount: number;
  earlySeq: number;
  /** Speech has arrived since the last snapshot was taken (EARS-EARLY-026); true for a new utterance. */
  pausedSince: boolean;
  /** Epoch ms of the last frame classified as speech: the pause's clock (EARS-EARLY-001). */
  lastSpeechAt: number;
  early?: EarlyCall;
  unresolved?: Unresolved;
}

interface Speaker { detector?: SpeechDetector; open?: Open; ring: Buffer[]; ringAt: number[]; chain: Promise<void> }

const normWord = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

// @spec EARS-CON-001, EARS-CON-003, EARS-CON-004, EARS-CON-005, EARS-HEAR-001, EARS-HEAR-002, EARS-HEAR-012, EARS-SRC-009, EARS-SRC-012, EARS-SRC-004, CONN-AUD-004, CONN-DESK-003, EARS-VAD-001, EARS-VAD-002, EARS-VAD-003, EARS-KYU-010, EARS-KYU-011, EARS-KYU-012, EARS-VAD-004, EARS-VAD-005, EARS-VAD-006, EARS-VAD-007, EARS-VAD-008, EARS-PART-003, EARS-PART-004, EARS-PART-005, EARS-PART-006, EARS-PART-007, EARS-PART-008, EARS-PART-009, EARS-PART-010, EARS-PART-013, EARS-PART-014
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
    clearTimeout(o.hypTimer);
    clearTimeout(o.earlyTimer);
    if (o.steps) clearInterval(o.steps);
  };

  const track = (p: Promise<unknown>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  const releaseSlot = (o: Open): void => {
    if (!o.slot) return;
    o.slot = false;
    d.stream?.router.slots.release();
  };

  /** The clip to Hearing: the batch engine, marked as a fallback when a streaming session of it was attempted (EARS-SES-010). */
  const hearClip = (clip: Clip, spk: string, name: string, fallback: boolean): void => {
    track(d.hear({ ...clip, ...(fallback ? { fallback: true } : {}) }, name, d.name, spk)
      .catch((err) => d.log.error({ err: msg(err), source: d.name }, "ears connector source: hearing failed")));
  };

  /** Runs `fn` after everything already queued on the utterance's publish chain, so no event of the utterance overtakes an earlier one (EARS-EARLY-013, EARS-PART-014). */
  const publishOrdered = <T>(o: Open, fn: () => Promise<T>): Promise<T> => {
    const p = o.pubChain.then(fn);
    o.pubChain = p.then(() => undefined, (err) => d.log.warn({ err: msg(err), source: d.name }, "speech publish failed"));
    track(o.pubChain);
    return p;
  };

  const retract = (o: Open, u: Unresolved): void => {
    const ed = d.early!;
    ed.counts.retracted++;
    // @spec EARS-EARLY-024
    void publishOrdered(o, () => ed.publishRetracted({ speaker: o.name, speakerId: o.spk, source: d.name, utteranceId: o.id, seq: u.seq })).catch(() => undefined);
  };

  // @spec EARS-EARLY-013, EARS-EARLY-014, EARS-EARLY-015
  /** A speech frame of the speaker arrived: an early call in flight is discarded, and an unresolved early transcript is retracted once; the utterance stays open. */
  const resumed = (o: Open): void => {
    o.pausedSince = true;
    if (o.early) o.early.discard = true;
    const u = o.unresolved;
    if (u) {
      o.unresolved = undefined;
      retract(o, u);
    }
  };

  /** Whether the pause of `ears.early.after_ms` is due: wall-clock since the last speech frame, or under silero the silence received since it. */
  const pauseDue = (o: Open): boolean => {
    const ed = d.early!;
    return Date.now() - o.lastSpeechAt >= ed.afterMs || (d.vad !== undefined && o.silentBytes >= ed.afterMs * BYTES_PER_MS);
  };

  // @spec EARS-EARLY-001, EARS-EARLY-002, EARS-EARLY-003, EARS-EARLY-004, EARS-EARLY-005, EARS-EARLY-006, EARS-EARLY-007, EARS-EARLY-012, EARS-EARLY-023, EARS-EARLY-024, EARS-EARLY-026
  /** One early snapshot: the clip up to the last speech frame, transcribed through the batch request; a publishable result is published in order and becomes the unresolved early transcript. */
  const snapshot = (o: Open, pcm: Buffer, audioEndedAt: number): void => {
    const ed = d.early!;
    o.earlyCount++;
    o.pausedSince = false;
    const started = Date.now();
    const call: EarlyCall = { discard: false, publishing: false, promise: Promise.resolve() };
    o.early = call;
    call.promise = (async () => {
      let text: string | undefined;
      try {
        text = await ed.transcribe(wavWrap(pcm, IN_FORMAT.rate, IN_FORMAT.channels));
      } catch (err) {
        call.failed = true;
        d.log.warn({ err: String(err), source: d.name }, "early transcription failed");
      }
      const sttMs = Date.now() - started;
      call.text = text;
      const t = (text ?? "").trim();
      // EARLY-006: an empty, wordless or dropped result publishes nothing and takes no seq
      if (!call.failed && hasWordCharacter(t) && !isDropPhrase(t, ed.dropPhrases)) {
        call.publishing = true;
        const u = await publishOrdered(o, async () => {
          if (call.discard || o.closed) return undefined; // EARLY-014: resumed or closed before the publish
          const seq = o.earlySeq;
          try {
            await ed.publish({ speaker: o.name, speakerId: o.spk, source: d.name, text: t, utteranceId: o.id, seq, sttMs, timing: { audioEndedAt } });
          } catch (err) {
            d.log.warn({ err: String(err), source: d.name }, "speech.early publish failed");
            return undefined; // not published: no seq taken, nothing reusable
          }
          o.earlySeq = seq + 1;
          ed.counts.published++;
          return { seq, text: t, sttMs, audioEndedAt };
        });
        if (u) {
          call.published = u;
          if (call.discard) retract(o, u);
          else if (!o.closed) o.unresolved = u;
        }
      }
      if (o.early === call) o.early = undefined;
      // a call that settles while the utterance is open takes the snapshot the pause still owes (the gap timer fired while it ran)
      if (!o.closed && pauseDue(o)) tryEarly(o);
    })();
    track(call.promise);
  };

  // @spec EARS-EARLY-001, EARS-EARLY-002, EARS-EARLY-003, EARS-EARLY-004, EARS-EARLY-026
  /** Takes the snapshot when the pause conditions hold: at least `min_speech_ms` of speech, no call or unresolved transcript, speech since the last snapshot, under the cap. */
  const tryEarly = (o: Open): void => {
    const ed = d.early;
    if (!ed || o.closed || stopped || o.early || o.unresolved || !o.pausedSince || o.earlyCount >= ed.max) return;
    const end = o.speechEnd;
    const pcm = Buffer.concat(o.chunks.slice(0, end));
    if (pcm.length < ed.minSpeechMs * BYTES_PER_MS) return;
    snapshot(o, pcm, o.at[end - 1]!);
  };

  // @spec EARS-EARLY-001
  /** Re-armed by each speech frame: the snapshot is due `after_ms` of wall-clock time after the last speech frame, the frame-gap rule's measure (EARS-VAD-004). */
  const armEarly = (o: Open): void => {
    if (!d.early) return;
    clearTimeout(o.earlyTimer);
    o.earlyTimer = setTimeout(() => tryEarly(o), d.early.afterMs);
  };

  // @spec EARS-EARLY-016, EARS-EARLY-017, EARS-EARLY-018, EARS-EARLY-019, EARS-EARLY-021, EARS-EARLY-023, EARS-EARLY-025
  /** The close of an utterance with early reply on. A call in flight at the close counts late; the cap transcribes anew without waiting for it; a discarded call is not waited for; a waited-for call decides the final. */
  const finishEarly = (o: Open, clip: Clip, spk: string, cap: boolean): void => {
    const ed = d.early!;
    const h = o.early;
    // EARS-EARLY-023: late whatever the outcome, discarded or capped included
    if (h) ed.counts.late++;
    const meta = { speaker: o.name, speakerId: spk, source: d.name, utteranceId: o.id, closedAt: clip.closedAt };
    const dur = clip.pcm.length / BYTES_PER_MS;
    if (cap) {
      // EARLY-025: retract an unresolved transcript first, discard a call in flight, transcribe the whole clip anew
      if (h) h.discard = true;
      if (h?.publishing) return track(h.promise.then(() => hearClip(clip, spk, o.name, false)));
      const u = o.unresolved;
      o.unresolved = undefined;
      if (u) {
        retract(o, u);
        return track(o.pubChain.then(() => hearClip(clip, spk, o.name, false)));
      }
      return hearClip(clip, spk, o.name, false);
    }
    if (h && h.discard) {
      // a discarded call is neither waited for nor late-published: the clip is transcribed anew
      if (h.publishing) return track(h.promise.then(() => hearClip(clip, spk, o.name, false)));
      return track(o.pubChain.then(() => hearClip(clip, spk, o.name, false)));
    }
    if (h) {
      // EARLY-018, 019: wait for the call; a publish that landed reuses its transcript, a failure falls back, a result is the late final
      track(h.promise.then(async () => {
        if (h.published) {
          ed.counts.reused++;
          await d.hearText?.(h.published.text, dur, { ...meta, audioEndedAt: h.published.audioEndedAt, earlySeq: h.published.seq, earlySttMs: h.published.sttMs });
          return;
        }
        if (h.failed) return hearClip(clip, spk, o.name, false);
        await d.hearText?.(h.text ?? "", dur, { ...meta, audioEndedAt: clip.audioEndedAt, earlyLate: true });
      }));
      return;
    }
    const u = o.unresolved;
    if (u) {
      // EARLY-016, 017: reuse the unretracted early transcript as the final, with no second call
      o.unresolved = undefined;
      ed.counts.reused++;
      track(o.pubChain.then(() => d.hearText?.(u.text, dur, { ...meta, audioEndedAt: u.audioEndedAt, earlySeq: u.seq, earlySttMs: u.sttMs })));
      return;
    }
    hearClip(clip, spk, o.name, false);
  };

  // @spec EARS-SES-004, EARS-SES-010, EARS-HLTH-003
  /** A live session at close: its final, bounded by the timeout, becomes `speech.heard`; when it does not arrive the clip goes to the batch engine. */
  const finalize = (o: Open, s: Stream, session: SttSession, clip: Clip, spk: string, durationMs: number): void => {
    const st = d.stream!;
    s.state = "finishing";
    track(st.router.finish(session).then(
      async (text) => {
        releaseSlot(o);
        s.state = "done";
        st.router.sessionFinal();
        await d.hearText?.(text, durationMs, { speaker: o.name, speakerId: spk, source: d.name, audioEndedAt: clip.audioEndedAt, utteranceId: o.id, closedAt: clip.closedAt });
      },
      (err) => {
        session.abort();
        releaseSlot(o);
        s.state = "failed";
        st.router.sessionFailed(msg(err));
        hearClip(clip, spk, o.name, true);
      },
    ).catch((err) => d.log.error({ err: msg(err), source: d.name }, "ears connector source: final failed")));
  };

  /** The close of an utterance with a live session: too short aborts it (EARS-SES-006), otherwise its final is taken. */
  const closeLive = (o: Open, s: Stream, clip: Clip, spk: string): void => {
    const durationMs = clip.pcm.length / BYTES_PER_MS;
    // @spec EARS-SES-006
    if (durationMs < d.stream!.minSpeechMs) {
      s.state = "done";
      s.session?.abort();
      releaseSlot(o);
      return;
    }
    finalize(o, s, s.session!, clip, spk, durationMs);
  };

  /**
   * Close a speaker's open utterance and hand its clip on: to its session, or to transcription (EARS-VAD-003). The clip ends at
   * the last speech frame, or at the last frame received when `toLastFrame` (an end-of-turn signal, EARS-KYU-010). `cap` marks
   * a close by `ears.max_utterance_ms`.
   */
  const close = (sp: Speaker, toLastFrame = false, cap = false): void => {
    const o = sp.open;
    if (!o) return;
    stopSteps(o);
    sp.open = undefined;
    sp.ring = []; sp.ringAt = [];
    const spk = [...speakers.entries()].find(([, v]) => v === sp)![0];
    const end = toLastFrame ? o.chunks.length : Math.max(o.speechEnd, 1);
    const pcm = Buffer.concat(o.chunks.slice(0, end));
    // @spec EARS-EARLY-020: every utterance ears closes itself is stamped with the close
    const clip: Clip = { pcm, ...IN_FORMAT, audioEndedAt: o.at[end - 1]!, utteranceId: o.id, closedAt: Date.now() };
    const s = o.stream;
    if (s?.state === "live" && s.session) return closeLive(o, s, clip, spk);
    // A connect still pending is waited for: its session takes the close when it connects, and only its failure falls back.
    if (s?.state === "connecting" || s?.state === "starting") {
      s.closeWith = { clip, spk };
      return;
    }
    if (d.early) return finishEarly(o, clip, spk, cap);
    hearClip(clip, spk, o.name, s !== undefined);
  };

  // @spec EARS-PART-016, EARS-PART-017, EARS-PART-018, EARS-PART-019, EARS-PART-020, EARS-PART-021, EARS-PART-022
  /** Publishes a streamed hypothesis, once it is filtered and paced (EARS-PART-017): the first change at once, then one per window. */
  const publishHypothesis = (o: Open, text: string): void => {
    const pd = d.partials!;
    // a filtered hypothesis is not published and does not start the pacing window
    if (!hasWordCharacter(text) || isDropPhrase(text, pd.dropPhrases)) return;
    o.lastText = text;
    o.lastPubAt = Date.now();
    const audioEndedAt = o.at[o.at.length - 1]!;
    // one publish at a time; the sequence number is taken only when a publish succeeds (EARS-PART-006, 014)
    o.pubChain = o.pubChain.then(() => pd.publish({ speaker: o.name, speakerId: o.spk, source: d.name, text, utteranceId: o.id, seq: o.seq, timing: { audioEndedAt } })
      .then(() => { o.seq++; }, (err) => d.log.warn({ err: msg(err), source: d.name }, "speech.partial publish failed")));
    track(o.pubChain);
  };

  /** A hypothesis of a live session (EARS-PART-016): nothing after the close, only on change; before the minimum audio it is held (EARS-PART-018). */
  const hypothesis = (o: Open, text: string): void => {
    const pd = d.partials;
    if (!pd || o.closed || o.stream?.state !== "live") return;
    if (o.bytes < pd.minSpeechMs * BYTES_PER_MS) {
      o.held = text;
      return;
    }
    o.held = undefined;
    o.latest = text;
    if (o.hypTimer !== undefined || text === o.lastText) return;
    const wait = o.lastPubAt === undefined ? 0 : o.lastPubAt + pd.stepMs - Date.now();
    if (wait <= 0) return publishHypothesis(o, text);
    o.hypTimer = setTimeout(() => {
      o.hypTimer = undefined;
      if (!o.closed && o.latest !== undefined && o.latest !== o.lastText) publishHypothesis(o, o.latest);
    }, wait);
  };

  // @spec EARS-PART-004, EARS-PART-005, EARS-PART-006, EARS-PART-007, EARS-PART-008, EARS-PART-009, EARS-PART-010, EARS-PART-014
  /** One partial step of an open utterance: transcribe all its audio so far, commit what two runs in a row agree on, publish growth. */
  const step = (spk: string, o: Open): void => {
    const pd = d.partials;
    if (!pd || o.closed || o.inflight || d.streaming) return; // a step due while one is in flight is skipped, not queued
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
      // queued on the utterance's publish chain, so it cannot overtake an early or retracted event (EARS-EARLY-013)
      void publishOrdered(o, async () => {
        if (o.closed || k <= o.publishedWords) return;
        try {
          await pd.publish({ speaker: o.name, speakerId: spk, source: d.name, text: committed, utteranceId: o.id, seq: o.seq, timing: { audioEndedAt } });
          o.seq++;
          o.publishedWords = k;
        } catch (err) {
          d.log.warn({ err: String(err), source: d.name }, "speech.partial publish failed");
        }
      }).catch(() => undefined);
    })();
  };

  const open = (sp: Speaker, spk: string, name: string, chunks: Buffer[], at: number[]): Open => {
    const o: Open = {
      id: randomUUID(), name, spk, chunks, at, bytes: chunks.reduce((n, c) => n + c.length, 0), speechEnd: chunks.length, silentBytes: 0,
      timer: setTimeout(() => close(sp), d.silenceMs), closed: false, inflight: false, publishedWords: 0, seq: 0, slot: false, pubChain: Promise.resolve(),
      earlyCount: 0, earlySeq: 0, pausedSince: true, lastSpeechAt: Date.now(),
    };
    if (d.partials) { o.steps = setInterval(() => step(spk, o), d.partials.stepMs); o.steps.unref(); }
    sp.open = o;
    return o;
  };

  // @spec EARS-SES-001, EARS-SES-002, EARS-SES-008, EARS-SES-009, EARS-SES-012
  /** Opens a session for a new utterance when one of `ears.max_stt_sessions` is free; the audio held so far waits for it. */
  // @spec EARS-SES-001, EARS-SES-002, EARS-SES-003, EARS-SES-010
  const startSession = (sp: Speaker, o: Open): void => {
    const st = d.stream;
    if (!st || !st.router.slots.acquire()) return;
    o.slot = true;
    const s: Stream = { state: "connecting", pending: [...o.chunks], ac: new AbortController() };
    o.stream = s;
    /** A session failing while it serves: aborted, reported, and a close waiting on it falls back to batch. */
    s.fail = (err) => {
      if (s.state !== "live" && s.state !== "starting") return;
      s.session?.abort();
      s.state = "failed";
      releaseSlot(o);
      st.router.sessionFailed(msg(err));
      if (s.closeWith) {
        const c = s.closeWith;
        s.closeWith = undefined;
        hearClip(c.clip, c.spk, o.name, true);
      }
    };
    st.router.openSession(s.ac.signal).then(
      (session) => {
        if (stopped) {
          session.abort();
          releaseSlot(o);
          s.state = "done";
          return;
        }
        s.session = session;
        s.state = "starting";
        session.onHypothesis((t) => hypothesis(o, t));
        // an end-of-turn signal closes this utterance only while it is still open; a stale one does nothing
        session.onEndOfTurn(() => {
          if (o.closed || sp.open !== o) return;
          close(sp, true);
        });
        void session.failed.then((err) => s.fail?.(err));
        // the buffered start: each frame is pushed and, when the server returns a promise, awaited; frames that arrive meanwhile queue behind it
        const pump = async (): Promise<void> => {
          let c: Buffer | undefined;
          while (s.state === "starting" && (c = s.pending.shift()) !== undefined) await session.push(c);
          if (s.state === "starting") s.state = "live";
        };
        st.router.bufferedStart(pump()).then(
          () => {
            if (s.state !== "live" || !s.closeWith) return;
            const c = s.closeWith;
            s.closeWith = undefined;
            closeLive(o, s, c.clip, c.spk);
          },
          (err) => s.fail?.(err),
        );
      },
      () => {
        // the router reports an outage; a capacity refusal and a stop report nothing. Only here does a waiting close fall back.
        releaseSlot(o);
        s.state = "failed";
        if (s.closeWith && !stopped) {
          const c = s.closeWith;
          s.closeWith = undefined;
          hearClip(c.clip, c.spk, o.name, true);
        }
      },
    );
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
      if (d.stream) startSession(sp, fresh);
      armEarly(fresh);
      if (d.maxUtteranceMs !== undefined && fresh.bytes >= d.maxUtteranceMs * BYTES_PER_MS) close(sp, false, true);
      return;
    }
    clearTimeout(o.timer);
    o.chunks.push(pcm); o.at.push(now);
    o.bytes += pcm.length;
    o.name = name;
    const os = o.stream;
    if (os?.state === "live") {
      const r = os.session!.push(pcm);
      if (r) r.catch((err: unknown) => os.fail?.(err));
    } else if (os?.state === "connecting" || os?.state === "starting") os.pending.push(pcm);
    if (o.held !== undefined) hypothesis(o, o.held);
    if (speech) { o.speechEnd = o.chunks.length; o.silentBytes = 0; o.lastSpeechAt = now; resumed(o); armEarly(o); } else o.silentBytes += pcm.length;
    if (d.maxUtteranceMs !== undefined && o.bytes >= d.maxUtteranceMs * BYTES_PER_MS) return close(sp, false, true);
    if (d.vad && o.silentBytes >= d.silenceMs * BYTES_PER_MS) return close(sp);
    // @spec EARS-EARLY-001: under silero the pause is the received audio since the last speech frame
    if (d.early && d.vad && !speech && o.silentBytes >= d.early.afterMs * BYTES_PER_MS) tryEarly(o);
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
        try { makeDetector = await d.vad.load(); } catch (err) { throw new Error(`vad unavailable: ${err instanceof Error ? err.message : String(err)}`, { cause: err }); }
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
      for (const sp of speakers.values()) {
        const o = sp.open;
        if (!o) continue;
        stopSteps(o); // @spec EARS-PART-013
        // @spec EARS-SES-007
        if (o.stream?.state === "live") {
          o.stream.state = "done";
          o.stream.session?.abort();
          releaseSlot(o);
        } else if (o.stream?.state === "connecting") {
          o.stream.ac.abort(new Error("source stopped")); // the connect is ended; its outcome is dropped (EARS-SES-007)
        } else if (o.stream?.state === "starting") {
          o.stream.state = "done";
          o.stream.session?.abort();
          releaseSlot(o);
        }
      }
      speakers.clear();
      // a late fallback or a cap path can start new tracked work while these settle, so wait until none is left
      while (inflight.size > 0) await Promise.allSettled(inflight);
    },
  };
}
