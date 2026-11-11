import type { Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler as createSharedInjectHandler, type InjectHandler } from "@cohost/shared";
import { readWavHeader } from "./audio.js";

/** The dashboard's audio upload cap (25 MiB) and the time one upload fetch may take. */
export const INJECT_MAX_BYTES = 26_214_400;
export const INJECT_FETCH_TIMEOUT_MS = 30_000;

export interface InjectDeps {
  bus: Publisher;
  log: Logger;
  /** `urls.dashboard()`: the only origin uploads may be fetched from. */
  dashboardUrl: string;
  /** Audio bytes as uploaded (any container the STT server decodes) -> text. */
  transcribe: (audio: Buffer, hint?: { contentType: string }) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
}

// @spec EARS-INJ-006
/** Duration from a WAV header, 0 for anything else (or an unreadable header). */
export function wavDurationMs(buf: Buffer): number {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return 0;
  try {
    const { sampleRate, channels, dataLength } = readWavHeader(buf);
    if (!sampleRate || !channels) return 0;
    return Math.round((dataLength / (channels * 2) / sampleRate) * 1000);
  } catch {
    return 0;
  }
}

// @spec EARS-INJ-010, EARS-INJ-005, EARS-INJ-006, EARS-INJ-008
/**
 * Handles `inject.request` for ears through the shared inject handler (target `ears`, the one kind `audio`): the
 * uploaded clip goes unchanged to STT and is published as an injected `speech.heard`. `ears.min_speech_ms` does not
 * apply. Needs no Discord.
 */
export function createInjectHandler(d: InjectDeps): InjectHandler {
  return createSharedInjectHandler({
    target: "ears", bus: d.bus, log: d.log, dashboardUrl: d.dashboardUrl, fetch: d.fetch, now: d.now,
    fetchTimeoutMs: INJECT_FETCH_TIMEOUT_MS,
    maxBytes: { audio: INJECT_MAX_BYTES },
    kinds: {
      audio: async (audio, r, { contentType }) => {
        const text = (await d.transcribe(audio, { contentType: contentType ?? "audio/wav" })).trim();
        if (!text || /^\W*$/.test(text)) return { ok: false, detail: "empty transcript" };
        const speaker = r.meta?.user || "injected";
        await d.bus.publish("speech.heard", { speaker, text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember });
        d.log.info({ id: r.id, speaker, text }, "heard (injected)");
        return { detail: text };
      },
    },
  });
}
