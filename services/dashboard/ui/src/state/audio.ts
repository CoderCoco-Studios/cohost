import { createStore, type Store } from "./store";
import type { Feed } from "./feed";

export interface AudioState {
  /** Whether clauses are played. Off until the operator turns it on, except on the sink page (DASH-UI-011). */
  enabled: boolean;
  /** The line whose clip is being played, if any. */
  playing: string | null;
  /** Clauses waiting behind it. */
  queued: number;
}

export interface Audio {
  state: Store<AudioState>;
  enable(): void;
  /** Turning audio off by hand drops what had not started (DASH-UI-014) and finishes every open line (DASH-UI-051). */
  disable(): void;
}

/** One report the page posts to `POST /sink` (DASH-SINK-002, 005..007). */
export interface SinkReport {
  event: "playing" | "done";
  id: string;
  seq: number;
  interrupted?: true;
  final?: true;
  spokenText?: string;
  unsaidText?: string;
}

export interface AudioDeps {
  feed: Pick<Feed, "onEvent">;
  /** Posts a report to `/sink`; `keepalive` asks the browser to let it outlive the page (unload). */
  sink: (report: SinkReport, opts?: { keepalive?: boolean }) => Promise<unknown>;
  createAudio?: (src: string) => HTMLAudioElement;
  enabled?: boolean;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  /** Where `pagehide` is listened for; the window by default. */
  target?: EventTarget;
}

/** A line with no clause activity for this long ends on the page (DASH-UI-044). */
export const LINE_IDLE_MS = 300_000;

/** The page's view of one line (a `brain.say` id): what it has played, what it waits for, and whether it has ended. */
interface Line {
  id: string;
  /** Clause 0 has arrived on the page (it may be queued, played, or refused). */
  zeroSeen: boolean;
  /** The page will not play this line: audio was off, it joined mid-line, or clause 0 came in the replay (DASH-UI-045). */
  skipped: boolean;
  /** The page is taking no more of this line's clauses and posts nothing more for it (DASH-UI-044). */
  ended: boolean;
  /** Open on the page from its own `playing` post (DASH-UI-043). */
  open: boolean;
  /** Clause 0 carried `more`. */
  streamed: boolean;
  /** The seqs of clauses that have arrived. */
  received: Set<number>;
  /** The highest seq started, or -1. */
  lastStarted: number;
  /** The highest seq that has finished on the page, or -1. */
  finishedSeq: number;
  /** The texts of the clauses that finished, in order. */
  spoken: string[];
  /** A closing `brain.clause` arrived; clauses above `through` are not played. */
  closed: boolean;
  through: number;
  timer?: number;
}

interface Item {
  line: Line;
  seq: number;
  text: string;
}

interface Playing {
  item: Item;
  audio: HTMLAudioElement;
  /** Set once the clip has reported its end, an interruption or a refusal; nothing else reports it. */
  done: boolean;
}

/** The words of `text` that a clip of `length` seconds has spoken by `at` seconds, cut at a word boundary (floor by words). */
function splitWords(text: string, at: number, length: number): { spoken: string; rest: string } {
  const words = text.split(/\s+/).filter(Boolean);
  const frac = Number.isFinite(at) && Number.isFinite(length) && length > 0 ? Math.min(1, Math.max(0, at / length)) : 0;
  const n = Math.floor(words.length * frac);
  return { spoken: words.slice(0, n).join(" "), rest: words.slice(n).join(" ") };
}

const joinTexts = (parts: string[]): string => parts.filter((p) => p !== "").join(" ");

/**
 * The browser audio sink (design: Audio). A live `voice.utterance` is one clause of a line: while audio is on, the
 * clauses play one at a time in arrival order from `/audio/<id>-<seq>.wav`, each posting `playing` when it starts and
 * `done` when it ends or errors. A line is open from its own clause 0 and ends by its closing `brain.clause` (DASH-UI-044),
 * a live `voice.stop`, its own `final`, or 300 s without clause activity. A `voice.stop` reports the interrupted split,
 * audio switched off or the page unloading reports `final`, and a refused `play()` turns audio off and reports `final`
 * (DASH-UI-011..014, 022, 043..053). The page keeps no state the feed cannot rebuild, and a replayed event is never played.
 */
// @spec DASH-UI-011, DASH-UI-012, DASH-UI-013, DASH-UI-014, DASH-UI-022, DASH-UI-043, DASH-UI-044, DASH-UI-045, DASH-UI-046, DASH-UI-047, DASH-UI-048, DASH-UI-049, DASH-UI-050, DASH-UI-051, DASH-UI-052, DASH-UI-053
export function createAudio(deps: AudioDeps): Audio {
  const make = deps.createAudio ?? ((src) => new window.Audio(src));
  const setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));
  const state = createStore<AudioState>({ enabled: deps.enabled ?? false, playing: null, queued: 0 });
  const lines = new Map<string, Line>();
  let queue: Item[] = [];
  let current: Playing | null = null;

  const post = (report: SinkReport, opts?: { keepalive?: boolean }): void => { void deps.sink(report, opts).catch(() => undefined); };
  const sync = (): void => state.set((s) => ({ ...s, queued: queue.length, playing: current ? current.item.line.id : null }));

  const lineOf = (id: string): Line => {
    let l = lines.get(id);
    if (!l) {
      l = { id, zeroSeen: false, skipped: false, ended: false, open: false, streamed: false, received: new Set(), lastStarted: -1, finishedSeq: -1, spoken: [], closed: false, through: 0 };
      lines.set(id, l);
    }
    return l;
  };

  const disarm = (l: Line): void => { if (l.timer !== undefined) { clearT(l.timer); l.timer = undefined; } };
  const arm = (l: Line): void => {
    disarm(l);
    if (l.ended) return;
    l.timer = setT(() => { l.timer = undefined; endLine(l); pump(); }, LINE_IDLE_MS);
  };

  /** The line is finished on the page: its queued clauses are dropped; a clip already playing still reports its end. */
  function endLine(l: Line): void {
    if (l.ended) return;
    l.ended = true;
    l.open = false;
    disarm(l);
    queue = queue.filter((i) => i.line !== l);
  }

  /** Closing clause read and the last clause at or below `through` has finished (at once when it already has, DASH-UI-044). */
  function reachedThrough(l: Line): boolean {
    if (!l.closed) return false;
    let top = -1;
    for (const s of l.received) if (s <= l.through && s > top) top = s;
    return top >= 0 && l.finishedSeq >= top;
  }

  function start(item: Item): void {
    const { line, seq } = item;
    const a = make(`/audio/${encodeURIComponent(line.id)}-${seq}.wav`);
    const p: Playing = { item, audio: a, done: false };
    current = p;
    line.lastStarted = Math.max(line.lastStarted, seq);
    a.onplay = () => {
      if (p.done) return;
      line.open = true;
      post({ event: "playing", id: line.id, seq });
    };
    a.onended = a.onerror = () => finishClip(p);
    let started: Promise<void>;
    try { started = a.play(); } catch (err) { started = Promise.reject(err); }
    started.catch(() => refuse(p));
  }

  function finishClip(p: Playing): void {
    if (p.done) return;
    p.done = true;
    const { item } = p;
    const l = item.line;
    if (current === p) current = null;
    l.finishedSeq = Math.max(l.finishedSeq, item.seq);
    l.spoken.push(item.text);
    post({ event: "done", id: l.id, seq: item.seq });
    if (!l.streamed || reachedThrough(l)) endLine(l);
    pump();
  }

  /** The browser refused to start the clip: audio goes off, the line is dropped, and `final` is reported (DASH-UI-052). */
  function refuse(p: Playing): void {
    if (p.done) return;
    p.done = true;
    const { item } = p;
    const l = item.line;
    if (current === p) current = null;
    state.set((s) => ({ ...s, enabled: false }));
    if (item.seq === 0 || l.open) post({ event: "done", id: l.id, seq: item.seq, final: true });
    endLine(l);
    sync();
  }

  function pump(): void {
    while (state.get().enabled && !current && queue.length > 0) {
      const item = queue.shift()!;
      if (item.line.ended || item.line.skipped) continue;
      start(item);
    }
    sync();
  }

  /** A live `voice.stop` cuts the clip of a named line and reports the split, or reports the last clause of an open line (DASH-UI-048, 049). */
  function stopLines(ids: string[] | undefined): void {
    const targets = ids !== undefined && ids.length > 0 ? ids.map(lineOf) : [...lines.values()];
    for (const l of targets) {
      if (l.ended) continue;
      if (current && current.item.line === l) {
        const p = current;
        p.done = true;
        current = null;
        try { p.audio.pause(); } catch { /* the clip is already gone */ }
        const { spoken, rest } = splitWords(p.item.text, p.audio.currentTime, p.audio.duration);
        const queued = queue.filter((i) => i.line === l).map((i) => i.text);
        post({ event: "done", id: l.id, seq: p.item.seq, interrupted: true, ...spokenFields(joinTexts([...l.spoken, spoken]), joinTexts([rest, ...queued])) });
      } else if (l.open) {
        const queued = queue.filter((i) => i.line === l).map((i) => i.text);
        post({ event: "done", id: l.id, seq: l.finishedSeq, interrupted: true, ...spokenFields(joinTexts(l.spoken), joinTexts(queued)) });
      }
      endLine(l);
    }
    pump();
  }

  /** The text fields of an interrupted report; an empty text is left out (DASH-UI-048). */
  function spokenFields(spokenText: string, unsaidText: string): { spokenText?: string; unsaidText?: string } {
    return { ...(spokenText !== "" ? { spokenText } : {}), ...(unsaidText !== "" ? { unsaidText } : {}) };
  }

  function onUtterance(d: Record<string, unknown>, replay: boolean): void {
    const { id, seq } = d;
    if (typeof id !== "string" || typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return;
    const l = lineOf(id);
    if (replay || !state.get().enabled) { l.skipped = true; disarm(l); return; } // DASH-UI-013, DASH-UI-014, DASH-UI-045
    if (l.ended || l.skipped) return;
    if (seq > 0 && !l.zeroSeen) { l.skipped = true; disarm(l); return; } // joined mid-line (DASH-UI-045)
    if (seq === 0) { l.zeroSeen = true; l.streamed = d.more === true; }
    if (l.closed && seq > l.through) return; // above the closing clause's through (DASH-UI-044)
    l.received.add(seq);
    queue.push({ line: l, seq, text: typeof d.text === "string" ? d.text : "" });
    arm(l);
    pump();
  }

  function onClause(d: Record<string, unknown>): void {
    if (typeof d.id !== "string") return;
    const l = lineOf(d.id);
    if (l.ended) return;
    if (d.last === true && typeof d.through === "number" && Number.isInteger(d.through)) {
      l.closed = true;
      l.through = d.through;
      queue = queue.filter((i) => !(i.line === l && i.seq > l.through));
      if (reachedThrough(l)) endLine(l);
    }
    arm(l);
    pump();
  }

  deps.feed.onEvent((ev, replay) => {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === "voice.utterance") onUtterance(d, replay);
    else if (ev.type === "brain.clause") { if (!replay) onClause(d); }
    else if (ev.type === "voice.stop") {
      if (replay) return; // DASH-UI-053
      stopLines(Array.isArray(d.ids) ? d.ids.filter((x): x is string => typeof x === "string") : undefined);
    }
  });

  /** Every open line is finished with `final`, once, for the first clause it will not play (DASH-UI-051). */
  function finishOpenLines(keepalive: boolean): void {
    for (const l of lines.values()) {
      if (!l.open || l.ended) continue;
      post({ event: "done", id: l.id, seq: l.lastStarted + 1, final: true }, keepalive ? { keepalive: true } : undefined);
      endLine(l);
    }
  }

  (deps.target ?? window).addEventListener("pagehide", () => { finishOpenLines(true); sync(); });

  return {
    state,
    enable() { state.set((s) => ({ ...s, enabled: true })); pump(); },
    disable() {
      finishOpenLines(false);
      queue = [];
      state.set((s) => ({ ...s, enabled: false }));
      sync();
    },
  };
}
