import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import { urls, type Logger } from "@cohost/config";
import { bearerOk, type ServiceController, type ServiceHealth, type StartMode } from "@cohost/control";
import { handleInject } from "./inject.js";
import { UploadStore, uploadOptionsFromEnv } from "./uploads.js";

export interface DashboardDeps {
  bus: Publisher;
  log: Logger;
  /** public/index.html, with __COHOST_NAME__ still in it. */
  html: string;
  cohostName: string;
  /** The voice service, which holds the audio. */
  voiceUrl: string;
  /** Injected test uploads (served at /uploads/:id). Defaults to a store configured from INJECT_* env. */
  uploads?: UploadStore;
  /** Base URL eyes/ears fetch uploads from. Defaults to `urls.dashboard()`. */
  dashboardUrl?: string;
  loadPersonality: () => string;
  savePersonality: (text: string) => void;
  /** Derived per-service health (HealthTracker snapshot). */
  services: () => ServiceHealth[];
  /**
   * Present only when CONTROL_ENABLED=1. Its presence turns on the service routes AND the bearer
   * token requirement on every mutating route (`POST /control`, `PUT /personality`).
   */
  control?: { token: string; runtime: string; advanced: boolean; controller: ServiceController };
}

const LIFECYCLE = /^\/services\/([^/]+)\/(start|stop|restart)$/;
const REFUSAL_STATUS = { unknown: 404, conflict: 409, forbidden: 403 } as const;

/** The dashboard's HTTP routes (the WebSocket feed is wired up in index.ts). */
export function createDashboardHandler(d: DashboardDeps): http.RequestListener {
  const uploads = d.uploads ?? new UploadStore(uploadOptionsFromEnv(process.env));
  const inject = {
    bus: d.bus,
    uploads,
    dashboardUrl: d.dashboardUrl ?? urls.dashboard(),
    authorize: (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (d.control && !bearerOk(req.headers.authorization, d.control.token)) { unauthorized(res); return false; }
      return true;
    },
  };
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
      if (await handleInject(inject, req, res, url)) return;
      if (req.method === "GET" && url.pathname === "/services") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ services: d.services() }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/services/control") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(d.control ? { enabled: true, runtime: d.control.runtime, advanced: d.control.advanced } : { enabled: false }));
        return;
      }
      const life = req.method === "POST" ? LIFECYCLE.exec(url.pathname) : null;
      if (life) {
        const ctl = d.control;
        if (!ctl) { res.writeHead(404); res.end("not found"); return; }
        if (!bearerOk(req.headers.authorization, ctl.token)) return unauthorized(res);
        const opts = parseLifecycleBody(await body(req));
        if (!opts) { res.writeHead(400); res.end("bad request body"); return; }
        const id = decodeURIComponent(life[1]!);
        const action = life[2] as "start" | "stop" | "restart";
        const out = await ctl.controller[action](id, opts);
        if (out.refused) {
          res.writeHead(REFUSAL_STATUS[out.refused], { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, detail: out.detail }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: out.ok, ...(out.detail ? { detail: out.detail } : {}) }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/personality") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(d.loadPersonality());
        return;
      }
      if (req.method === "PUT" && url.pathname === "/personality") {
        if (d.control && !bearerOk(req.headers.authorization, d.control.token)) return unauthorized(res);
        d.savePersonality(await body(req));
        await d.bus.publish("control", { cmd: "reload_personality" });
        res.writeHead(204); res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/control") {
        if (d.control && !bearerOk(req.headers.authorization, d.control.token)) return unauthorized(res);
        const { cmd, text, target } = JSON.parse(await body(req)) as { cmd: BusEvent<"control">["data"]["cmd"]; text?: string; target?: string };
        await d.bus.publish("control", { cmd, text, target });
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

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "www-authenticate": "Bearer" });
  res.end("unauthorized");
}

/** Only `mode` and `isolated` are read from the body; anything else is ignored. Undefined = malformed. */
function parseLifecycleBody(raw: string): { mode?: StartMode; isolated?: boolean } | undefined {
  if (raw.trim() === "") return {};
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return undefined; }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined;
  const { mode, isolated } = j as { mode?: unknown; isolated?: unknown };
  if (mode !== undefined && mode !== "resume" && mode !== "fresh") return undefined;
  if (isolated !== undefined && typeof isolated !== "boolean") return undefined;
  return { mode, isolated };
}

function body(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
