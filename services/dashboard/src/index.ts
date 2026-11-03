/**
 * dashboard — http://localhost:3000
 *
 * - Live feed of everything on the bus, brain status, avatar preview
 * - Audio sink: plays the co-host's voice. Add http://<ai-pc>:3000/?sink=1 as an
 *   OBS Browser Source (with "control audio via OBS") and the voice lands on stream
 *   with no virtual cables.
 * - Mute / unmute / make it say something / wipe context
 * - Edit personality.md live (brain reloads it on save)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { HealthTracker } from "@cohost/control";
import { createLogger, envOr, loadConfig, loadPersonality, savePersonality, urls } from "@cohost/config";
import { createDashboardHandler } from "./routes.js";
import { UploadStore, uploadOptionsFromEnv } from "./uploads.js";
import { createFeed, serveClient, startFeed } from "./feed.js";
import { dashboardHealth } from "./health.js";
import { setupControl } from "./control.js";

const log = createLogger("dashboard");
const cfg = loadConfig();
const bus = new Bus("dashboard", log);
// @spec DASH-HEALTH-001
const heartbeat = startHeartbeat(bus, { ...dashboardHealth, log });
const tracker = new HealthTracker();
const PORT = Number(envOr("PORT", String(cfg.dashboard.port)));
// @spec DASH-SINK-004
const VOICE = urls.voice();
const here = dirname(fileURLToPath(import.meta.url));
const { control, bind } = setupControl(process.env, bus, log);
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

const uploads = new UploadStore(uploadOptionsFromEnv(process.env));
// @spec DASH-UPL-002
const sweeper = setInterval(() => uploads.sweep(), 60_000);
sweeper.unref();

const server = http.createServer(
  createDashboardHandler({ bus, log, html, uploads, cohostName: cfg.cohost.name, voiceUrl: VOICE, loadPersonality, savePersonality, services: () => tracker.snapshot(), control }),
);

const wss = new WebSocketServer({ server, path: "/ws" });
const feed = createFeed({ bus, tracker, clients: () => wss.clients });
wss.on("connection", (ws) => void serveClient(feed, ws, log)); // @spec DASH-HTTP-012
void startFeed(feed, log); // @spec DASH-HTTP-012

// @spec DASH-HTTP-009
const onListening = () => { heartbeat.ready(); log.info({ port: PORT, bind: bind ?? "default" }, "dashboard online"); };
if (bind) server.listen(PORT, bind, onListening); else server.listen(PORT, onListening);
// @spec DASH-HTTP-010
onShutdown(() => { clearInterval(sweeper); feed.stop(); wss.close(); server.close(); bus.stop(); });
