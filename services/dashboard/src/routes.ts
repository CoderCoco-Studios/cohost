import type http from "node:http";
import type { BusEvent, Publisher } from "@cohost/bus";
import { ensureFromExample, type Logger } from "@cohost/config";
import { bearerOk, SERVICE_MANIFEST, unitDescriptors, type ServiceController, type ServiceHealth, type StackActionKind, type StartMode } from "@cohost/control";
import { BodyTooLarge, readText } from "./body.js";
import { handleInject, uploadBase } from "./inject.js";
import { defaultWrite, handleConfig } from "./settings.js";
import type { StackService } from "./stack.js";
import { UploadStore, uploadOptionsFromEnv } from "./uploads.js";
import { ViewersClient, handleViewers } from "./viewers.js";

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
  /** Request/reply client for the Viewers page; the feed hands it memory's replies. Defaults to a private client that never hears one. */
  viewers?: ViewersClient;
  /** `VIEWERS_TOKEN` (env only). Unset or empty locks every `/viewers` route with a 403; independent of `control`. */
  viewersToken?: string;
  loadPersonality: () => string;
  savePersonality: (text: string) => void;
  /** Derived per-service health (HealthTracker snapshot). */
  services: () => ServiceHealth[];
  /**
   * Present only when CONTROL_ENABLED=1. Its presence turns on the service routes AND the bearer
   * token requirement on every mutating route (`POST /control`, `PUT /personality`).
   */
  control?: { token: string; runtime: string; advanced: boolean; controller: ServiceController };
  /** Path of `config.yaml` for the settings routes. Defaults to the loader's file, seeded from the example when missing. */
  configFile?: () => string;
  /** The environment the settings routes substitute placeholders from. Defaults to `process.env`. */
  configEnv?: NodeJS.ProcessEnv;
  /** Replaces `config.yaml` atomically. Defaults to `writeFileAtomic`. */
  configWrite?: (file: string, text: string) => void;
  /** The stack state and action slot (`GET /stack`, `POST /stack/*`, and the slot the lifecycle routes share). */
  stack: StackService;
}

const LIFECYCLE = /^\/services\/([^/]+)\/(start|stop|restart)$/;
const REFUSAL_STATUS = { unknown: 404, forbidden: 403 } as const;
const STACK_ACTION = /^\/stack\/(launch|rebuild|stop|restart|consolidate)$/;

// @spec DASH-CTRL-001, DASH-CTRL-004, DASH-CTRL-005
/** The dashboard's HTTP routes (the WebSocket feed is wired up in index.ts). */
export function createDashboardHandler(d: DashboardDeps): http.RequestListener {
  const uploads = d.uploads ?? new UploadStore(uploadOptionsFromEnv(process.env));
  const inject = {
    bus: d.bus,
    uploads,
    stateOf: (unit: string) => d.services().find((s) => s.service === unit)?.state,
    dashboardUrl: d.dashboardUrl ?? uploadBase(process.env),
    authorize: (req: http.IncomingMessage, res: http.ServerResponse) => {
      if (d.control && !bearerOk(req.headers.authorization, d.control.token)) { unauthorized(res); return false; }
      return true;
    },
  };
  const settings = {
    file: d.configFile ?? (() => ensureFromExample("config.yaml", "config.example.yaml")),
    env: d.configEnv ?? process.env,
    write: d.configWrite ?? defaultWrite,
    manifest: SERVICE_MANIFEST,
    stack: () => d.stack.snapshot(),
    authorize: inject.authorize,
    body: readText,
  };
  const viewers = { client: d.viewers ?? new ViewersClient(d.bus), token: d.viewersToken };
  const page = d.html.split("__COHOST_NAME__").join(d.cohostName); // every occurrence; split/join so `$` in the name is literal
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      // @spec DASH-HTTP-001
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }
      // @spec DASH-SINK-001
      if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
        const up = await fetch(`${d.voiceUrl}${url.pathname}`);
        const audio = Buffer.from(await up.arrayBuffer()); // whole body first: a failed read must still be answerable with a 500
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "audio/wav", "cache-control": "no-store" });
        res.end(audio);
        return;
      }
      // @spec DASH-VIEWERS-001, DASH-VIEWERS-002, DASH-VIEWERS-003, DASH-VIEWERS-004, DASH-VIEWERS-005, DASH-VIEWERS-006, DASH-VIEWERS-007, DASH-VIEWERS-008, DASH-VIEWERS-009
      if (await handleViewers(viewers, req, res, url)) return;
      // @spec MOD-TEST-002, MOD-TEST-003, MOD-TEST-004, MOD-TEST-005, MOD-TEST-006, DASH-INJ-008
      if (await handleInject(inject, req, res, url)) return;
      // @spec MOD-CFG-001, MOD-CFG-003, MOD-CFG-007, MOD-CFG-016
      if (await handleConfig(settings, req, res, url)) return;
      // @spec DASH-FEED-006
      if (req.method === "GET" && url.pathname === "/services") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ services: d.services() }));
        return;
      }
      // @spec DASH-HTTP-014, MOD-MAN-007
      if (req.method === "GET" && url.pathname === "/services/manifest") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ units: unitDescriptors() }));
        return;
      }
      // @spec DASH-CTRL-007
      if (req.method === "GET" && url.pathname === "/services/control") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(d.control ? { enabled: true, runtime: d.control.runtime, advanced: d.control.advanced } : { enabled: false }));
        return;
      }
      // @spec DASH-SVC-001, DASH-SVC-002, DASH-SVC-003
      const life = req.method === "POST" ? LIFECYCLE.exec(url.pathname) : null;
      if (life) {
        const ctl = d.control;
        if (!ctl) { res.writeHead(404); res.end("not found"); return; }
        if (!bearerOk(req.headers.authorization, ctl.token)) return unauthorized(res);
        let id: string;
        try { id = decodeURIComponent(life[1]!); } catch { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, detail: "unknown service" })); return; } // @spec DASH-HTTP-013
        const opts = parseLifecycleBody(await readText(req));
        if (!opts) { res.writeHead(400); res.end("bad request body"); return; }
        const action = life[2] as "start" | "stop" | "restart";
        const release = d.stack.tryAcquire(`service-${action}`); // @spec DASH-STACK-003
        if (!release) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, detail: `busy: ${d.stack.busyKind()}` })); return; }
        let out;
        try { out = await ctl.controller[action](id, opts); } finally { release(); }
        if (out.refused) {
          res.writeHead(REFUSAL_STATUS[out.refused], { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, detail: out.detail }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: out.ok, ...(out.detail ? { detail: out.detail } : {}) }));
        return;
      }
      // @spec DASH-STACK-001, DASH-CTRL-005
      if (req.method === "GET" && url.pathname === "/stack") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(d.stack.snapshot()));
        return;
      }
      // @spec DASH-STACK-002, DASH-STACK-003, DASH-STACK-004, DASH-STACK-005, DASH-CTRL-001, DASH-CTRL-004
      const stackAct = req.method === "POST" ? STACK_ACTION.exec(url.pathname) : null;
      if (stackAct) {
        const ctl = d.control;
        if (!ctl) { res.writeHead(404); res.end("not found"); return; }
        if (!bearerOk(req.headers.authorization, ctl.token)) return unauthorized(res);
        req.resume(); // any body is ignored: nothing from the request reaches an argv
        const out = d.stack.request(stackAct[1] as StackActionKind, ctl.controller);
        res.writeHead(out.ok ? 202 : out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.ok ? { ok: true, action: out.action } : { ok: false, detail: out.detail }));
        return;
      }
      // @spec DASH-HTTP-005
      if (req.method === "GET" && url.pathname === "/personality") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(d.loadPersonality());
        return;
      }
      // @spec DASH-HTTP-006
      if (req.method === "PUT" && url.pathname === "/personality") {
        if (d.control && !bearerOk(req.headers.authorization, d.control.token)) return unauthorized(res);
        d.savePersonality(await readText(req));
        await d.bus.publish("control", { cmd: "reload_personality" });
        res.writeHead(204); res.end();
        return;
      }
      // @spec DASH-HTTP-007, DASH-HTTP-008
      if (req.method === "POST" && url.pathname === "/control") {
        if (d.control && !bearerOk(req.headers.authorization, d.control.token)) return unauthorized(res);
        const { cmd, text, target } = JSON.parse(await readText(req)) as { cmd: BusEvent<"control">["data"]["cmd"]; text?: string; target?: string };
        await d.bus.publish("control", { cmd, text, target });
        res.writeHead(204); res.end();
        return;
      }
      // @spec DASH-SINK-002
      if (req.method === "POST" && url.pathname === "/sink") {
        const { event, id } = JSON.parse(await readText(req)) as { event?: unknown; id: string };
        if (event !== "playing" && event !== "done") { res.writeHead(400); res.end("event must be 'playing' or 'done'"); return; } // @spec DASH-SINK-003
        await d.bus.publish(event === "playing" ? "voice.playing" : "voice.done", { id, sink: "dashboard" });
        res.writeHead(204); res.end();
        return;
      }
      // @spec DASH-HTTP-002
      if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
      // @spec DASH-HTTP-003
      res.writeHead(404); res.end("not found");
    } catch (err) {
      // @spec DASH-HTTP-011
      if (err instanceof BodyTooLarge) { sendUnlessStarted(res, 413, "body too large"); return; }
      // @spec DASH-HTTP-004
      d.log.error({ err, url: req.url }, "request failed");
      sendUnlessStarted(res, 500, String(err));
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

/** Failure responses never throw: if the headers already went out the connection is cut instead. */
function sendUnlessStarted(res: http.ServerResponse, status: number, text: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status); res.end(text);
}
