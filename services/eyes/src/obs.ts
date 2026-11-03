import type { Heartbeat } from "@cohost/bus";
import type { Logger } from "@cohost/config";

/** The slice of obs-websocket-js's `OBSWebSocket` the link uses. */
export interface ObsLike {
  readonly identified: boolean;
  connect(url: string, password?: string): Promise<{ obsWebSocketVersion: string }>;
  disconnect(): Promise<void>;
  on(event: "ConnectionClosed", listener: () => void): unknown;
}

export interface ObsLinkDeps {
  obs: ObsLike;
  url: string;
  password?: string;
  log: Logger;
  heartbeat: Pick<Heartbeat, "ready" | "degraded">;
  sleep?: (ms: number) => Promise<void>;
  /** Delay between failed connection attempts, ms (default 10000). */
  retryMs?: number;
}

export interface ObsLink {
  /** Connect with retry; concurrent calls share one loop. Resolves once identified (or once stopped). */
  connect(): Promise<void>;
  /** Stop reconnecting and close the socket. */
  stop(): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The connection to OBS: connect with a fixed retry, report `degraded` (obs down) while it is
 * unreachable and `ready` once identified, and reconnect on any later close.
 */
// @spec EYES-OBS-001, EYES-OBS-002, EYES-OBS-003, EYES-OBS-004, EYES-HEALTH-005, EYES-HEALTH-006
export function createObsLink({ obs, url, password, log, heartbeat, sleep = wait, retryMs = 10_000 }: ObsLinkDeps): ObsLink {
  let stopped = false;
  let inflight: Promise<void> | undefined;
  let running = false; // set synchronously: a failed attempt may emit its close before `inflight` is assigned

  async function run(): Promise<void> {
    running = true;
    try { await attempts(); } finally { running = false; }
  }
  async function attempts(): Promise<void> {
    while (!stopped) {
      try {
        const { obsWebSocketVersion } = await obs.connect(url, password || undefined);
        log.info({ url, obsWebSocketVersion }, "connected to OBS");
        heartbeat.ready();
        return;
      } catch (err) {
        if (stopped) return;
        log.warn({ err: String(err) }, "OBS not reachable, retrying in 10s");
        heartbeat.degraded("OBS not reachable");
        await sleep(retryMs);
      }
    }
  }
  const connect = (): Promise<void> => (inflight ??= run().finally(() => { inflight = undefined; }));

  // A failed connect attempt emits this too; the running loop already owns that case.
  obs.on("ConnectionClosed", () => {
    if (stopped || running) return;
    log.warn("OBS connection closed, reconnecting");
    void connect();
  });

  return {
    connect,
    async stop() {
      stopped = true;
      await obs.disconnect();
    },
  };
}

export interface StopEyesDeps {
  idleTimer?: ReturnType<typeof setInterval>;
  clear?: (t: ReturnType<typeof setInterval>) => void;
  link: Pick<ObsLink, "stop">;
  bus: { stop(): void };
}

/** The one shutdown sequence, in both plans: idle timer, OBS, then the bus (the `stopping` heartbeat runs before it). */
// @spec EYES-ENAB-005, EYES-OBS-008
export async function stopEyes({ idleTimer, clear = clearInterval, link, bus }: StopEyesDeps): Promise<void> {
  if (idleTimer) clear(idleTimer);
  await link.stop();
  bus.stop();
}
