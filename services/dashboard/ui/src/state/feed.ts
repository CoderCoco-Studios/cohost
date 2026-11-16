import { createStore, type Store } from "./store";
import type { FeedEvent, ServiceHealth, StackSnapshot } from "./types";

/** The event types that get a row in the Activity feed (DASH-UI-002); every other type is dropped from the log. */
export const FEED_TYPES: ReadonlySet<string> = new Set([
  "chat.message", "brain.say", "vision.summary", "speech.heard", "brain.status", "control", "service.lifecycle",
  "inject.request", "inject.result", "voice.utterance", "voice.playing", "voice.done",
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
  /** Rendered event types, oldest first, at most `LOG_LIMIT`, replayed events included and flagged. */
  events: FeedEvent[];
  /** The latest event of each type (`brain.status`, `avatar.state`, ...), whether or not it is a rendered type. */
  latest: Record<string, FeedEvent>;
  /** The latest `mute` or `unmute` control event seen, live or replayed; unmuted until one is seen (DASH-UI-005). */
  muted: boolean;
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

const initial = (): FeedState => ({ status: "connecting", services: null, servicesAt: 0, stack: null, events: [], latest: {}, muted: false });

/**
 * The `/ws` connection as a store (DASH-UI-001). Parses each frame defensively, routes the `services` and `stack`
 * snapshots into state, de-duplicates bus events by id, keeps the rendered rows, and reconnects every 2 s while the
 * socket is closed, recording when it stopped and when it will try again for the connection banner.
 */
// @spec DASH-UI-001, DASH-UI-002, DASH-UI-005, DASH-UI-013
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

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
    return true;
  };

  function onEvent(ev: FeedEvent): void {
    if (typeof ev.id !== "string" || !remember(ev.id)) return;
    const replay = ev.replay === true;
    state.set((s) => {
      const events = FEED_TYPES.has(ev.type) ? [...s.events, ev].slice(-LOG_LIMIT) : s.events;
      const cmd = ev.type === "control" ? (ev.data as { cmd?: string }).cmd : undefined;
      return { ...s, events, latest: { ...s.latest, [ev.type]: ev }, muted: cmd === "mute" ? true : cmd === "unmute" ? false : s.muted };
    });
    for (const l of [...listeners]) l(ev, replay);
  }

  function onFrame(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type?: unknown } & Record<string, unknown>;
    if (m.type === "services" && Array.isArray(m.services)) state.set((s) => ({ ...s, services: m.services as ServiceHealth[], servicesAt: now() }));
    else if (m.type === "stack") { const { type: _t, ...snap } = m; state.set((s) => ({ ...s, stack: snap as unknown as StackSnapshot })); }
    else if (typeof m.type === "string") onEvent(m as unknown as FeedEvent);
  }

  function connect(): void {
    timer = undefined;
    state.set((s) => ({ ...s, status: "connecting" }));
    const sock = make(deps.url);
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
    stop() { stopped = true; if (timer !== undefined) clearT(timer); const s = socket; socket = undefined; s?.close(); },
    onEvent(l) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
