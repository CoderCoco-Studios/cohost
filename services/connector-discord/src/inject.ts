/**
 * The connector's test input (CONN-INJ): an uploaded audio clip played on the sink path, answered whether or not a Discord
 * session exists. The conversion and the playout are the ones a line from `audio.out.discord` takes.
 */
import { randomUUID } from "node:crypto";
import { AudioPlayerStatus, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import type { Readable } from "node:stream";
import { FrameSequencer, type Bus, type Frame } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { createInjectHandler, parseWav, writeUtterance, type InjectHandler, type InjectOutcome } from "@cohost/shared";
import { OUT_FORMAT, Playout } from "./playout.js";

/** The dashboard's audio upload cap (25 MiB). */
export const INJECT_MAX_BYTES = 26_214_400;
/** Longest accepted clip, ms: what the playout buffers (10 s of the sink format). */
export const CLIP_MAX_MS = 10_000;

/** Where an injected clip goes: a playout (live, or against a player that sends nothing) or nowhere, with the reason. */
export type ClipTarget = { playout: Playout; off: boolean } | { blocked: string };

/** A player that sends nothing: the playout runs as for a real player and every frame is consumed. */
export function nullPlayout(): Playout {
  const player = { play() {}, stop() {}, state: { status: AudioPlayerStatus.Idle } } as unknown as Pick<AudioPlayer, "play" | "stop" | "state">;
  return new Playout({ player, createResource: (stream: Readable) => { stream.resume(); return {} as AudioResource; } });
}

export interface ClipDeps {
  bus: Pick<Bus, "publish" | "takeUpload">;
  log: Pick<Logger, "warn" | "info">;
  /** Read per request: the playout the clip goes to, or why it goes nowhere. */
  target(): ClipTarget;
}

// @spec CONN-INJ-001, CONN-INJ-002, CONN-INJ-003, CONN-INJ-004, CONN-INJ-005, CONN-INJ-006
/** The connector's `inject.request` handler: target `connector-discord`, the one kind `audio`. */
export function createClipHandler(d: ClipDeps): InjectHandler {
  const sequencer = new FrameSequencer();
  return createInjectHandler({
    target: "connector-discord", bus: d.bus as never, log: d.log,
    takeUpload: (id) => d.bus.takeUpload(id),
    maxBytes: { audio: INJECT_MAX_BYTES },
    kinds: {
      audio: async (bytes): Promise<InjectOutcome> => {
        const t = d.target();
        if ("blocked" in t) return { ok: false, detail: t.blocked };
        let wav: ReturnType<typeof parseWav>;
        try { wav = parseWav(bytes); } catch (err) { return { ok: false, detail: (err as Error).message }; }
        const pcm = bytes.subarray(wav.dataOffset, wav.dataOffset + wav.dataLength);
        if (pcm.length < wav.channels * 2) return { ok: false, detail: "clip holds no samples" };
        if (wav.durationMs > CLIP_MAX_MS) return { ok: false, detail: `clip is longer than ${CLIP_MAX_MS / 1000} s` };
        const dropped = t.playout.dropped;
        let frames = 0;
        await writeUtterance(
          { write: async (f: Frame) => { t.playout.push(f); frames++; }, sequencer, format: OUT_FORMAT, leadMs: CLIP_MAX_MS * 2 },
          { utt: randomUUID(), pcm, from: { rate: wav.sampleRate, channels: wav.channels } },
        );
        const ms = Math.round(wav.durationMs);
        const lost = t.playout.dropped - dropped;
        const shown = `${frames} frames (${ms} ms)${lost > 0 ? `, ${lost} dropped` : ""}`;
        return { detail: t.off
          ? `Discord is off: would have played ${shown} at ${OUT_FORMAT.rate} Hz stereo, nothing was sent to a voice channel`
          : `played ${shown}` };
      },
    },
  });
}
