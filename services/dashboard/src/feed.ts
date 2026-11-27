import type { Bus, BusEvent } from "@cohost/bus";
import type { HealthTracker, ServiceHealth } from "@cohost/control";
import { retryWithBackoff } from "@cohost/shared";

/** The slice of a ws WebSocket the feed uses. */
export interface FeedSocket {
  readyState: number;
  send(data: string): void;
}
const OPEN = 1;

export type BusReach = "connected" | "unreachable";

export interface FeedDeps {
  bus: Pick<Bus, "recent" | "tail" | "recentHealth" | "tailHealth">;
  tracker: HealthTracker;
  /** Applied to every services snapshot before it is sent (the Compose restart counts overlay, DASH-FEED-010). */
  decorate?: (snapshot: ServiceHealth[]) => ServiceHealth[];
  clients: () => Iterable<FeedSocket>;
  /** True for a socket that arrived beyond loopback (LAN listener, or a non-loopback full surface): its tool events are sent redacted (DASH-FEED-011). Default: none. */
  redacts?: (ws: FeedSocket) => boolean;
  /** The stack state the feed carries to clients: the `GET /stack` body, and a hook for each change of it. */
  stack: { snapshot(): object; onChange(cb: (snapshot: object) => void): () => void };
  /** Where the seed retry's warnings go. */
  log?: { warn(obj: unknown, msg: string): void };
  /** Called when the bus reachability flips (the stack state includes it). */
  onBusChange?: (state: BusReach) => void;
  /** How often staleness is re-evaluated and pushed; default 1000 ms. */
  tickMs?: number;
  replay?: number;
  /** Pause between seed retries (default: a timer that `stop()` cuts short). */
  sleep?: (ms: number) => Promise<void>;
  /** Receives each `memory.viewers.reply` seen on the stream (the Viewers routes wait on these); the feed itself never forwards it. */
  onViewersReply?: (ev: BusEvent<"memory.viewers.reply">) => void;
  /** Receives the driver of each `avatar.state` seen on the stream: the renderer relay's state comes from it (DASH-AVR-020). */
  onAvatarState?: (driver: string) => void;
  /** Every heartbeat, seeded and live: the credentials re-delivery follows them (settings-store STORE-DLV-005). */
  onHeartbeat?: (hb: { service: string; state: string; detail?: string; intervalMs?: number }) => void;
}

/** The slice of the service logger the feed's failure handling uses. */
export interface FeedLog {
  error(obj: unknown, msg: string): void;
}

// @spec DASH-FEED-007
/** Events that carry viewer-note text (health and family notes included): never sent to a `/ws` browser, live or replayed. */
const WITHHELD: ReadonlySet<string> = new Set(["memory.notes.request", "memory.notes.reply", "memory.viewers.request", "memory.viewers.reply"]);
const forwardable = (ev: BusEvent): boolean => ev.type !== "service.heartbeat" && !WITHHELD.has(ev.type);

/**
 * The form of an event a redacted socket is sent (DASH-FEED-011): `tool.request` and `tool.confirm` with `arguments: {}`,
 * `tool.result` with empty `content` and no `truncated`, an `inject.request` for the tools unit with empty `text`, a
 * `tool.timer` with empty `note`, a `memory.recall.request` with empty `query`, and a `memory.recall.reply` with the empty
 * `text` of each memory. Every other member and event type is unchanged. An event that emptied something held gets
 * `redacted: true` in its `data`, so the owner's page can say why a call shows no arguments. Returns a copy; the shared
 * event is never mutated, so a loopback socket on the same feed still gets it whole.
 */
// @spec DASH-FEED-011
export function redactEvent<E extends BusEvent>(ev: E): E {
  const data = ev.data as unknown as Record<string, unknown>;
  const marked = (held: boolean) => (held ? { redacted: true } : {});
  if (ev.type === "tool.request" || ev.type === "tool.confirm") {
    // Fails closed: anything but an empty plain object as `arguments` counts as held.
    return { ...ev, data: { ...data, arguments: {}, ...marked(!isEmptyPlainObject(data.arguments)) } };
  }
  if (ev.type === "tool.result") {
    const { truncated: _truncated, ...rest } = data;
    return { ...ev, data: { ...rest, content: "", ...marked(data.content !== "") } };
  }
  if (ev.type === "inject.request" && data.target === "tools") return { ...ev, data: { ...data, text: "" } };
  if (ev.type === "tool.timer") return { ...ev, data: { ...data, note: "" } };
  if (ev.type === "memory.recall.request") return { ...ev, data: { ...data, query: "", ...marked(data.query !== "") } };
  if (ev.type === "memory.recall.reply") {
    const list = Array.isArray(data.memories) ? data.memories : undefined;
    const held = list === undefined ? data.memories !== undefined : list.some((m) => !(isPlainObject(m) && m.text === ""));
    const emptied = (list ?? []).map((m) => (isPlainObject(m) ? { ...m, text: "" } : { text: "" }));
    return { ...ev, data: { ...data, memories: emptied, ...marked(held) } };
  }
  return ev;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A plain `{}`: the only `arguments` value with nothing in it to hide. */
const isEmptyPlainObject = (v: unknown): boolean => isPlainObject(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).length === 0;

export const servicesMessage = (services: ServiceHealth[]): string => JSON.stringify({ type: "services", services });
export const stackMessage = (snapshot: object): string => JSON.stringify({ type: "stack", ...snapshot });

/** The bus's own retry delays (250 ms doubling, capped at 30 s), for the seed. */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;

/**
 * The dashboard's live WebSocket feed: bus events (never heartbeats), `services` snapshots from the HealthTracker,
 * `stack` snapshots from the stack service, and the bus's reachability.
 */
export function createFeed(d: FeedDeps) {
  const broadcast = (msg: string) => {
    for (const c of d.clients()) if (c.readyState === OPEN) c.send(msg);
  };
  // Sockets whose connect replay is being read: live events for them wait here until the replay is out.
  const replaying = new Map<FeedSocket, BusEvent[]>();
  const form = (c: FeedSocket, ev: BusEvent): BusEvent => (d.redacts?.(c) ? redactEvent(ev) : ev);
  const deliver = (c: FeedSocket, ev: BusEvent) => {
    const held = replaying.get(c);
    if (held) held.push(ev); else if (c.readyState === OPEN) c.send(JSON.stringify(form(c, ev)));
  };
  let timer: NodeJS.Timeout | undefined;
  let offChange: (() => void) | undefined;
  let stopped = false;
  let wake: (() => void) | undefined;
  let bus: BusReach = "connected";
  const setBus = (next: BusReach) => {
    if (next === bus) return;
    bus = next;
    d.onBusChange?.(next);
  };
  const readOutcome = (err?: unknown) => setBus(err === undefined ? "connected" : "unreachable"); // @spec DASH-FEED-009
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); wake = undefined; resolve(); }
    wake = done;
  }));
  // Subscribed at creation, not at start(): a page opened while Redis is down still hears every stack change.
  const snapshot = (): ServiceHealth[] => (d.decorate ?? ((s) => s))(d.tracker.snapshot());
  // @spec DASH-FEED-008, DASH-FEED-010
  const offStack = d.stack.onChange((snap) => { broadcast(stackMessage(snap)); if (d.decorate) broadcast(servicesMessage(snapshot())); });

  return {
    // @spec DASH-FEED-001, DASH-FEED-007, DASH-FEED-008, DASH-FEED-011, DASH-FEED-012
    /** Wire up a new client: current services, then the stack state, then the recent event replay. */
    // Replayed events carry `replay: true`; a live event that lands meanwhile is held and sent after the replay (once).
    async onConnection(ws: FeedSocket): Promise<void> {
      const held: BusEvent[] = [];
      replaying.set(ws, held); // before the first await: the socket is already in the client set
      try {
        ws.send(servicesMessage(snapshot()));
        ws.send(stackMessage(d.stack.snapshot())); // before the replay read: a client that cannot get a replay still has both snapshots
        const sent = new Set<string>();
        let failure: { err: unknown } | undefined;
        try {
          for (const ev of await d.bus.recent(d.replay ?? 60)) {
            if (!forwardable(ev)) continue;
            sent.add(ev.id);
            ws.send(JSON.stringify({ ...form(ws, ev), replay: true }));
          }
        } catch (err) { failure = { err }; }
        replaying.delete(ws);
        for (const ev of held) if (!sent.has(ev.id) && ws.readyState === OPEN) ws.send(JSON.stringify(form(ws, ev))); // live events that landed meanwhile still reach this client
        if (failure) throw failure.err;
      } finally {
        replaying.delete(ws);
      }
    },

    // @spec DASH-FEED-002, DASH-FEED-003, DASH-FEED-004, DASH-FEED-005, DASH-FEED-007, DASH-FEED-009, DASH-HTTP-012
    /**
     * Seed the tracker from recent heartbeats (retrying with the bus's backoff while Redis is unreachable), then
     * follow the live feeds. Resolves once the tails are running, or when `stop()` ends the retry.
     */
    async start(): Promise<void> {
      const history = await retryWithBackoff(async () => {
        const h = await d.bus.recentHealth(500);
        setBus("connected");
        return h;
      }, {
        baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, sleep, isStopped: () => stopped,
        onFailure: (err, failures, delayMs) => {
          setBus("unreachable");
          d.log?.warn({ err, delayMs, failures }, "feed seed failed: Redis is unreachable; retrying");
        },
      });
      if (stopped || !history) return;
      d.tracker.seed(history.map((h) => ({ ts: h.ts, data: h.data })));
      for (const h of history) d.onHeartbeat?.(h.data);
      const fromId = history.at(-1)?.id ?? "$";
      void d.bus.tailHealth((hb) => { d.tracker.ingest(hb.data); d.onHeartbeat?.(hb.data); }, fromId, readOutcome);
      void d.bus.tail((ev: BusEvent) => {
        if (ev.type === "memory.viewers.reply") d.onViewersReply?.(ev as BusEvent<"memory.viewers.reply">); // @spec DASH-VIEWERS-008
        if (ev.type === "avatar.state") d.onAvatarState?.((ev as BusEvent<"avatar.state">).data.driver); // @spec DASH-AVR-020
        if (forwardable(ev)) for (const c of d.clients()) deliver(c, ev);
      }, "$", readOutcome);
      offChange = d.tracker.onChange(() => broadcast(servicesMessage(snapshot())));
      timer = setInterval(() => d.tracker.tick(), d.tickMs ?? 1000);
      timer.unref();
    },

    /** The bus's reachability as the stack message reports it (DASH-FEED-009). */
    busState(): BusReach { return bus; },

    stop(): void {
      stopped = true;
      wake?.();
      if (timer) clearInterval(timer);
      offChange?.();
      offStack();
    },
  };
}

// @spec DASH-HTTP-012
/** Starts the feed. A seed that cannot complete is the feed's own retry, so only an unexpected failure lands here: log it. */
export function startFeed(feed: { start(): Promise<void> }, log: FeedLog): Promise<void> {
  return feed.start().catch((err) => { log.error({ err }, "feed failed to start"); });
}

// @spec DASH-HTTP-012
/** Replays history to a new client; if that fails, log it and leave the socket open without the replay. */
export function serveClient(feed: { onConnection(ws: FeedSocket): Promise<void> }, ws: FeedSocket, log: FeedLog): Promise<void> {
  return feed.onConnection(ws).catch((err) => {
    log.error({ err }, "connect replay failed");
  });
}
