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
  let timer: NodeJS.Timeout | undefined;
  let offChange: (() => void) | undefined;

  return {
    /** Wire up a new client: current services first, then the recent event replay. */
    async onConnection(ws: FeedSocket): Promise<void> {
      ws.send(servicesMessage(d.tracker.snapshot()));
      for (const ev of await d.bus.recent(d.replay ?? 60)) {
        if (ev.type !== "service.heartbeat") ws.send(JSON.stringify(ev));
      }
    },

    /** Seed the tracker from recent heartbeats, then follow the live feeds. */
    async start(): Promise<void> {
      const history = await d.bus.recentHealth(500);
      d.tracker.seed(history.map((h) => ({ ts: h.ts, data: h.data })));
      const fromId = history.at(-1)?.id ?? "$";
      void d.bus.tailHealth((hb) => d.tracker.ingest(hb.data), fromId);
      void d.bus.tail((ev: BusEvent) => {
        if (ev.type !== "service.heartbeat") broadcast(JSON.stringify(ev));
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
