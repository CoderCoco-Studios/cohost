import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { readWavHeader } from "./audio.js";

/** Requests older than this are dropped (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

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

/** The URL to fetch when it lies under `<dashboardUrl>/uploads/` (same origin, normalised path), else undefined. */
export function uploadUrl(raw: string | undefined, dashboardUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const base = new URL(dashboardUrl);
    if (u.origin !== base.origin || u.username || u.password) return undefined;
    const prefix = base.pathname.replace(/\/+$/, "") + "/uploads/";
    return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length ? u.href : undefined;
  } catch {
    return undefined;
  }
}

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

/**
 * Handles `inject.request` for ears: fetches the uploaded clip, sends it unchanged to STT and
 * publishes an injected `speech.heard`. `ears.min_speech_ms` does not apply. Needs no Discord.
 */
export function createInjectHandler(d: InjectDeps): (ev: BusEvent<"inject.request">) => Promise<void> {
  const doFetch = d.fetch ?? fetch;
  const now = d.now ?? Date.now;
  return async (ev) => {
    const r = ev.data;
    if (r.target !== "ears") return;
    const result = (ok: boolean, detail?: string) => d.bus.publish("inject.result", { id: r.id, ok, ...(detail ? { detail } : {}) });
    try {
      if (now() - ev.ts > INJECT_STALE_MS) return void (await result(false, "stale"));
      if (r.kind !== "audio") return void (await result(false, `ears cannot handle kind '${r.kind}'`));
      const target = uploadUrl(r.url, d.dashboardUrl);
      if (!target) return void (await result(false, "url is not an upload of this dashboard"));
      const res = await doFetch(target, { redirect: "error" });
      if (!res.ok) return void (await result(false, `fetch upload ${res.status}`));
      const audio = Buffer.from(await res.arrayBuffer());
      const text = (await d.transcribe(audio, { contentType: res.headers.get("content-type") ?? "audio/wav" })).trim();
      if (!text || /^\W*$/.test(text)) return void (await result(false, "empty transcript"));
      const speaker = r.meta?.user || "injected";
      await d.bus.publish("speech.heard", { speaker, text, durationMs: wavDurationMs(audio), injected: true, remember: r.remember });
      d.log.info({ id: r.id, speaker, text }, "heard (injected)");
      await result(true, text);
    } catch (err) {
      d.log.warn({ err: String(err), id: r.id }, "audio injection failed");
      try { await result(false, String(err)); } catch { /* bus down */ }
    }
  };
}
