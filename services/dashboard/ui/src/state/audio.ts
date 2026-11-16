import { createStore, type Store } from "./store";
import type { Feed } from "./feed";

export interface AudioState {
  /** Whether utterances are played. Off until the operator turns it on, except on the sink page (DASH-UI-011). */
  enabled: boolean;
  /** The utterance id being played, if any. */
  playing: string | null;
  /** Utterances waiting behind it. */
  queued: number;
}

export interface Audio {
  state: Store<AudioState>;
  enable(): void;
  /** Turning audio off by hand drops what had not started (DASH-UI-014). */
  disable(): void;
}

export interface AudioDeps {
  feed: Pick<Feed, "onEvent">;
  /** Posts the sink's `playing` / `done` report (`POST /sink`). */
  sink: (event: "playing" | "done", id: string) => Promise<unknown>;
  createAudio?: (src: string) => HTMLAudioElement;
  enabled?: boolean;
}

/**
 * The browser audio sink (design: Audio). A live `voice.utterance` is queued while audio is on and played one at a time
 * from `/audio/<id>.wav`, posting `playing` on start and `done` on end or error; a replayed one is never played; a refused
 * `play()` posts `done`, switches audio off and keeps the queue (DASH-UI-012, 013, 014, 022). Event ids are handled once
 * by the feed, so a line seen live and in a replay plays once.
 */
// @spec DASH-UI-012, DASH-UI-013, DASH-UI-014, DASH-UI-022
export function createAudio(deps: AudioDeps): Audio {
  const make = deps.createAudio ?? ((src) => new window.Audio(src));
  const state = createStore<AudioState>({ enabled: deps.enabled ?? false, playing: null, queued: 0 });
  const queue: string[] = [];
  const sync = (): void => state.set((s) => ({ ...s, queued: queue.length }));
  const report = (event: "playing" | "done", id: string): void => { void deps.sink(event, id).catch(() => undefined); };

  async function pump(): Promise<void> {
    if (!state.get().enabled || state.get().playing !== null || queue.length === 0) return;
    const id = queue.shift()!;
    state.set((s) => ({ ...s, playing: id, queued: queue.length }));
    const a = make(`/audio/${encodeURIComponent(id)}.wav`);
    let finished = false; // reported done once, whichever of ended, error or a refused play() comes first
    const finish = (): boolean => { if (finished) return false; finished = true; report("done", id); state.set((s) => ({ ...s, playing: null })); return true; };
    a.onplay = () => report("playing", id);
    a.onended = a.onerror = () => { if (finish()) void pump(); };
    try { await a.play(); } catch { if (finish()) state.set((s) => ({ ...s, enabled: false })); }
  }

  deps.feed.onEvent((ev, replay) => {
    if (ev.type !== "voice.utterance" || replay || !state.get().enabled) return;
    const id = (ev.data as { id?: unknown }).id;
    if (typeof id !== "string") return;
    queue.push(id); sync(); void pump();
  });

  return {
    state,
    enable() { state.set((s) => ({ ...s, enabled: true })); void pump(); },
    disable() { queue.length = 0; state.set((s) => ({ ...s, enabled: false, queued: 0 })); },
  };
}
