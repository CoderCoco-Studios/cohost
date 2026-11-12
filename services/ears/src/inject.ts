import type { Bus, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler as createSharedInjectHandler, type InjectHandler } from "@cohost/shared";
import { wavDurationMs } from "./audio.js";
import { hasWordCharacter } from "./transcript.js";

export { wavDurationMs };

/** The dashboard's audio upload cap (25 MiB) and the time one upload read may take. */
export const INJECT_MAX_BYTES = 26_214_400;
export const INJECT_READ_TIMEOUT_MS = 30_000;

export interface InjectDeps {
  /** `takeUpload` reads the injected clip from Redis. */
  bus: Publisher & Pick<Bus, "takeUpload">;
  log: Logger;
  /** Audio bytes as uploaded (any container the STT server decodes) -> text. */
  transcribe: (audio: Buffer, hint?: { contentType: string }) => Promise<string>;
  now?: () => number;
}

// @spec EARS-INJ-010, EARS-INJ-005, EARS-INJ-006, EARS-INJ-008
/**
 * Handles `inject.request` for ears through the shared inject handler (target `ears`, the one kind `audio`): the
 * uploaded clip goes unchanged to STT and is published as an injected `speech.heard`. `ears.min_speech_ms` does not
 * apply. Needs no Discord.
 */
export function createInjectHandler(d: InjectDeps): InjectHandler {
  return createSharedInjectHandler({
    target: "ears", bus: d.bus, log: d.log, now: d.now,
    takeUpload: (id) => d.bus.takeUpload(id),
    readTimeoutMs: INJECT_READ_TIMEOUT_MS,
    maxBytes: { audio: INJECT_MAX_BYTES },
    kinds: {
      audio: async (audio, r, { contentType }) => {
        const text = (await d.transcribe(audio, { contentType: contentType ?? "audio/wav" })).trim();
        if (!hasWordCharacter(text)) return { ok: false, detail: "empty transcript" };
        const speaker = r.meta?.user || "injected";
        await d.bus.publish("speech.heard", { speaker, text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember });
        d.log.info({ id: r.id, speaker, text }, "heard (injected)");
        return { detail: text };
      },
    },
  });
}
