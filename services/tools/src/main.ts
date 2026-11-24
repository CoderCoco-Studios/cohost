/**
 * The tools service: wiring on `runService` (TOOL-SVC-001 to TOOL-SVC-003). It keeps the catalog, runs each request
 * through the call pipeline and answers test injections. MCP sources come from `createSources` (the MCP client
 * supplies them); in mock mode the service builds its own mock sources and opens no connection.
 */
import { randomUUID } from "node:crypto";
import type { Bus, BusEvent, EventType, Publisher } from "@cohost/bus";
import { createLogger, egressDestinations, type Config } from "@cohost/config";
import { createInjectHandler, runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { buildSnapshot, publishedServers, publishedTool, type DepStatus, type Mode, type Snapshot } from "./catalog.js";
import { CallPipeline, type ToolRequest } from "./calls.js";
import { BuiltinTools, type BuiltinEnv } from "./builtin/index.js";
import { healthOf, type Health } from "./health.js";
import { mockSources } from "./mock.js";
import { mcpSources, type McpEnv } from "./mcp.js";
import type { ToolSource } from "./source.js";

/** What `toolsMain` needs from a Bus; tests pass a fake. */
export type ToolsBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop" | "putTimer" | "deleteTimer" | "listTimers">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, signals or exit. */
export type ToolsEnv = Pick<RunServiceOptions<ToolsBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  /** The live sources of the configured servers. Not called in mock mode; absent, the MCP client builds one per server. */
  createSources?: (cfg: Config) => ToolSource[];
  /** The MCP client's seam: the backoff and the setup timeout of each server connection (TOOL-MCP-014). */
  mcp?: McpEnv;
  /** The built-in tools' seams: `fetch` for the platform calls, the epoch clock and the one scheduler of every wait. */
  builtin?: BuiltinEnv;
};

/** The dependencies the heartbeat reads: none until the service has checked its sources (TOOL-SVC-004). */
interface HealthRef { deps: () => Record<string, DepStatus> }

/** The event types the service subscribes to, in one group (TOOL-SVC-001). */
const SUBSCRIBED: EventType[] = ["tool.request", "tool.answer", "memory.recall.reply", "inject.request"];

/** The fields of a valid test injection `{"tool", "arguments"}` (TOOL-INJ-001), or the problem with its text (TOOL-INJ-003). */
function parseInjection(text: string | undefined): { tool: string; arguments: Record<string, unknown> } | { problem: string } {
  if (text === undefined) return { problem: "the injection carries no text" };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { problem: "the text is not JSON" }; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { problem: 'the text is not a JSON object {"tool", "arguments"}' };
  const o = v as Record<string, unknown>;
  if (typeof o.tool !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(o.tool)) return { problem: "the tool is missing or not a tool name" };
  const args = o.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { problem: "the arguments are not a JSON object" };
  return { tool: o.tool, arguments: args as Record<string, unknown> };
}

/** Builds and starts the service on the shared bootstrap (TOOL-SVC-001 to TOOL-SVC-003, TOOL-SVC-004). */
// @spec TOOL-SVC-001, TOOL-SVC-002, TOOL-SVC-003, TOOL-SVC-004, TOOL-SVC-007, TOOL-SVC-008, TOOL-CAT-011, TOOL-MOCK-001, TOOL-INJ-001, TOOL-INJ-002, TOOL-INJ-003, TOOL-ORIG-001
export async function toolsMain(
  ctx: ServiceContext<ToolsBus>,
  env: ToolsEnv,
  health: HealthRef,
  exit: (code: number) => void,
): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const mode: Mode = cfg.tools.mode;
  const sources: ToolSource[] = mode === "mock" ? mockSources(cfg) : (env.createSources ?? ((c) => mcpSources(c, env.mcp)))(cfg);
  const builtins = new BuiltinTools({ cfg, mode, bus, log, env: env.builtin ?? {} });
  // @spec TOOL-MCP-007, TOOL-MCP-011: one start warning for each egress entry of a server that is off the LAN, naming the server and the host.
  if (mode === "live") {
    for (const e of egressDestinations(cfg)) {
      if (e.service === "tools" && e.offLan) log.warn({ server: e.engine.replace(/^mcp:/, ""), host: e.host }, "MCP server is off the LAN: its arguments leave this machine");
    }
  }

  // The group must exist before the subscription; resetGroup creates it at `$`, the same as start mode `latest`.
  await bus.resetGroup("tools");

  let checked = false;
  let latest: Health = { deps: {}, detail: "", degraded: false };
  let lastKey: string | undefined;
  const snapshot = (): Snapshot => buildSnapshot(cfg, sources, mode, builtins.tools);
  // The built-ins' dependencies are read live (TOOL-STRM-007, TOOL-MEM-006); the servers' are as the last check left them.
  health.deps = () => ({ ...(checked ? latest.deps : {}), ...builtins.deps() });

  const pipeline = new CallPipeline({
    mode,
    limits: {
      timeoutMs: cfg.tools.timeout_ms,
      confirmTimeoutMs: cfg.tools.confirm_timeout_ms,
      maxConcurrent: cfg.tools.max_concurrent,
      maxResultChars: cfg.tools.max_result_chars,
    },
    snapshot,
    publish: (result) => { bus.publish("tool.result", result).catch(() => log.warn({ id: result.id }, "tool.result publish failed")); },
    publishConfirm: (confirm) => { bus.publish("tool.confirm", confirm).catch(() => log.warn({ id: confirm.id }, "tool.confirm publish failed")); },
    log,
  });

  // Test injection: `{tool, arguments}` runs as origin dashboard, round 1, not listed, injected (TOOL-INJ-001).
  const inject = createInjectHandler({
    target: "tools",
    bus,
    log,
    maxBytes: {},
    kinds: {
      text: async (req) => {
        const parsed = parseInjection(req.text);
        if ("problem" in parsed) return { ok: false, detail: parsed.problem };
        const r = await pipeline.handle(
          { id: randomUUID(), tool: parsed.tool, arguments: parsed.arguments, origin: "dashboard", round: 1, listed: false, injected: true },
          performance.now(),
          Date.now(),
        );
        if (r === undefined) return { ok: false, detail: "duplicate request id" };
        return { ok: true, detail: `status ${r.status}${r.reason ? ` (${r.reason})` : ""} in ${r.durationMs} ms` }; // TOOL-INJ-002
      },
    },
  });

  const dispatch = (ev: BusEvent<EventType>): void => {
    switch (ev.type) {
      case "tool.request":
        // TOOL-SVC-007: one result per request; a failure of the service's own code is logged, never thrown into the bus.
        const req = ev.data as ToolRequest;
        pipeline.handle(req, performance.now(), Date.now())
          .catch(() => log.error({ id: req.id }, "tool request failed in the service"));
        return;
      case "tool.answer": {
        const d = ev.data as BusEvent<"tool.answer">["data"];
        pipeline.answer(d.id, d.allow);
        return;
      }
      case "inject.request":
        inject(ev as BusEvent<"inject.request">);
        return;
      case "memory.recall.reply":
        // @spec TOOL-MEM-003
        builtins.memoryReply(ev.data as BusEvent<"memory.recall.reply">["data"]);
        return;
      default:
        return;
    }
  };

  void bus.subscribe({ group: "tools", types: SUBSCRIBED, start: "latest" }, (ev) => dispatch(ev as BusEvent<EventType>)).catch((err) => {
    log.error({ err }, "fatal");
    exit(1);
  });
  // The stored timers are read and armed once the group exists (TOOL-TIMER-007); a due one fires at once.
  void builtins.start().catch(() => log.error("built-in tools failed to start"));

  /** Publishes the catalog when it changed, or always when forced, and sets the heartbeat from its dependencies. */
  const refresh = (force: boolean): void => {
    try {
      const snap = snapshot();
      checked = true;
      const key = JSON.stringify([snap.tools.map(publishedTool), publishedServers(snap)]);
      if (force || key !== lastKey) {
        lastKey = key;
        bus.publish("tool.catalog", { intervalMs: cfg.tools.catalog_ms, mode, servers: publishedServers(snap), tools: snap.tools.map(publishedTool) })
          .catch(() => log.warn("tool.catalog publish failed"));
      }
      latest = healthOf(snap);
      heartbeat.setDetail(latest.detail);
      if (latest.degraded) heartbeat.degraded(latest.detail);
      else heartbeat.ready();
    } catch {
      // A source that throws while it is listed must not end the service: the last catalog stands and this is logged.
      log.error("catalog refresh failed in the service");
    }
  };

  // Ready once the group exists, before any source is checked (TOOL-SVC-004); the first refresh checks them.
  heartbeat.ready();
  refresh(true); // TOOL-CAT-011: published when ready

  for (const s of sources) s.onChange(() => refresh(false)); // TOOL-CAT-011: on a change
  for (const s of sources) s.start?.(); // the sources connect only now, so no change is missed (TOOL-MCP-002)
  const timer = setInterval(() => refresh(true), cfg.tools.catalog_ms); // TOOL-CAT-011: every catalog_ms

  // Shutdown runs in reverse: refuse the calls and confirmations first, then stop the timer, then close the sources
  // (TOOL-SVC-008). The bus is closed by runService after these steps.
  // Every source closes at once, so a slow session close does not hold up the others (TOOL-SVC-008).
  onStop(async () => { await Promise.allSettled(sources.map((s) => s.close())); });
  onStop(() => clearInterval(timer));
  onStop(() => pipeline.shutdown());
  onStop(() => builtins.stop()); // cancels the timers' waits and ends the lookups; pending timers stay stored (TOOL-SVC-008)

  log.info({ mode, servers: Object.keys(cfg.tools.servers).length, sources: sources.length }, "tools online");
}

/** The service entry: bootstrap, then `toolsMain`. */
export function runTools(env: ToolsEnv = {}): Promise<void> {
  const { createSources, mcp, builtin, ...boot } = env;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("tools");
  const health: HealthRef = { deps: () => ({}) };
  return runService<ToolsBus>({
    service: "tools",
    health: (cfg: Config) => ({
      service: "tools",
      mode: cfg.tools.mode === "mock" ? "mock" : "live", // TOOL-SVC-005
      deps: () => health.deps(),
    }),
    main: (ctx) => toolsMain(ctx, { createSources, mcp, builtin }, health, exit),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
