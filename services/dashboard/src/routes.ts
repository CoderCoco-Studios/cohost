import type http from "node:http";
import { handleUnlock, hasSession, pass, pathOf, UnlockLinks, type Gate } from "./access.js";
import type { Bus, BusEvent, Publisher } from "@cohost/bus";
import { ConfigSchema, findWorkspaceRoot, urls, type Logger } from "@cohost/config";
import { personalityUnits, writeProjections, type Store } from "@cohost/store";
import { SERVICE_MANIFEST, unitDescriptors, type ServiceController, type ServiceHealth, type StackActionKind, type StartMode } from "@cohost/control";
import { BodyTooLarge, readText } from "./body.js";
import { AppliedView } from "./applied.js";
import { handleDocs, locateDocsDir } from "./docs.js";
import { handleInject } from "./inject.js";
import { handleAvatarPage, handleUi, locateUiDir } from "./static.js";
import { handleOptions, type OptionsDeps } from "./options.js";
import { handleEgress } from "./egress.js";
import { handleMouthRouting } from "./routing.js";
import { handleModels, type ModelRoutes } from "./model-routes.js";
import { ModelStore, modelsDir } from "./models.js";
import { handleToolAnswer } from "./tools-routes.js";
import { handleSecrets } from "./secrets.js";
import { handleConfig } from "./settings.js";
import type { StackService } from "./stack.js";
import { uploadLimits, type UploadLimits } from "./uploads.js";
import { ViewersClient, handleViewers } from "./viewers.js";

export interface DashboardDeps {
  /** `putUpload` stores injected uploads in Redis. */
  bus: Publisher & Pick<Bus, "putUpload">;
  log: Logger;
  /** The built UI (`dist-ui/`): `index.html` is read per request. Defaults to the one beside the server's `dist/`; tests pin it. */
  uiDir?: string;
  cohostName: string;
  /** The voice service, which holds the audio. */
  voiceUrl: string;
  /** Upload size caps and TTL (`dashboard.inject`). Defaults to the config schema's defaults. */
  uploads?: UploadLimits;
  /** Request/reply client for the Viewers page; the feed hands it memory's replies. Defaults to a private client that never hears one. */
  viewers?: ViewersClient;
  /** The settings store, opened by the dashboard (settings-store STORE-PKG-001): settings, documents, credentials and the gate. */
  store: Store;
  /** The workspace root the personality projections are written under (STORE-PROJ-006); the one found from the working directory by default. */
  root?: string;
  /** Derived per-service health (HealthTracker snapshot). */
  services: () => ServiceHealth[];
  /**
   * The one lock (the store's token verifier and session key, DASH-CTRL-011) and the service controller. Every mutation passes
   * the gate, and the stack and lifecycle routes are served on every run (DASH-CTRL-001).
   */
  control: { gate: Gate; runtime: string; advanced: boolean; controller: ServiceController };
  /** The unlock link's nonces (DASH-UNL-002); a private set by default. */
  unlock?: UnlockLinks;
  /** The pick-list routes' backing servers. Defaults to `urls.tts()` and `urls.ollama()` and a 3 s timeout; tests pin them. */
  options?: Partial<OptionsDeps>;
  /** The stack state and action slot (`GET /stack`, `POST /stack/*`, and the slot the lifecycle routes share). */
  stack: StackService;
  /** The built docs site (`docs/.vitepress/dist`). Defaults to the one under the workspace root; tests pin it. */
  docsDir?: string;
  /** The avatar model store, the applied view and `dashboard.models.max_bytes`. Defaults to the data dir's store and an empty view. */
  models?: { store: ModelStore; applied: AppliedView; maxBytes: number };
  /** `GET /avatar/renderer`'s snapshot (the relay's status); absent in a test that does not run the relay. */
  renderer?: () => object;
}

const LIFECYCLE = /^\/services\/([^/]+)\/(start|stop|restart)$/;
const REFUSAL_STATUS = { unknown: 404, forbidden: 403 } as const;
const STACK_ACTION = /^\/stack\/(launch|rebuild|stop|restart|consolidate)$/;

// @spec DASH-CTRL-001, DASH-CTRL-004, DASH-CTRL-005
/** The dashboard's HTTP routes (the WebSocket feed is wired up in index.ts). */
export function createDashboardHandler(d: DashboardDeps): http.RequestListener {
  /** The one lock: every mutation needs it or a session cookie (DASH-CTRL-004, DASH-CTRL-011). */
  const gate = d.control.gate;
  const uploads = d.uploads ?? uploadLimits(ConfigSchema.shape.dashboard.parse({}).inject);
  const inject = {
    bus: d.bus,
    uploads,
    stateOf: (unit: string) => d.services().find((s) => s.service === unit)?.state,
    authorize: (req: http.IncomingMessage, res: http.ServerResponse) => pass(gate, req, res),
  };
  const applied = d.models?.applied ?? new AppliedView(d.log);
  const store = d.models?.store ?? new ModelStore(modelsDir());
  const modelRoutes: ModelRoutes = {
    store, applied, maxBytes: d.models?.maxBytes ?? ConfigSchema.shape.dashboard.parse({}).models.max_bytes, gate, slot: { busy: false },
  };
  const settings = {
    store: d.store,
    manifest: SERVICE_MANIFEST,
    stack: () => d.stack.snapshot(),
    gate,
    body: readText,
    models: { store, applied },
  };
  const secrets = { gate, store: d.store, manifest: SERVICE_MANIFEST, stack: settings.stack, log: d.log };
  const options: OptionsDeps = { urls: d.options?.urls ?? urls, config: () => d.store.config(), ...(d.options?.timeoutMs ? { timeoutMs: d.options.timeoutMs } : {}) };
  const viewers = { client: d.viewers ?? new ViewersClient(d.bus), gate };
  const uiDir = d.uiDir ?? locateUiDir(); // once, at startup; its files are read per request (DASH-BUILD-005)
  const docsDir = d.docsDir ?? locateDocsDir(); // once, at startup (DASH-DOCS-001)
  const unlock = { gate, links: d.unlock ?? new UnlockLinks() };
  const root = d.root ?? findWorkspaceRoot() ?? process.cwd();
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      // @spec DASH-HTTP-001, DASH-BUILD-003, DASH-BUILD-004, DASH-BUILD-005
      if (handleUi(uiDir, d.cohostName, req, res, url)) return;
      // @spec DASH-AVP-001, DASH-AVP-002
      if (handleAvatarPage(uiDir, req, res, url)) return;
      // @spec DASH-AVR-018
      if (req.method === "GET" && url.pathname === "/avatar/renderer" && d.renderer) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(d.renderer()));
        return;
      }
      // @spec DASH-DOCS-001, DASH-DOCS-011
      if (handleDocs(docsDir, req, res, url)) return;
      // @spec DASH-UNL-003, DASH-UNL-004, DASH-UNL-006
      if (await handleUnlock(unlock, req, res, url)) return;
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
      // @spec DASH-MDL-004, DASH-MDL-008, DASH-MDL-009, DASH-MDL-010, DASH-MDL-015, DASH-MDL-033
      if (await handleModels(modelRoutes, req, res, url)) return;
      // @spec DASH-TOOL-001, DASH-TOOL-002
      if (await handleToolAnswer({ bus: d.bus, gate }, req, res, url)) return;
      // @spec MOD-TEST-002, MOD-TEST-003, MOD-TEST-004, MOD-TEST-005, MOD-TEST-006, DASH-INJ-008
      if (await handleInject(inject, req, res, url)) return;
      // @spec DASH-ROUTE-001, DASH-ROUTE-002, DASH-ROUTE-003
      if (await handleMouthRouting({ bus: d.bus, authorize: inject.authorize, body: readText }, req, res, url)) return;
      // @spec DASH-SECRET-001, DASH-SECRET-002, DASH-SECRET-003, DASH-SECRET-004, DASH-SECRET-005, DASH-SECRET-006, DASH-SECRET-007, DASH-SECRET-008, DASH-SECRET-009, DASH-SECRET-010, DASH-SECRET-011, DASH-SECRET-012
      if (await handleSecrets(secrets, req, res, url)) return;
      // @spec DASH-OPT-001, DASH-OPT-002, DASH-OPT-003, DASH-OPT-004
      if (await handleOptions(options, req, res, url)) return;
      // @spec DASH-EGR-001, DASH-EGR-002, DASH-EGR-003, DASH-EGR-004
      if (handleEgress(() => d.store.config(), req, res, url)) return;
      // @spec DASH-RCV-004, DASH-RCV-029, STORE-KEY-010
      if (url.pathname === "/recovery" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ active: false, ...(d.store.recoveryKeyUnconfirmed() ? { recoveryKeyUnconfirmed: true } : {}) }));
        return;
      }
      // @spec DASH-RCV-029, STORE-KEY-010
      if (req.method === "POST" && url.pathname === "/recovery/key-confirmed") {
        if (!(await pass(gate, req, res, "json"))) return;
        req.resume();
        d.store.confirmRecoveryKey();
        d.log.info("the recovery key is marked as saved");
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      // @spec DASH-RCV-010
      if (req.method === "POST" && url.pathname.startsWith("/recovery/")) {
        req.resume();
        res.writeHead(409, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, detail: "the dashboard is not in config recovery mode: the settings store can be used" }));
        return;
      }
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
        res.end(JSON.stringify({ runtime: d.control.runtime, advanced: d.control.advanced, unlocked: hasSession(gate, req) }));
        return;
      }
      // @spec DASH-SVC-001, DASH-SVC-002, DASH-SVC-003, DASH-CTRL-001
      const life = req.method === "POST" ? LIFECYCLE.exec(url.pathname) : null;
      if (life) {
        const ctl = d.control;
        if (!(await pass(gate, req, res))) return;
        let id: string;
        try { id = decodeURIComponent(life[1]!); } catch { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, detail: "unknown service" })); return; } // @spec DASH-HTTP-013
        const opts = parseLifecycleBody(await readText(req));
        if (!opts) { res.writeHead(400); res.end("bad request body"); return; }
        const action = life[2] as "start" | "stop" | "restart";
        const release = d.stack.tryAcquire(`service-${action}`); // @spec DASH-STACK-003
        if (!release) { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, detail: d.stack.busyDetail() })); return; }
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
        if (!(await pass(gate, req, res))) return;
        req.resume(); // any body is ignored: nothing from the request reaches an argv
        const out = d.stack.request(stackAct[1] as StackActionKind, ctl.controller);
        res.writeHead(out.ok ? 202 : out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.ok ? { ok: true, action: out.action } : { ok: false, detail: out.detail }));
        return;
      }
      // @spec DASH-HTTP-005
      if (req.method === "GET" && url.pathname === "/personality") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(d.store.personality() ?? "");
        return;
      }
      // @spec DASH-HTTP-006, STORE-PROJ-006
      if (req.method === "PUT" && url.pathname === "/personality") {
        if (!(await pass(gate, req, res))) return;
        const written = await d.store.writeWithRetry({ personality: await readText(req) });
        if (!written.ok) {
          res.writeHead(written.conflict ? 409 : 400, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(written.conflict ? { ok: false, etag: String(written.revision) } : { ok: false, issues: written.issues }));
          return;
        }
        writeProjections(d.store, root, personalityUnits());
        await d.bus.publish("control", { cmd: "reload_personality" });
        res.writeHead(204); res.end();
        return;
      }
      // @spec DASH-HTTP-007, DASH-HTTP-008, DASH-HTTP-017
      if (req.method === "POST" && url.pathname === "/control") {
        if (!(await pass(gate, req, res))) return;
        const { cmd, text, target, route } = JSON.parse(await readText(req)) as { cmd: BusEvent<"control">["data"]["cmd"]; text?: string; target?: string; route?: string[] };
        await d.bus.publish("control", { cmd, text, target, ...(route !== undefined ? { route } : {}) });
        res.writeHead(204); res.end();
        return;
      }
      // @spec DASH-SINK-002
      if (req.method === "POST" && url.pathname === "/sink") {
        const body = JSON.parse(await readText(req)) as { event?: unknown; id: string; seq?: unknown; interrupted?: unknown; final?: unknown; spokenText?: unknown; unsaidText?: unknown };
        const { event, id } = body;
        if (event !== "playing" && event !== "done") { res.writeHead(400); res.end("event must be 'playing' or 'done'"); return; } // @spec DASH-SINK-003
        // @spec DASH-SINK-005
        const seq = body.seq;
        if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) { res.writeHead(400); res.end("seq must be a non-negative integer"); return; }
        if (event === "playing") await d.bus.publish("voice.playing", { id, seq, sink: "dashboard" }); // @spec DASH-SINK-002
        else {
          // @spec DASH-SINK-002, DASH-SINK-006, DASH-SINK-007
          const extra = {
            ...(body.interrupted !== undefined ? { interrupted: body.interrupted } : {}),
            ...(body.spokenText !== undefined ? { spokenText: body.spokenText } : {}),
            ...(body.unsaidText !== undefined ? { unsaidText: body.unsaidText } : {}),
            ...(body.final !== undefined ? { final: body.final } : {}),
          };
          await d.bus.publish("voice.done", { id, seq, sink: "dashboard", ...extra } as never);
        }
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
      d.log.error({ err, path: pathOf(req) }, "request failed"); // the path only: a query string can hold a nonce (DASH-UNL-002)
      sendUnlessStarted(res, 500, String(err));
    }
  };
  return (req, res) => { void handle(req, res).catch((err: unknown) => d.log.error({ err, path: pathOf(req) }, "request handler failed")); };
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
