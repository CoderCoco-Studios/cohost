/**
 * A connector source: the listening source for a tag a connector serves (the Discord connector serves `discord`). It finds
 * the connector through the registry, reads `audio.in.<tag>` frames live, cuts each speaker's frames into utterances by the
 * gap between frames, and hands each to `Hearing`. A tag whose registration says `transport` `http` is read from ears'
 * `http` listener instead (EARS-SRC-009).
 */
import { FrameTracker, type Bus, type ConnectorRegistry } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { CaptureAdapter, HearClip } from "./capture.js";

/** Frames of a connector source are 16 kHz mono (CONN-AUD-003). */
const IN_FORMAT = { rate: 16000, channels: 1 };

/** The `http` listener a stream-less tag shares with the `http` source: started on demand, ok while bound. */
export interface HttpListener {
  ensure(): Promise<void>;
  bound(): boolean;
}

export interface ConnectorSourceDeps {
  /** The source tag, which is also the connector source's name. */
  name: string;
  bus: Pick<Bus, "tailAudio">;
  registry: ConnectorRegistry;
  hear: HearClip;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** `ears.silence_ms`: an utterance closes when no frame from its speaker has arrived for this long. */
  silenceMs: number;
  listener?: HttpListener;
}

export interface ConnectorSource extends CaptureAdapter {
  /** `lost n, dropped m`, plus `<tag> connector not connected` while the source is down; for the heartbeat detail. */
  detail(): string;
  /** The frame accounting alone. */
  stats(): string;
}

interface Open { name: string; chunks: Buffer[]; timer: ReturnType<typeof setTimeout>; lastAt: number }

// @spec EARS-CON-001, EARS-CON-003, EARS-CON-004, EARS-CON-005, EARS-HEAR-001, EARS-HEAR-002, EARS-SRC-009, EARS-SRC-012, EARS-SRC-004, CONN-AUD-004, CONN-DESK-003
export function createConnectorSource(d: ConnectorSourceDeps): ConnectorSource {
  const tracker = new FrameTracker(IN_FORMAT);
  const open = new Map<string, Open>();
  const inflight = new Set<Promise<unknown>>();
  let stopped = false;
  let tailing = false;
  let unsubscribe: (() => void) | undefined;

  const transport = (): "stream" | "http" | undefined => d.registry.offer("audio-in", d.name)?.cap.transport;

  const close = (spk: string): void => {
    const o = open.get(spk);
    if (!o) return;
    clearTimeout(o.timer);
    open.delete(spk);
    const p = d.hear({ pcm: Buffer.concat(o.chunks), ...IN_FORMAT, audioEndedAt: o.lastAt }, o.name, d.name, spk)
      .catch((err) => d.log.error({ err: String(err), source: d.name }, "ears connector source: hearing failed"));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  // @spec EARS-HEAR-001, CONN-AUD-004
  const onFrame = (decoded: Parameters<typeof tracker.accept>[0]): void => {
    if (stopped) return;
    const f = tracker.accept(decoded);
    if (!f) return;
    if (transport() === "http") return; // clips for this tag arrive on the listener, not the stream
    const spk = f.spk || d.name;
    const name = f.name || spk;
    const o = open.get(spk);
    if (o) {
      clearTimeout(o.timer);
      o.chunks.push(f.pcm);
      o.name = f.name || o.name;
      o.lastAt = Date.now();
      o.timer = setTimeout(() => close(spk), d.silenceMs);
    } else {
      open.set(spk, { name, chunks: [f.pcm], timer: setTimeout(() => close(spk), d.silenceMs), lastAt: Date.now() });
    }
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
      for (const o of open.values()) clearTimeout(o.timer);
      open.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}
