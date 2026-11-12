/**
 * dashboard — a host process (`pnpm dashboard`), http://localhost:3000
 *
 * - Live feed of everything on the bus, brain status, avatar preview
 * - Stack panel: Launch / Stop / Restart-all for the Compose stack (control mode), and per-service control
 * - Audio sink: plays the co-host's voice. Add http://<ai-pc>:3001/?sink=1 as an OBS Browser Source
 *   (with "control audio via OBS") and the voice lands on stream with no virtual cables.
 * - Mute / unmute / make it say something / wipe context
 * - Edit personality.md live (brain reloads it on save)
 *
 * Two listeners: the full surface on DASHBOARD_HOST (default 127.0.0.1) and a LAN listener on all interfaces
 * that serves only the sink page, its audio and the upload fetch.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { Bus } from "@cohost/bus";
import { onShutdown, startHeartbeat } from "@cohost/shared";
import { HealthTracker, LifecycleLock, withContainerRestarts, type ServiceHealth } from "@cohost/control";
import { createLogger, loadConfig, loadPersonality, savePersonality, urls } from "@cohost/config";
import { createDashboardHandler } from "./routes.js";
import { UploadStore, uploadOptionsFromEnv } from "./uploads.js";
import { createFeed, serveClient, startFeed } from "./feed.js";
import { dashboardHealth } from "./health.js";
import { setupControl } from "./control.js";
import { ViewersClient, viewersTokenFromEnv } from "./viewers.js";
import { ObservedStackController, StackService } from "./stack.js";
import { resolvePorts, startListeners } from "./host.js";

const log = createLogger("dashboard");
const cfg = loadConfig();
const bus = new Bus("dashboard", log);
// @spec DASH-HEALTH-001
const heartbeat = startHeartbeat(bus, { ...dashboardHealth, log });
const tracker = new HealthTracker();
// @spec DASH-HTTP-009
const { port: PORT, lanPort: LAN_PORT } = resolvePorts(process.env, cfg.dashboard.port);
// @spec DASH-SINK-004
const VOICE = urls.voice();
const here = dirname(fileURLToPath(import.meta.url));
// @spec DASH-CTRL-003, DASH-HOST-007
const { control, bind } = setupControl(process.env, bus, log);
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

const uploads = new UploadStore(uploadOptionsFromEnv(process.env));
// @spec DASH-UPL-002
const sweeper = setInterval(() => uploads.sweep(), 60_000);
sweeper.unref();

// @spec CFG-ENV-009, DASH-VIEWERS-007
const viewersToken = viewersTokenFromEnv(process.env);
if (!viewersToken) log.warn("VIEWERS_TOKEN is not set: the Viewers page is locked (every /viewers route answers 403)");
const viewers = new ViewersClient(bus);

// @spec DASH-STACK-007
const stack = new StackService({ log, bus: () => feed.busState(), lock: new LifecycleLock({ by: "dashboard" }) });
stack.attach(new ObservedStackController({ onPhase: (kind, phase) => stack.hooks.onPhase(kind, phase) }, stack.hooks));

// The tracker's snapshot with Compose restart counts overlaid, so a service that dies before its first heartbeat shows crash-looping.
const decorate = (snap: ServiceHealth[]): ServiceHealth[] => { const s = stack.snapshot(); return withContainerRestarts(snap, { docker: s.docker, services: s.services.map((c) => ({ ...c })) }); };
const handler = createDashboardHandler({ bus, log, html, uploads, viewers, viewersToken, cohostName: cfg.cohost.name, voiceUrl: VOICE, loadPersonality, savePersonality, services: () => decorate(tracker.snapshot()), control, stack });

const wss = new WebSocketServer({ noServer: true });
const feed = createFeed({ bus, tracker, decorate, clients: () => wss.clients, stack, log, onBusChange: () => stack.refresh(), onViewersReply: (ev) => viewers.onReply(ev) });
wss.on("connection", (ws) => void serveClient(feed, ws, log)); // @spec DASH-HTTP-012
void startFeed(feed, log); // @spec DASH-HTTP-012

// @spec DASH-HOST-001, DASH-HOST-003, DASH-HTTP-009
const listeners = await startListeners({ handler, wss, bind, port: PORT, lanPort: LAN_PORT, controlEnabled: !!control, log });
if (listeners) {
  heartbeat.ready(); // only once both listeners are listening
  if (control) log.info("stack controls are enabled: the token is CONTROL_TOKEN in .env (paste it into the page when it asks)");
  stack.start();
}
// @spec DASH-HTTP-010
onShutdown(() => { clearInterval(sweeper); feed.stop(); stack.stop(); void listeners?.close(); bus.stop(); });
