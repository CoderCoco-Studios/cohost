import { WebSocketServer } from "ws";
import type { HeartbeatSpec, ServiceContext } from "@cohost/shared";
import { HealthTracker, LifecycleLock, storeRedeliver, withContainerRestarts, type ServiceHealth } from "@cohost/control";
import { urls } from "@cohost/config";
import type { Store } from "@cohost/store";
import { createDashboardHandler } from "./routes.js";
import { AppliedView } from "./applied.js";
import { ModelStore, modelsDir } from "./models.js";
import { uploadLimits } from "./uploads.js";
import { createFeed, serveClient, startFeed } from "./feed.js";
import { dashboardHealth } from "./health.js";
import { setupControl } from "./control.js";
import { ViewersClient } from "./viewers.js";
import { ObservedStackController, StackService } from "./stack.js";
import { resolvePorts, startListeners, type FeedConnection } from "./host.js";
import { createAvatarRelay, systemClock, type Clock } from "./avatar-relay.js";
import { unlockBase, unlockLine, UnlockLinks, type Gate } from "./access.js";
import { printToTerminal } from "./recovery.js";
import { Redeliverer, type Redeliver } from "./deliver.js";

/** The one lock over the settings store: its verifier for a bearer, its session key for a cookie (DASH-CTRL-011). */
export const storeGate = (store: Pick<Store, "checkBearer" | "sessionKey">): Gate => ({ verify: (t) => store.checkBearer(t), sessionKey: () => store.sessionKey() });

/** What the dashboard's `main` takes from outside, so a test can run it without a process env, signals or an exit. */
export interface DashboardDeps {
  /** The settings store, opened by the dashboard's start (DASH-HTTP-016). */
  store: Store;
  /** The workspace root projections are written under; the one found from the working directory by default. */
  root?: string;
  /** The credentials re-delivery (STORE-DLV-005); the control plane's over the store and the docker CLI by default. */
  redeliver?: Redeliver;
  env?: NodeJS.ProcessEnv;
  /** Called when a listener cannot bind; default exits the process. */
  exit?: (code: number) => void;
  /** Writes the unlock line to the terminal (DASH-UNL-001); standard output by default, never the logger. */
  print?: (line: string) => void;
  /** The LAN listener's address; default all interfaces. */
  lanHost?: string;
  /** Gives the stack service its controller; default the Compose-backed one. */
  attachStack?: (stack: StackService) => void;
  /** Writes one chunk of an upload to its temporary file; default the file system. Tests inject a failing one (DASH-MDL-029). */
  writeModelChunk?: ModelStore["writeChunk"];
  /** Awaited at the start of each model listing; tests inject a delay to widen a race (DASH-AVR-028). */
  modelPause?: () => Promise<void>;
  /** The renderer relay's one time source (timers, the state tick and receive stamps); default the system clock. */
  clock?: Clock;
  /** The directory `avatar.html` is read from; default the built UI (`dist-ui`). Tests pin it. */
  uiDir?: string;
}

/**
 * The dashboard as a service for `runService`: its heartbeat spec and `main`. `main` wires the feed, the stack service,
 * the routes and the two listeners, declares readiness once both listen, and registers one teardown step.
 */
// @spec DASH-HTTP-016
export function dashboardService(deps: DashboardDeps) {
  const env = deps.env ?? process.env;
  return {
    health: (): HeartbeatSpec => dashboardHealth,
    main: async ({ cfg, bus, log, heartbeat, onStop }: ServiceContext): Promise<void> => {
      const tracker = new HealthTracker();
      // @spec DASH-HTTP-009, DASH-HOST-001
      const { port: PORT, lanPort: LAN_PORT } = resolvePorts(cfg.dashboard);
      // @spec DASH-SINK-004
      const VOICE = urls.voice();
      // @spec DASH-CTRL-002, DASH-CTRL-003
      const gate = storeGate(deps.store);
      const { control, bind } = setupControl(env, bus, log, gate);
      const links = new UnlockLinks();

      // @spec DASH-UPL-001, DASH-UPL-002
      const uploads = uploadLimits(cfg.dashboard.inject);

      const viewers = new ViewersClient(bus);

      // @spec DASH-STACK-007
      const stack = new StackService({ log, bus: () => feed.busState(), lock: new LifecycleLock({ by: "dashboard" }) });
      const attach = deps.attachStack ?? ((s: StackService) => s.attach(new ObservedStackController({ onPhase: (kind, phase) => s.hooks.onPhase(kind, phase), warn: (msg) => log.warn(msg) }, s.hooks)));
      attach(stack);

      // The tracker's snapshot with Compose restart counts overlaid, so a service that dies before its first heartbeat shows crash-looping.
      const decorate = (snap: ServiceHealth[]): ServiceHealth[] => { const s = stack.snapshot(); return withContainerRestarts(snap, { docker: s.docker, services: s.services.map((c) => ({ ...c })) }); };
      // @spec DASH-MDL-031, DASH-AVR-023
      const store = new ModelStore(modelsDir(), deps.writeModelChunk, deps.modelPause);
      await store.sweep();
      const applied = new AppliedView(log);
      const r = cfg.renderer;
      applied.start({ model: r.model, zoom: r.zoom, offset_y: r.offset_y, turn: r.turn }, await store.loadable());
      const models = { store, applied, maxBytes: cfg.dashboard.models.max_bytes };
      // @spec DASH-AVR-001, DASH-AVR-011, DASH-AVR-021
      const relay = createAvatarRelay({ bus, applied, clock: deps.clock ?? systemClock, log });
      const handler = createDashboardHandler({ bus, log, uploads, viewers, cohostName: cfg.cohost.name, voiceUrl: VOICE, unlock: links, store: deps.store, ...(deps.root ? { root: deps.root } : {}), services: () => decorate(tracker.snapshot()), control, stack, models, renderer: () => relay.renderer(), ...(deps.uiDir ? { uiDir: deps.uiDir } : {}) });

      const wss = new WebSocketServer({ noServer: true });
      const redacted = new WeakSet(); // sockets that arrived beyond loopback (DASH-FEED-011)
      // @spec STORE-DLV-005
      const redeliverer = new Redeliverer({ redeliver: deps.redeliver ?? storeRedeliver(env), acquire: (kind) => stack.tryAcquire(kind), log });
      const feed = createFeed({
        bus, tracker, decorate, clients: () => wss.clients, redacts: (ws) => redacted.has(ws), stack, log, onBusChange: () => stack.refresh(),
        onViewersReply: (ev) => viewers.onReply(ev), onAvatarState: (driver) => relay.observeState(driver), onHeartbeat: (hb) => redeliverer.observe(hb),
      });
      wss.on("connection", (ws, _req, conn?: FeedConnection) => { if (conn?.redact) redacted.add(ws); void serveClient(feed, ws, log); }); // @spec DASH-HTTP-012
      // The first delivery waits for the heartbeats, so a unit already ready is skipped (STORE-DLV-005); afterwards every change
      // of the stack probe (a container restarted by Docker) asks for one.
      const offStack = stack.onChange(() => { void redeliverer.run(); });
      void startFeed(feed, log).then(() => redeliverer.start()); // @spec DASH-HTTP-012

      // @spec DASH-HOST-001, DASH-HOST-003, DASH-HOST-009, DASH-HTTP-009
      const listeners = await startListeners({ handler, wss, avatar: relay, bind, port: PORT, lanPort: LAN_PORT, lanHost: deps.lanHost, allowedHosts: cfg.dashboard.allowed_hosts, log, exit: deps.exit });
      // @spec DASH-HTTP-010, DASH-HTTP-016
      onStop(() => { offStack(); feed.stop(); stack.stop(); relay.stop(); return listeners?.close(); });
      if (!listeners) relay.stop(); // a listener that could not bind leaves nothing running
      if (listeners) {
        heartbeat.ready(); // only once both listeners are listening
        links.base = unlockBase(bind, listeners.fullPort);
        // @spec DASH-UNL-001
        (deps.print ?? printToTerminal)(unlockLine(unlockBase(bind, listeners.fullPort), links.issue()));
        log.info("the dashboard is locked: open the unlock link printed in this terminal, or paste the control token from your password manager when the page asks");
        stack.start();
      }
    },
  };
}
