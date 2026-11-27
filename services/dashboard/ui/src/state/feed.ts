import { createStore, type Store } from "./store";
import { parseCatalog, type CatalogState, type PendingConfirm } from "./tools";
import type { FeedEvent, ServiceHealth, StackProgress, StackSnapshot } from "./types";

/** The event types that get a row in the Activity feed (DASH-UI-002); every other type is dropped from the log. */
// @spec DASH-UI-042
export const FEED_TYPES: ReadonlySet<string> = new Set([
  "chat.message", "brain.say", "vision.summary", "speech.heard", "brain.status", "control", "service.lifecycle",
  "inject.request", "inject.result", "voice.utterance", "voice.playing", "voice.done",
  "tool.request", "tool.result", "tool.timer",
]);

/** Rows the log keeps (DASH-UI-002). */
export const LOG_LIMIT = 300;
/** How long after the socket closes the next attempt starts (DASH-UI-001). */
export const RECONNECT_MS = 2000;
/** Event ids remembered so each is handled at most once (DASH-UI-013). */
const SEEN_LIMIT = 4000;

export interface FeedState {
  /** `connecting` until the first open and again while a reconnect attempt is in flight; `closed` between attempts. */
  status: "connecting" | "open" | "closed";
  /** While closed: when the feed stopped and when the next attempt starts (ms since the epoch), for the banner. */
  stoppedAt?: number;
  nextAttemptAt?: number;
  /** The latest `services` snapshot, or null until the first arrives (the Services screen shows its loading state). */
  services: ServiceHealth[] | null;
  /** When that snapshot arrived (page clock); a service's age is `lastSeenAgeMs + (now - servicesAt)`. */
  servicesAt: number;
  stack: StackSnapshot | null;
  /** The latest `stack-progress` record, or null until one arrives (the Launch panel, DASH-UI-055). */
  progress: StackProgress | null;
  /** Rendered event types, oldest first, at most `LOG_LIMIT`, replayed events included and flagged. */
  events: FeedEvent[];
  /** The latest event of each type (`brain.status`, `avatar.state`, ...), whether or not it is a rendered type. */
  latest: Record<string, FeedEvent>;
  /** The latest `mute` or `unmute` control event seen, live or replayed; unmuted until one is seen (DASH-UI-005). */
  muted: boolean;
  /** Each co-host line's row: the latest accepted clause `seq` and the row's text (`brain.say` text plus its clauses), by line id, at most `LOG_LIMIT` lines. */
  lines: Record<string, LineRow>;
  /** Tool calls waiting for the owner's answer, in arrival order (DASH-TOOL-003). */
  confirms: PendingConfirm[];
  /** The page clock as of the last countdown tick, so a countdown re-renders each second (DASH-TOOL-004). */
  tick: number;
  /** The latest `tool.catalog`, or null before the first (DASH-TOOL-023). */
  catalog: CatalogState | null;
}

export interface LineRow {
  seq: number;
  text: string;
  /** The `cut` of the line's closing clause, when it carried one (DASH-UI-041). */
  cut?: string;
}

/** A listener receives every event once, with `replay` true for the connect replay (never play or act on those). */
export type EventListener = (event: FeedEvent, replay: boolean) => void;

export interface Feed {
  state: Store<FeedState>;
  start(): void;
  stop(): void;
  /** Subscribes to every first-seen event (all types, not only the rendered ones); returns the unsubscribe function. */
  onEvent(listener: EventListener): () => void;
}

export interface FeedDeps {
  /** `ws://` or `wss://` plus the page's host and `/ws`. */
  url: string;
  createSocket?: (url: string) => WebSocket;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  now?: () => number;
}

/** The `/ws` URL for a page location: `wss` over HTTPS (DASH-UI-001). */
export function feedUrl(loc: Pick<Location, "protocol" | "host"> = location): string {
  return `${loc.protocol === "https:" ? "wss:" : "ws:"}//${loc.host}/ws`;
}

const initial = (): FeedState => ({ status: "connecting", services: null, servicesAt: 0, stack: null, progress: null, events: [], latest: {}, muted: false, lines: {}, confirms: [], tick: 0, catalog: null });

/** The line rows after one `brain.say` or `brain.clause` (DASH-UI-038..040); undefined when the event changes no row. */
// @spec DASH-UI-038, DASH-UI-039, DASH-UI-040, DASH-UI-041
function nextLines(lines: Record<string, LineRow>, ev: FeedEvent): Record<string, LineRow> | undefined {
  const d = (ev.data ?? {}) as { id?: unknown; seq?: unknown; text?: unknown };
  if (typeof d.id !== "string") return undefined;
  const text = typeof d.text === "string" ? d.text : "";
  if (ev.type === "brain.say") return withLine(lines, d.id, { seq: 0, text });
  const row = lines[d.id];
  if (!row) return undefined; // no row for this line (trimmed, or joined mid-line): dropped silently
  if (d.seq !== row.seq + 1) {
    console.warn(`dropped brain.clause for line ${d.id}: seq ${String(d.seq)} after ${row.seq}`);
    return undefined;
  }
  const closing = (ev.data as { last?: unknown; cut?: unknown }).last === true ? (ev.data as { cut?: unknown }).cut : undefined;
  return withLine(lines, d.id, { seq: d.seq as number, text: [row.text, text].filter((t) => t !== "").join(" "), ...(typeof closing === "string" && closing !== "" ? { cut: closing } : {}) });
}

/** Sets one line's row, keeping at most `LOG_LIMIT` lines (the oldest go first). */
function withLine(lines: Record<string, LineRow>, id: string, row: LineRow): Record<string, LineRow> {
  const next = { ...lines, [id]: row };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - LOG_LIMIT))) delete next[k];
  return next;
}

/**
 * The `/ws` connection as a store (DASH-UI-001). Parses each frame defensively, routes the `services` and `stack`
 * snapshots into state, de-duplicates bus events by id, keeps the rendered rows, and reconnects every 2 s while the
 * socket is closed, recording when it stopped and when it will try again for the connection banner.
 */
// @spec DASH-UI-001, DASH-UI-002, DASH-UI-005, DASH-UI-013, DASH-TOOL-003, DASH-TOOL-004, DASH-TOOL-005, DASH-TOOL-023, DASH-TOOL-024
export function createFeed(deps: FeedDeps): Feed {
  const state = createStore<FeedState>(initial());
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));
  const make = deps.createSocket ?? ((u) => new WebSocket(u));
  const listeners = new Set<EventListener>();
  const seen = new Set<string>();
  let socket: WebSocket | undefined;
  let timer: number | undefined;
  let stopped = false;
  // Tool confirmation countdowns run on the injected timers and clock, never on the host's clock (DASH-TOOL-004).
  const expiry = new Map<string, number>();
  let ticker: number | undefined;
  let catalogTimer: number | undefined;

  const stopTick = (): void => { if (ticker !== undefined) { clearT(ticker); ticker = undefined; } };
  const startTick = (): void => {
    if (ticker !== undefined || expiry.size === 0) return;
    ticker = setT(() => { ticker = undefined; state.set((s) => ({ ...s, tick: now() })); startTick(); }, 1000);
  };
  /** Removes a call's bar and cancels its timer; the countdown ticker stops with the last one. */
  const dropConfirm = (id: string): void => {
    const t = expiry.get(id);
    if (t !== undefined) { clearT(t); expiry.delete(id); }
    state.set((s) => (s.confirms.some((c) => c.id === id) ? { ...s, confirms: s.confirms.filter((c) => c.id !== id) } : s));
    if (expiry.size === 0) stopTick();
  };
  /** A live `tool.confirm` becomes a bar that counts down the time between the event and its `expiresAt` by the page's clock; a replayed one never does (DASH-TOOL-003). */
  const addConfirm = (ev: FeedEvent): void => {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (typeof d.id !== "string" || typeof d.expiresAt !== "number" || typeof ev.ts !== "number") return;
    const remaining = d.expiresAt - ev.ts;
    if (!(remaining > 0) || expiry.has(d.id)) return;
    const id = d.id;
    const confirm: PendingConfirm = { id, tool: typeof d.tool === "string" ? d.tool : "", args: d.arguments, origin: typeof d.origin === "string" ? d.origin : "", deadline: now() + remaining, redacted: d.redacted === true };
    state.set((s) => ({ ...s, confirms: [...s.confirms, confirm], tick: now() }));
    expiry.set(id, setT(() => dropConfirm(id), remaining));
    startTick();
  };
  const setCatalog = (ev: FeedEvent): void => {
    const data = parseCatalog(ev.data);
    if (!data) return;
    if (catalogTimer !== undefined) clearT(catalogTimer);
    state.set((s) => ({ ...s, catalog: { data, stale: false } }));
    catalogTimer = setT(() => { catalogTimer = undefined; state.set((s) => (s.catalog ? { ...s, catalog: { ...s.catalog, stale: true } } : s)); }, 3 * data.intervalMs);
  };

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    return true;
  };

  function onEvent(ev: FeedEvent): void {
    if (typeof ev.id !== "string" || !remember(ev.id)) return;
    const replay = ev.replay === true;
    const lines = ev.type === "brain.say" || ev.type === "brain.clause" ? nextLines(state.get().lines, ev) : undefined;
    state.set((s) => {
      const events = FEED_TYPES.has(ev.type) ? [...s.events, ev].slice(-LOG_LIMIT) : s.events;
      const cmd = ev.type === "control" ? (ev.data as { cmd?: string }).cmd : undefined;
      return { ...s, events, latest: { ...s.latest, [ev.type]: ev }, muted: cmd === "mute" ? true : cmd === "unmute" ? false : s.muted, ...(lines ? { lines } : {}) };
    });
    if (ev.type === "tool.confirm") { if (!replay) addConfirm(ev); }
    else if (ev.type === "tool.result") { const id = (ev.data as { id?: unknown } | null)?.id; if (typeof id === "string") dropConfirm(id); }
    else if (ev.type === "tool.catalog") setCatalog(ev);
    for (const l of [...listeners]) l(ev, replay);
  }

  function onFrame(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: unknown } & Record<string, unknown>;
    if (m.type === "services" && Array.isArray(m.services)) state.set((s) => ({ ...s, services: m.services as ServiceHealth[], servicesAt: now() }));
    else if (m.type === "stack") { const { type: _t, ...snap } = m; state.set((s) => ({ ...s, stack: snap as unknown as StackSnapshot })); }
    else if (m.type === "stack-progress" && Array.isArray(m.rows) && Array.isArray(m.lines)) { const { type: _t, ...rec } = m; state.set((s) => ({ ...s, progress: rec as unknown as StackProgress })); }
    else if (typeof m.type === "string") onEvent(m as unknown as FeedEvent);
  }

  function connect(): void {
    timer = undefined;
    state.set((s) => ({ ...s, status: "connecting" }));
    let sock: WebSocket;
    try { sock = make(deps.url); }
    catch {
      // The constructor threw (bad URL, blocked by the browser): treat it as a closed attempt and try again after the delay, never in a tight loop.
      const at = now();
      state.set((s) => ({ ...s, status: "closed", stoppedAt: s.stoppedAt ?? at, nextAttemptAt: at + RECONNECT_MS }));
      if (!stopped) timer = setT(connect, RECONNECT_MS);
      return;
    }
    socket = sock;
    sock.onopen = () => state.set((s) => { const { stoppedAt: _a, nextAttemptAt: _b, ...rest } = s; return { ...rest, status: "open" }; });
    sock.onmessage = (e) => { if (typeof e.data === "string") onFrame(e.data); };
    sock.onclose = () => {
      if (socket !== sock || stopped) return;
      const at = now();
      state.set((s) => ({ ...s, status: "closed", stoppedAt: s.stoppedAt ?? at, nextAttemptAt: at + RECONNECT_MS }));
      timer = setT(connect, RECONNECT_MS);
    };
  }

  return {
    state,
    start() { stopped = false; if (!socket) connect(); },
    stop() {
      stopped = true;
      for (const t of expiry.values()) clearT(t);
      expiry.clear(); stopTick();
      if (catalogTimer !== undefined) { clearT(catalogTimer); catalogTimer = undefined; }
      if (timer !== undefined) clearT(timer); const s = socket; socket = undefined; s?.close();
    },
    onEvent(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
