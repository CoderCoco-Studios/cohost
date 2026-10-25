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
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, envOr, loadConfig, loadPersonality, savePersonality, urls } from "@cohost/config";
import { createDashboardHandler } from "./routes.js";

const log = createLogger("dashboard");
const cfg = loadConfig();
const bus = new Bus("dashboard", log);
const PORT = Number(envOr("PORT", String(cfg.dashboard.port)));
const VOICE = urls.voice();
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

const server = http.createServer(
  createDashboardHandler({ bus, log, html, cohostName: cfg.cohost.name, voiceUrl: VOICE, loadPersonality, savePersonality }),
);

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", async (ws) => {
  for (const ev of await bus.recent(60)) ws.send(JSON.stringify(ev));
});
void bus.tail((ev) => {
  const msg = JSON.stringify(ev);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
});

server.listen(PORT, () => log.info({ port: PORT }, "dashboard online"));
onShutdown(() => { wss.close(); server.close(); bus.stop(); });
