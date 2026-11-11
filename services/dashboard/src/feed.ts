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
  clients: () => Iterable<FeedSocket>;
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
}

/** The slice of the service logger the feed's failure handling uses. */
export interface FeedLog {
  error(obj: unknown, msg: string): void;
}

// @spec DASH-FEED-007
/** Events that carry viewer-note text (health and family notes included): never sent to a `/ws` browser, live or replayed. */
const WITHHELD: ReadonlySet<string> = new Set(["memory.notes.request", "memory.notes.reply", "memory.viewers.request", "memory.viewers.reply"]);
const forwardable = (ev: BusEvent): boolean => ev.type !== "service.heartbeat" && !WITHHELD.has(ev.type);

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
  const deliver = (c: FeedSocket, ev: BusEvent) => {
    const held = replaying.get(c);
    if (held) held.push(ev); else if (c.readyState === OPEN) c.send(JSON.stringify(ev));
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
  const offStack = d.stack.onChange((snap) => broadcast(stackMessage(snap))); // @spec DASH-FEED-008

  return {
    // @spec DASH-FEED-001, DASH-FEED-007, DASH-FEED-008
    /** Wire up a new client: current services, then the stack state, then the recent event replay. */
    // Replayed events carry `replay: true`; a live event that lands meanwhile is held and sent after the replay (once).
    async onConnection(ws: FeedSocket): Promise<void> {
      const held: BusEvent[] = [];
      replaying.set(ws, held); // before the first await: the socket is already in the client set
      try {
        ws.send(servicesMessage(d.tracker.snapshot()));
        ws.send(stackMessage(d.stack.snapshot())); // before the replay read: a client that cannot get a replay still has both snapshots
        const sent = new Set<string>();
        let failure: { err: unknown } | undefined;
        try {
          for (const ev of await d.bus.recent(d.replay ?? 60)) {
            if (!forwardable(ev)) continue;
            sent.add(ev.id);
            ws.send(JSON.stringify({ ...ev, replay: true }));
          }
        } catch (err) { failure = { err }; }
        replaying.delete(ws);
        for (const ev of held) if (!sent.has(ev.id) && ws.readyState === OPEN) ws.send(JSON.stringify(ev)); // live events that landed meanwhile still reach this client
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
      const fromId = history.at(-1)?.id ?? "$";
      void d.bus.tailHealth((hb) => d.tracker.ingest(hb.data), fromId, readOutcome);
      void d.bus.tail((ev: BusEvent) => {
        if (ev.type === "memory.viewers.reply") d.onViewersReply?.(ev as BusEvent<"memory.viewers.reply">); // @spec DASH-VIEWERS-008
        if (forwardable(ev)) for (const c of d.clients()) deliver(c, ev);
      }, "$", readOutcome);
      offChange = d.tracker.onChange((snap) => broadcast(servicesMessage(snap)));
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
