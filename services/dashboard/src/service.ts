import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import type { Bus } from "@cohost/bus";
import type { HeartbeatSpec, ServiceContext } from "@cohost/shared";
import { HealthTracker, LifecycleLock, withContainerRestarts, type ServiceHealth } from "@cohost/control";
import { loadPersonality, savePersonality, urls } from "@cohost/config";
import { createDashboardHandler } from "./routes.js";
import { uploadOptionsFromEnv } from "./uploads.js";
import { createFeed, serveClient, startFeed } from "./feed.js";
import { dashboardHealth } from "./health.js";
import { setupControl } from "./control.js";
import { ViewersClient, viewersTokenFromEnv } from "./viewers.js";
import { ObservedStackController, StackService } from "./stack.js";
import { resolvePorts, startListeners } from "./host.js";

/** What the dashboard's `main` takes from outside, so a test can run it without a process env, signals or an exit. */
export interface DashboardDeps {
  env?: NodeJS.ProcessEnv;
  /** Called when a listener cannot bind; default exits the process. */
  exit?: (code: number) => void;
  /** The LAN listener's address; default all interfaces. */
  lanHost?: string;
  /** Gives the stack service its controller; default the Compose-backed one. */
  attachStack?: (stack: StackService) => void;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The dashboard as a service for `runService`: its heartbeat spec and `main`. `main` wires the feed, the stack service,
 * the routes and the two listeners, declares readiness once both listen, and registers one teardown step.
 */
// @spec DASH-HTTP-016
export function dashboardService(deps: DashboardDeps = {}) {
  const env = deps.env ?? process.env;
  return {
    health: (): HeartbeatSpec => dashboardHealth,
    async main({ cfg, bus, log, heartbeat, onStop }: ServiceContext<Bus>): Promise<void> {
      const tracker = new HealthTracker();
      // @spec DASH-HTTP-009
      const { port: PORT, lanPort: LAN_PORT } = resolvePorts(env, cfg.dashboard.port);
      // @spec DASH-SINK-004
      const VOICE = urls.voice();
      // @spec DASH-CTRL-003, DASH-HOST-007
      const { control, bind } = setupControl(env, bus, log);
      const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

      const uploads = uploadOptionsFromEnv(env);

      // @spec CFG-ENV-009, DASH-VIEWERS-007
      const viewersToken = viewersTokenFromEnv(env);
      if (!viewersToken) log.warn("VIEWERS_TOKEN is not set: the Viewers page is locked (every /viewers route answers 403)");
      const viewers = new ViewersClient(bus);

      // @spec DASH-STACK-007
      const stack = new StackService({ log, bus: () => feed.busState(), lock: new LifecycleLock({ by: "dashboard" }) });
      const attach = deps.attachStack ?? ((s: StackService) => s.attach(new ObservedStackController({ onPhase: (kind, phase) => s.hooks.onPhase(kind, phase) }, s.hooks)));
      attach(stack);

      // The tracker's snapshot with Compose restart counts overlaid, so a service that dies before its first heartbeat shows crash-looping.
      const decorate = (snap: ServiceHealth[]): ServiceHealth[] => { const s = stack.snapshot(); return withContainerRestarts(snap, { docker: s.docker, services: s.services.map((c) => ({ ...c })) }); };
      const handler = createDashboardHandler({ bus, log, html, uploads, viewers, viewersToken, cohostName: cfg.cohost.name, voiceUrl: VOICE, loadPersonality, savePersonality, services: () => decorate(tracker.snapshot()), control, stack });

      const wss = new WebSocketServer({ noServer: true });
      const feed = createFeed({ bus, tracker, decorate, clients: () => wss.clients, stack, log, onBusChange: () => stack.refresh(), onViewersReply: (ev) => viewers.onReply(ev) });
      wss.on("connection", (ws) => void serveClient(feed, ws, log)); // @spec DASH-HTTP-012
      void startFeed(feed, log); // @spec DASH-HTTP-012

      // @spec DASH-HOST-001, DASH-HOST-003, DASH-HTTP-009
      const listeners = await startListeners({ handler, wss, bind, port: PORT, lanPort: LAN_PORT, lanHost: deps.lanHost, controlEnabled: !!control, log, exit: deps.exit });
      // @spec DASH-HTTP-010
      onStop(() => { feed.stop(); stack.stop(); return listeners?.close(); });
      if (listeners) {
        heartbeat.ready(); // only once both listeners are listening
        if (control) log.info("stack controls are enabled: the token is CONTROL_TOKEN in .env (paste it into the page when it asks)");
        stack.start();
      }
    },
  };
}
