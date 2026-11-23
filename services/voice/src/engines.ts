/**
 * The four TTS engine adapters behind `voice.engine`: kokoro (default), openai (any OpenAI-compatible speech server),
 * pocket (Kyutai Pocket TTS) and stub (silence, no network). Each returns audio through the one contract in `engine.ts`;
 * every request goes through the engine's gate and is bounded by `voice.timeout_ms` (VOICE-ENG-006 to VOICE-ENG-010).
 */
import { randomBytes } from "node:crypto";
import { CREDENTIAL_QUERY_NAMES, urls, type Config } from "@cohost/config";
import { TtsError, TtsGate, type SynthesizeOpts, type TtsAudio, type TtsEngine } from "./engine.js";
import { readWavStream } from "./wav-reader.js";

type VoiceCfg = Config["voice"];

/** Stub timing: 60 ms of silence per character, never shorter than 400 ms. */
export const STUB_MS_PER_CHAR = 60;
export const STUB_MIN_MS = 400;

/**
 * Everything the Kokoro synthesizer sends to the TTS server except the text; the clip fingerprint hashes it (VOICE-CLIP-001).
 * Tuning knobs that are unset stay out so the server's own defaults apply.
 */
export function kokoroRequestSettings(cfg: Pick<VoiceCfg, "voice" | "speed" | "lang_code" | "volume_multiplier" | "normalization">): Record<string, unknown> { // @spec VOICE-SYN-009
  const out: Record<string, unknown> = { model: "kokoro", voice: cfg.voice, speed: cfg.speed, response_format: "wav" };
  if (cfg.lang_code !== undefined) out.lang_code = cfg.lang_code;
  if (cfg.volume_multiplier !== undefined) out.volume_multiplier = cfg.volume_multiplier;
  const norm = Object.fromEntries(Object.entries(cfg.normalization).filter(([, v]) => v !== undefined));
  if (Object.keys(norm).length > 0) out.normalization_options = norm;
  return out;
}

/** The engine `voice.engine` selects. Each call builds its own gate, so the service makes one engine and shares it. */
export function createEngine(cfg: VoiceCfg): TtsEngine { // @spec VOICE-ENG-001
  switch (cfg.engine) {
    case "kokoro": return kokoroEngine(cfg);
    case "openai": return openaiEngine(cfg);
    case "pocket": return pocketEngine(cfg);
    case "stub": return stubEngine(cfg);
  }
}

interface Transport { gate: TtsGate; timeoutMs: number }

/**
 * A server URL with the parts a credential can hide in removed: user info and credential-named query parameters. The
 * fingerprint hashes this form, so a rotated key never regenerates the clips (VOICE-CLIP-014).
 */
export function redactedUrl(url: string): string { // @spec VOICE-CLIP-014
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const credentialKeys = [...u.searchParams.keys()].filter((k) => CREDENTIAL_QUERY_NAMES.includes(k));
  if (!u.username && !u.password && credentialKeys.length === 0) return url;
  u.username = "";
  u.password = "";
  for (const k of credentialKeys) u.searchParams.delete(k);
  if (u.search === "?") u.search = "";
  return u.href;
}

const hostOf = (url: string): string | undefined => { try { return new URL(url).host; } catch { return undefined; } };

const timeoutError = (ms: number) => Object.assign(new Error(`tts timed out after ${ms} ms`), { name: "TimeoutError" });

/**
 * One request through the gate. The place is taken before the request is sent, and the timeout is armed then and reset
 * by every PCM byte after the header. A timeout or an outer abort aborts the request, which closes its connection; the
 * place is freed only when the response has ended or its connection has closed (VOICE-ENG-013).
 */
async function speak(t: Transport, o: SynthesizeOpts, send: (signal: AbortSignal) => Promise<Response>): Promise<TtsAudio> { // @spec VOICE-ENG-006, VOICE-ENG-007, VOICE-ENG-008, VOICE-ENG-009, VOICE-ENG-010, VOICE-ENG-013, VOICE-ENG-016
  const release = await t.gate.acquire(o.priority ?? "line", o.signal); // @spec VOICE-ENG-012
  const ac = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ac.abort(timeoutError(t.timeoutMs)); }, t.timeoutMs);
  };
  const outer = () => ac.abort(o.signal.reason);
  if (o.signal.aborted) ac.abort(o.signal.reason);
  else o.signal.addEventListener("abort", outer, { once: true });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    o.signal.removeEventListener("abort", outer);
    release();
  };
  const failure = (err: unknown): unknown => { finish(); return timedOut ? timeoutError(t.timeoutMs) : err; };

  async function* relay(src: AsyncIterable<Buffer>): AsyncIterable<Buffer> {
    try {
      for await (const c of src) yield c;
    } catch (err) {
      throw timedOut ? timeoutError(t.timeoutMs) : err;
    } finally {
      finish();
    }
  }

  let res: Response | undefined;
  try {
    arm();
    res = await send(ac.signal);
    if (!res.ok) throw new TtsError(res.status, await res.text()); // @spec VOICE-POC-006
    const audio = await readWavStream(res.body ?? (async function* () { /* an empty body */ })(), { onPcm: arm });
    return { format: audio.format, chunks: relay(audio.chunks) }; // @spec VOICE-ENG-005 (a connection cut mid-body errors the read; collect then rejects and keeps none of it)
  } catch (err) {
    // The connection is closed before the place is freed, so the next request never meets a half-read one.
    ac.abort(err);
    await res?.body?.cancel().catch(() => undefined);
    throw failure(err);
  }
}

/** A gap engine: incomplete configuration rejects every synthesis at once, naming the key (VOICE-GAP-001 to VOICE-GAP-005). */
function gap(name: TtsEngine["name"], problem: string, fingerprint: Record<string, unknown>, destination?: string): TtsEngine { // @spec VOICE-GAP-001, VOICE-GAP-002, VOICE-GAP-004
  return {
    name, concurrency: 1, configError: problem, destination, fingerprint: () => fingerprint,
    synthesize: async () => { throw new Error(problem); },
  };
}

function kokoroEngine(cfg: VoiceCfg): TtsEngine {
  const t: Transport = { gate: new TtsGate(2), timeoutMs: cfg.timeout_ms };
  return {
    name: "kokoro",
    concurrency: 2,
    get destination() { return hostOf(urls.tts()); },
    synthesize: (text, o) => speak(t, o, (signal) => fetch(`${urls.tts()}/v1/audio/speech`, { // @spec VOICE-SYN-002, VOICE-KOK-001
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...kokoroRequestSettings(cfg), input: text }),
      signal,
    })),
    fingerprint: () => ({ name: "kokoro", url: redactedUrl(urls.tts()), ...kokoroRequestSettings(cfg) }), // @spec VOICE-CLIP-013, VOICE-CLIP-014, VOICE-CLIP-015
  };
}

function openaiEngine(cfg: VoiceCfg): TtsEngine { // @spec VOICE-OAI-003
  const o = cfg.openai;
  const fingerprint = { name: "openai", url: redactedUrl(o.base_url), voice: cfg.voice, model: o.model, speed: cfg.speed };
  if (!o.base_url) return gap("openai", "tts not configured: voice.openai.base_url is not set", fingerprint);
  if (!o.model) return gap("openai", "tts not configured: voice.openai.model is not set", fingerprint, hostOf(o.base_url));
  if (!cfg.voice) return gap("openai", "tts not configured: voice.voice is not set", fingerprint, hostOf(o.base_url));
  const t: Transport = { gate: new TtsGate(2), timeoutMs: cfg.timeout_ms };
  return {
    name: "openai",
    concurrency: 2,
    destination: hostOf(o.base_url),
    synthesize: (text, opts) => speak(t, opts, (signal) => fetch(`${o.base_url}/audio/speech`, { // @spec VOICE-OAI-001, VOICE-OAI-002
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(o.api_key ? { authorization: `Bearer ${o.api_key}` } : {}),
      },
      body: JSON.stringify({ model: o.model, input: text, voice: cfg.voice, speed: cfg.speed, response_format: "wav" }),
      signal,
    })),
    fingerprint: () => fingerprint, // @spec VOICE-CLIP-014
  };
}

/** multipart/form-data with text fields only (VOICE-POC-001). */
function multipart(fields: Record<string, string>): { type: string; body: Buffer } {
  const boundary = `cohost-${randomBytes(12).toString("hex")}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  return { type: `multipart/form-data; boundary=${boundary}`, body: Buffer.from(`${parts.join("")}--${boundary}--\r\n`, "utf8") };
}

function pocketEngine(cfg: VoiceCfg): TtsEngine { // @spec VOICE-POC-004
  const url = cfg.pocket.url.replace(/\/+$/, "");
  const voice = cfg.voice;
  const fingerprint = { name: "pocket", url: redactedUrl(url), voice };
  if (!url) return gap("pocket", "tts not configured: voice.pocket.url is not set", fingerprint);
  const t: Transport = { gate: new TtsGate(1), timeoutMs: cfg.timeout_ms };
  return {
    name: "pocket",
    concurrency: 1,
    destination: hostOf(url),
    synthesize: (text, o) => speak(t, o, (signal) => {
      const form = multipart({ text, voice_url: voice });
      return fetch(`${url}/tts`, { method: "POST", headers: { "content-type": form.type }, body: form.body, signal }); // @spec VOICE-POC-001, VOICE-POC-002, VOICE-POC-003
    }),
    // @spec VOICE-HLTH-007
    ping: async (signal) => {
      try {
        // A probe that hangs counts as a failed one after the engine's own timeout (VOICE-HLTH-008).
        const res = await fetch(`${url}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout_ms)]) });
        await res.text().catch(() => undefined);
        return res.ok;
      } catch { return false; }
    },
    fingerprint: () => fingerprint, // @spec VOICE-CLIP-014
  };
}

function stubEngine(cfg: VoiceCfg): TtsEngine { // @spec VOICE-STUB-001
  return {
    name: "stub",
    concurrency: Infinity,
    synthesize: async (text) => {
      const ms = Math.max(STUB_MIN_MS, text.length * STUB_MS_PER_CHAR);
      const frames = Math.round((cfg.sample_rate * ms) / 1000);
      async function* silence(): AsyncIterable<Buffer> { yield Buffer.alloc(frames * 2); } // zero-filled = silence
      return { format: { sampleRate: cfg.sample_rate, channels: 1, bitDepth: 16 }, chunks: silence() };
    },
    fingerprint: () => ({ name: "stub" }),
  };
}
