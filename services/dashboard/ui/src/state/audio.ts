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
/** Ended line ids remembered, so a late clause or stop for one is still refused after its record is dropped. */
const ENDED_LIMIT = 300;

/** The page's view of one line (a `brain.say` id) while it is live on the page. */
interface Line {
  id: string;
  /** Clause 0 has arrived on the page. */
  zeroSeen: boolean;
  /** The page is taking no more of this line's clauses and posts nothing more for it, except its `final` (DASH-UI-044). */
  ended: boolean;
  /** Open on the page from its clause 0's own `playing` post (DASH-UI-043). */
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
  /** Set when the line is finished while its clip plays: its `final` follows that clip's `done`. */
  finalAfter: boolean;
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

const newLine = (id: string): Line => ({
  id, zeroSeen: false, ended: false, open: false, streamed: false, received: new Set(), lastStarted: -1, finishedSeq: -1,
  spoken: [], closed: false, through: 0, finalAfter: false,
});

/**
 * The browser audio sink (design: Audio). A live `voice.utterance` is one clause of a line: while audio is on, the
 * clauses play one at a time in arrival order from `/audio/<id>-<seq>.wav`, each posting `playing` when it starts and
 * `done` when it ends or errors. A line is open from its own clause 0 and ends by its closing `brain.clause` (DASH-UI-044),
 * a live `voice.stop`, its `final`, or 300 s without clause activity. A `voice.stop` reports the interrupted split; audio
 * switched off or the page unloading reports `final` for each open line; a refused `play()` turns audio off and reports
 * `final` only for a line that was open (DASH-UI-011..014, 022, 043..053). A replayed event is never played.
 */
// @spec DASH-UI-011, DASH-UI-012, DASH-UI-013, DASH-UI-014, DASH-UI-022, DASH-UI-043, DASH-UI-044, DASH-UI-045, DASH-UI-046, DASH-UI-047, DASH-UI-048, DASH-UI-049, DASH-UI-050, DASH-UI-051, DASH-UI-052, DASH-UI-053
export function createAudio(deps: AudioDeps): Audio {
  const make = deps.createAudio ?? ((src) => new window.Audio(src));
  const setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));
  const state = createStore<AudioState>({ enabled: deps.enabled ?? false, playing: null, queued: 0 });
  /** Live lines only: an ended line is removed, and its id goes to `endedIds`. */
  const lines = new Map<string, Line>();
  const endedIds = new Set<string>();
  let queue: Item[] = [];
  let current: Playing | null = null;

  const post = (report: SinkReport, opts?: { keepalive?: boolean }): void => { void deps.sink(report, opts).catch(() => undefined); };
  const sync = (): void => state.set((s) => ({ ...s, queued: queue.length, playing: current ? current.item.line.id : null }));

  /** The line for an id: a live record, a stub for an ended id (never stored), or a new record. */
  const lineOf = (id: string): Line => {
    const live = lines.get(id);
    if (live) return live;
    const l = newLine(id);
    if (endedIds.has(id)) l.ended = true; else lines.set(id, l);
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
    disarm(l);
    queue = queue.filter((i) => i.line !== l);
    if (lines.get(l.id) === l) lines.delete(l.id);
    endedIds.add(l.id);
    if (endedIds.size > ENDED_LIMIT) endedIds.delete(endedIds.values().next().value as string);
  }

  /**
   * The page takes no more of an open line: its `final`, once, for the first clause it will not play (DASH-UI-051). A line
   * whose clip is playing gets its `final` after that clip's `done`, so a line never reports `done` after `final`.
   */
  /**
   * Unload: the page is going, so the clip is not waited for. Its done and its line's final go now, both with keepalive;
   * the clip's own end, if the browser still fires it, reports nothing.
   */
  function finishPlayingNow(p: Playing, opts: { keepalive: boolean } | undefined): void {
    const l = p.item.line;
    p.done = true;
    current = null;
    try { p.audio.pause(); } catch { /* the page is going */ }
    post({ event: "done", id: l.id, seq: p.item.seq }, opts);
    post({ event: "done", id: l.id, seq: p.item.seq + 1, final: true }, opts);
    l.finalAfter = false;
    endLine(l);
  }

  function finishLine(l: Line, keepalive: boolean): void {
    if (l.ended || !l.open) return;
    const opts = keepalive ? { keepalive: true } : undefined;
    if (current && current.item.line === l) {
      if (!keepalive) { l.finalAfter = true; endLine(l); return; }
      finishPlayingNow(current, opts);
      return;
    }
    post({ event: "done", id: l.id, seq: l.lastStarted + 1, final: true }, opts);
    endLine(l);
  }

  /** Closing clause read and the clause through has finished, or a clause above it has started (DASH-UI-044). */
  function reachedThrough(l: Line): boolean {
    return l.closed && (l.finishedSeq >= l.through || l.lastStarted > l.through);
  }

  function start(item: Item): void {
    const { line, seq } = item;
    const a = make(`/audio/${encodeURIComponent(line.id)}-${seq}.wav`);
    const p: Playing = { item, audio: a, done: false };
    current = p;
    line.lastStarted = Math.max(line.lastStarted, seq);
    arm(line);
    a.onplay = () => {
      if (p.done) return;
      if (seq === 0) line.open = true; // a line opens only on its clause 0 (DASH-UI-043)
      post({ event: "playing", id: line.id, seq });
    };
    a.onended = () => finishClip(p, false);
    a.onerror = () => finishClip(p, true);
    let started: Promise<void>;
    try { started = a.play(); } catch (err) { started = Promise.reject(err); }
    started.catch(() => refuse(p));
  }

  function finishClip(p: Playing, errored: boolean): void {
    if (p.done) return;
    p.done = true;
    const { item } = p;
    const l = item.line;
    if (current === p) current = null;
    l.finishedSeq = Math.max(l.finishedSeq, item.seq);
    if (!errored) l.spoken.push(item.text);
    post({ event: "done", id: l.id, seq: item.seq });
    if (l.finalAfter) { l.finalAfter = false; post({ event: "done", id: l.id, seq: item.seq + 1, final: true }); }
    else if (errored && item.seq === 0 && l.streamed && l.open) post({ event: "done", id: l.id, seq: item.seq + 1, final: true });
    // A clause 0 that errors ends its line: the line is skipped from then on, so no later clause plays (DASH-UI-045).
    if (errored && item.seq === 0) endLine(l);
    arm(l);
    if (!l.streamed || reachedThrough(l)) endLine(l);
    pump();
  }

  /** The browser refused to start the clip: audio goes off, the line is dropped, and open lines are finished (DASH-UI-052). */
  function refuse(p: Playing): void {
    if (p.done) return;
    p.done = true;
    const { item } = p;
    const l = item.line;
    if (current === p) current = null;
    state.set((s) => ({ ...s, enabled: false }));
    if (l.open) post({ event: "done", id: l.id, seq: item.seq, final: true });
    endLine(l);
    finishOpenLines(false);
    sync();
  }

  function pump(): void {
    while (state.get().enabled && !current && queue.length > 0) {
      const item = queue.shift()!;
      if (item.line.ended) continue;
      start(item);
    }
    sync();
  }

  /** Cuts the clip that is playing and reports the split (DASH-UI-048). */
  function cutCurrent(p: Playing): void {
    const l = p.item.line;
    p.done = true;
    current = null;
    try { p.audio.pause(); } catch { /* the clip is already gone */ }
    const { spoken, rest } = splitWords(p.item.text, p.audio.currentTime, p.audio.duration);
    const queued = queue.filter((i) => i.line === l).map((i) => i.text);
    post({ event: "done", id: l.id, seq: p.item.seq, interrupted: true, ...spokenFields(joinTexts([...l.spoken, spoken]), joinTexts([rest, ...queued])) });
  }

  /** A live `voice.stop` cuts the clip of a named line and reports the split, or reports the last clause of an open line (DASH-UI-048, 049). */
  function stopLines(ids: string[] | undefined): void {
    const named = ids !== undefined && ids.length > 0 ? ids : undefined;
    // Audio switched off mid-clip finished the line but left its clip to play; the stop cuts that clip (DASH-UI-047).
    const cur = current;
    if (cur && cur.item.line.finalAfter && (named === undefined || named.includes(cur.item.line.id))) {
      cur.item.line.finalAfter = false;
      cutCurrent(cur);
    }
    const targets = named !== undefined ? named.map(lineOf) : [...lines.values()];
    for (const l of targets) {
      if (l.ended) continue;
      if (current && current.item.line === l) {
        cutCurrent(current);
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
    if (l.ended) return;
    // Audio off or a replayed clause: an open line is finished now; any other line is skipped (DASH-UI-013, 014, 045).
    if (replay || !state.get().enabled) { if (l.open) finishLine(l, false); else endLine(l); return; }
    if (seq > 0 && !l.zeroSeen) { endLine(l); return; } // joined mid-line (DASH-UI-045)
    if (seq === 0) { l.zeroSeen = true; l.streamed = d.more === true; }
    if (l.closed && seq > l.through) return; // above the closing clause's through (DASH-UI-044)
    if (l.received.has(seq)) return; // a repeated clause plays once
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

  function finishOpenLines(keepalive: boolean): void {
    for (const l of [...lines.values()]) finishLine(l, keepalive);
  }

  (deps.target ?? window).addEventListener("pagehide", () => {
    // A line finished by audio off whose clip still plays has no open entry left to finish: finish its clip now.
    if (current && current.item.line.finalAfter) finishPlayingNow(current, { keepalive: true });
    finishOpenLines(true);
    sync();
  });

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
