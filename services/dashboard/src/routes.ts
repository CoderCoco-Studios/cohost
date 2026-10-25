import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { ServiceHealth } from "@cohost/control";

export interface DashboardDeps {
  bus: Publisher;
  log: Logger;
  /** public/index.html, with __COHOST_NAME__ still in it. */
  html: string;
  cohostName: string;
  /** The voice service, which holds the audio. */
  voiceUrl: string;
  loadPersonality: () => string;
  savePersonality: (text: string) => void;
  /** Derived per-service health (HealthTracker snapshot). */
  services: () => ServiceHealth[];
}

/** The dashboard's HTTP routes (the WebSocket feed is wired up in index.ts). */
export function createDashboardHandler(d: DashboardDeps): http.RequestListener {
  const page = d.html.replace("__COHOST_NAME__", d.cohostName);
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
        const up = await fetch(`${d.voiceUrl}${url.pathname}`);
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "audio/wav", "cache-control": "no-store" });
        res.end(Buffer.from(await up.arrayBuffer()));
        return;
      }
      if (req.method === "GET" && url.pathname === "/services") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ services: d.services() }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/personality") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(d.loadPersonality());
        return;
      }
      if (req.method === "PUT" && url.pathname === "/personality") {
        d.savePersonality(await body(req));
        await d.bus.publish("control", { cmd: "reload_personality" });
        res.writeHead(204); res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/control") {
        const { cmd, text } = JSON.parse(await body(req)) as { cmd: BusEvent<"control">["data"]["cmd"]; text?: string };
        await d.bus.publish("control", { cmd, text });
        res.writeHead(204); res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/sink") {
        const { event, id } = JSON.parse(await body(req)) as { event: "playing" | "done"; id: string };
        await d.bus.publish(event === "playing" ? "voice.playing" : "voice.done", { id, sink: "dashboard" });
        res.writeHead(204); res.end();
        return;
      }
      if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end("not found");
    } catch (err) {
      d.log.error({ err, url: req.url }, "request failed");
      res.writeHead(500); res.end(String(err));
    }
  };
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
