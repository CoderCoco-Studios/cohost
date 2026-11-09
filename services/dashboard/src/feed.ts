import type { Bus, BusEvent } from "@cohost/bus";
import type { HealthTracker, ServiceHealth } from "@cohost/control";

/** The slice of a ws WebSocket the feed uses. */
export interface FeedSocket {
  readyState: number;
  send(data: string): void;
}
const OPEN = 1;

export interface FeedDeps {
  bus: Pick<Bus, "recent" | "tail" | "recentHealth" | "tailHealth">;
  tracker: HealthTracker;
  clients: () => Iterable<FeedSocket>;
  /** How often staleness is re-evaluated and pushed; default 1000 ms. */
  tickMs?: number;
  replay?: number;
  /** Receives each `memory.viewers.reply` seen on the stream (the Viewers routes wait on these); the feed itself never forwards it. */
  onViewersReply?: (ev: BusEvent<"memory.viewers.reply">) => void;
}

// @spec DASH-FEED-007
/** Events that carry viewer-note text: never sent to a `/ws` client, live or in the replay. */
export const VIEWER_NOTE_EVENTS: ReadonlySet<string> = new Set([
  "memory.notes.request", "memory.notes.reply", "memory.viewers.request", "memory.viewers.reply",
]);

/** The slice of the service logger the feed's failure handling uses. */
export interface FeedLog {
  error(obj: unknown, msg: string): void;
  fatal(obj: unknown, msg: string): void;
}

export const servicesMessage = (services: ServiceHealth[]): string => JSON.stringify({ type: "services", services });

/**
 * The dashboard's live WebSocket feed: bus events (never heartbeats) plus
 * `services` snapshots from the HealthTracker.
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

  return {
    // @spec DASH-FEED-001
    /** Wire up a new client: current services first, then the recent event replay. */
    // Replayed events carry `replay: true`; a live event that lands meanwhile is held and sent after the replay (once).
    async onConnection(ws: FeedSocket): Promise<void> {
      const held: BusEvent[] = [];
      replaying.set(ws, held); // before the first await: the socket is already in the client set
      try {
        ws.send(servicesMessage(d.tracker.snapshot()));
        const sent = new Set<string>();
        for (const ev of await d.bus.recent(d.replay ?? 60)) {
          if (ev.type === "service.heartbeat" || VIEWER_NOTE_EVENTS.has(ev.type)) continue;
          sent.add(ev.id);
          ws.send(JSON.stringify({ ...ev, replay: true }));
        }
        replaying.delete(ws);
        for (const ev of held) if (!sent.has(ev.id) && ws.readyState === OPEN) ws.send(JSON.stringify(ev));
      } finally {
        replaying.delete(ws);
      }
    },

    // @spec DASH-FEED-002, DASH-FEED-003, DASH-FEED-004, DASH-FEED-005
    /** Seed the tracker from recent heartbeats, then follow the live feeds. */
    async start(): Promise<void> {
      const history = await d.bus.recentHealth(500);
      d.tracker.seed(history.map((h) => ({ ts: h.ts, data: h.data })));
      const fromId = history.at(-1)?.id ?? "$";
      void d.bus.tailHealth((hb) => d.tracker.ingest(hb.data), fromId);
      void d.bus.tail((ev: BusEvent) => {
        if (ev.type === "memory.viewers.reply") d.onViewersReply?.(ev as BusEvent<"memory.viewers.reply">); // @spec DASH-VIEWERS-008
        if (ev.type !== "service.heartbeat" && !VIEWER_NOTE_EVENTS.has(ev.type)) for (const c of d.clients()) deliver(c, ev);
      });
      offChange = d.tracker.onChange((snap) => broadcast(servicesMessage(snap)));
      timer = setInterval(() => d.tracker.tick(), d.tickMs ?? 1000);
      timer.unref();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      offChange?.();
    },
  };
}

// @spec DASH-HTTP-012
/** Starts the feed; Redis being unreachable is fatal for the dashboard, so log it and exit non-zero (Compose restarts it). */
export function startFeed(feed: { start(): Promise<void> }, log: FeedLog, exit: (code: number) => void = (c) => process.exit(c)): Promise<void> {
  return feed.start().catch((err) => { log.fatal({ err }, "feed failed to start"); exit(1); });
}

// @spec DASH-HTTP-012
/** Replays history to a new client; if that fails, log it and close only that socket. */
export function serveClient(feed: { onConnection(ws: FeedSocket): Promise<void> }, ws: FeedSocket & { close(): void }, log: FeedLog): Promise<void> {
  return feed.onConnection(ws).catch((err) => {
    log.error({ err }, "connect replay failed");
    try { ws.close(); } catch { /* already closed */ }
  });
}
