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
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, envOr, loadConfig, loadPersonality, savePersonality } from "@cohost/config";

const log = createLogger("dashboard");
const cfg = loadConfig();
const bus = new Bus("dashboard", log);
const PORT = Number(envOr("PORT", String(cfg.dashboard.port)));
const VOICE = envOr("VOICE_URL", "http://voice:8700");
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "public", "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html.replace("__COHOST_NAME__", cfg.cohost.name));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
      const up = await fetch(`${VOICE}${url.pathname}`);
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "audio/wav", "cache-control": "no-store" });
      res.end(Buffer.from(await up.arrayBuffer()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/personality") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(loadPersonality());
      return;
    }
    if (req.method === "PUT" && url.pathname === "/personality") {
      savePersonality(await body(req));
      await bus.publish("control", { cmd: "reload_personality" });
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      const { cmd, text } = JSON.parse(await body(req)) as { cmd: BusEvent<"control">["data"]["cmd"]; text?: string };
      await bus.publish("control", { cmd, text });
      res.writeHead(204); res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/sink") {
      const { event, id } = JSON.parse(await body(req)) as { event: "playing" | "done"; id: string };
      await bus.publish(event === "playing" ? "voice.playing" : "voice.done", { id, sink: "dashboard" });
      res.writeHead(204); res.end();
      return;
    }
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
    res.writeHead(404); res.end("not found");
  } catch (err) {
    log.error({ err, url: req.url }, "request failed");
    res.writeHead(500); res.end(String(err));
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", async (ws) => {
  for (const ev of await bus.recent(60)) ws.send(JSON.stringify(ev));
});
void bus.tail((ev) => {
  const msg = JSON.stringify(ev);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
});

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, () => log.info({ port: PORT }, "dashboard online"));
onShutdown(() => { wss.close(); server.close(); bus.stop(); });
