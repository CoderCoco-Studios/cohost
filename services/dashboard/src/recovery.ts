import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import {
  ConfigError, ConfigSchema, PRESENTATION, SECTION_PATHS, canSetKey, checkConfig, ensureFromExample, etagOf, inputValue, loadConfig,
  placeholderFallback, rawSection, resetConfigKey, resetPathOf, secretPathOf, secretRepair, secretsPath, setConfigKey, updateSecrets, writeFileAtomic,
  type Config, type ConfigIssue, type ConfigProblem, type Logger,
} from "@cohost/config";
import { bearerOk, configRefusal, isLoopback } from "@cohost/control";
import { BodyTooLarge, readText } from "./body.js";
import { fullSurfaceBind } from "./control.js";
import { guardFullSurface } from "./host.js";
import { controlTokenFromEnv } from "./secrets.js";
import { noTokenDetail } from "./sensitive.js";
import { handleUi, locateUiDir } from "./static.js";

/** What the recovery screen offers for one problem. */
export interface RecoveryActions { set: boolean; reset: boolean; fallback: boolean }

/** One problem as `GET /recovery` serves it (DASH-RCV-004). */
export interface RecoveryProblem {
  file: "config" | "secrets";
  path: string;
  message: string;
  kind: ConfigProblem["kind"];
  /** A credential written into `config.yaml` (a secret path). */
  secret: boolean;
  /** A key the presentation table marks `sensitive`. */
  sensitive: boolean;
  /** The settings section that holds the key, with its title. */
  section?: { path: string; title: string };
  /** The value a `${NAME:-fallback}` placeholder declares, when the key's schema accepts it. */
  fallback?: unknown;
  /** The key a reset removes (or, for a secrets problem, repairs). */
  resetPath?: string;
  /** For a `secrets.yaml` problem at a path: `quote` rewrites the value as a quoted string, `clear` empties it. */
  repair?: "quote" | "clear";
  actions: RecoveryActions;
}

/** The files recovery mode reads and writes. */
export interface RecoveryFiles { configFile: string; secretsFile: string }

/** The settings section a dotted path belongs to: the longest declared section path it lies under. */
function sectionOf(path: string): { path: string; title: string } | undefined {
  const key = resetPathOf(path);
  const found = SECTION_PATHS.filter((s) => key === s || key.startsWith(`${s}.`)).toSorted((a, b) => b.length - a.length)[0];
  return found ? { path: found, title: PRESENTATION.sections[found]?.title ?? found } : undefined;
}

/**
 * The problems of the files as the recovery screen shows them: each loader problem with what can be done about it, computed
 * on `text`, the current text of `config.yaml`, and `secretsText`, the current text of `secrets.yaml`.
 */
// @spec DASH-RCV-004, DASH-RCV-008
export function recoveryProblems(problems: readonly ConfigProblem[], text: string, secretsText = ""): RecoveryProblem[] {
  return problems.map((p): RecoveryProblem => {
    const none: RecoveryActions = { set: false, reset: false, fallback: false };
    if (p.kind === "secrets") {
      const repair = p.path ? (secretRepair(secretsText, p.path).value === null ? "clear" : "quote") : undefined;
      return { file: "secrets", path: p.path, message: p.message, kind: p.kind, secret: true, sensitive: false, ...(p.path ? { resetPath: p.path, repair } : {}), actions: { ...none, reset: p.path !== "" } };
    }
    const base = { file: "config" as const, path: p.path, message: p.message, kind: p.kind };
    if (p.kind === "syntax" || p.path === "") return { ...base, secret: false, sensitive: false, actions: none };
    const resetPath = resetPathOf(p.path);
    const secret = secretPathOf(resetPath) !== undefined;
    const section = sectionOf(p.path);
    const held = resetConfigKey(text, p.path).ok;
    const fb = !secret && p.kind === "placeholder" ? placeholderFallback(text, p.path) : undefined;
    const fallbackOk = fb !== undefined && setConfigKey(text, p.path, fb.value).ok;
    return {
      ...base, secret, sensitive: PRESENTATION.keys[resetPath]?.sensitive === true, ...(section ? { section } : {}),
      ...(fallbackOk ? { fallback: fb.value } : {}), resetPath,
      actions: { set: !secret && canSetKey(p.path), reset: held, fallback: fallbackOk },
    };
  });
}

/**
 * The recovery listener's port and allowed host names: the file's `dashboard` section when it validates on its own, with no
 * placeholder in it, else the schema defaults.
 */
// @spec DASH-RCV-002
export function recoveryAddress(text: string | undefined): { port: number; allowedHosts: string[] } {
  const schema = ConfigSchema.shape.dashboard;
  const raw = text === undefined ? undefined : rawSection(text, "dashboard");
  const parsed = raw === undefined ? undefined : schema.safeParse(raw);
  const d = parsed?.success ? parsed.data : schema.parse({});
  return { port: d.port, allowedHosts: [...d.allowed_hosts] };
}

export interface RecoveryHandlerDeps {
  log: Pick<Logger, "info" | "error">;
  files: RecoveryFiles;
  /** `CONTROL_ENABLED=1`: every recovery write needs the token, and the stack routes answer 409 instead of 404. */
  controlEnabled: boolean;
  /** `CONTROL_ADVANCED`, reported by `GET /services/control` as in normal mode. */
  advanced?: boolean;
  /** The control token whenever one is configured, in either control mode. */
  controlToken?: string;
  /** Replaces `config.yaml` atomically; `writeFileAtomic` by default. */
  write?: (file: string, text: string) => void;
  /** The built UI; defaults to the one beside the server. */
  uiDir?: string;
  /** Called once a response that found the files valid has been sent, or its client has gone. */
  onValid: () => void;
}

const json = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
};

const STACK_POST = /^\/stack\/[^/]+$/;
const LIFECYCLE = /^\/services\/[^/]+\/(start|stop|restart)$/;
const RECOVERY_POST = /^\/recovery\/(set|reset|reset-all)$/;
const RECOVERY_DETAIL = "the dashboard is in config recovery mode: fix the config on its recovery screen first";

/**
 * The full surface in config recovery mode: the UI, `/health`, `GET /services/control`, the problem list and its three writes;
 * the stack and lifecycle routes are refused, everything else is a 503. The Host and Origin checks wrap it at the listener.
 */
// @spec DASH-RCV-003, DASH-RCV-004, DASH-RCV-005, DASH-RCV-006, DASH-RCV-007, DASH-RCV-009, DASH-RCV-010, DASH-RCV-012, DASH-RCV-015
export function createRecoveryHandler(d: RecoveryHandlerDeps): http.RequestListener {
  const write = d.write ?? writeFileAtomic;
  const uiDir = d.uiDir ?? locateUiDir();
  const { configFile, secretsFile } = d.files;
  const check = (configText?: string): ConfigProblem[] => checkConfig({ configFile, secretsFile, ...(configText !== undefined ? { configText } : {}) });
  let left = false;
  let fired = false;
  /** Leaves recovery mode once the answer is sent, or its client has gone, so a dropped page cannot strand the server. */
  const leave = (res: http.ServerResponse): void => {
    if (left) return;
    left = true;
    const go = (): void => {
      if (fired) return;
      fired = true;
      d.log.info("config recovery: the config is valid; leaving config recovery mode");
      d.onValid();
    };
    res.once("finish", go);
    res.once("close", go);
  };
  const readSecrets = (): string => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } };
  /** The port the normal dashboard binds once the file is valid: the validated `dashboard.port`. */
  const nextPort = (text: string): number => recoveryAddress(text).port;

  /** Answers a write that has been carried out: the fresh problem list, and leaving recovery mode when it is empty. */
  const written = (res: http.ServerResponse, what: string, extra: Record<string, unknown> = {}): void => {
    const text = readFileSync(configFile, "utf8");
    const problems = check();
    d.log.info(`config recovery: ${what}`);
    if (problems.length) d.log.info(`config recovery: ${problems.length} problem${problems.length === 1 ? "" : "s"} remain${problems.length === 1 ? "s" : ""}`);
    else leave(res);
    const valid = problems.length === 0;
    json(res, 200, { ok: true, etag: etagOf(text), problems: recoveryProblems(problems, text, readSecrets()), valid, ...(valid ? { port: nextPort(text) } : {}), ...extra });
  };

  /** The refusal of a `secrets.yaml` change without the control token (DASH-SECRET-003): 403 when none is configured, else 401. */
  const refuseSecrets = (res: http.ServerResponse, paths: string[]): void => {
    if (d.controlToken === undefined) { json(res, 403, { ok: false, detail: `changing secrets.yaml (${paths.join(", ")}) needs the control token, and none is configured: set CONTROL_TOKEN in .env (CONTROL_ENABLED does not have to be 1) and restart the dashboard`, secrets: paths }); return; }
    json(res, 401, { ok: false, detail: `changing secrets.yaml (${paths.join(", ")}) needs the control token (Authorization: Bearer)`, secrets: paths }, { "www-authenticate": "Bearer" });
  };

  const refuse = (res: http.ServerResponse, issues: ConfigIssue[]): void => json(res, 400, { ok: false, issues });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    if (handleUi(uiDir, "cohost", req, res, url)) return;
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
    if (method === "GET" && url.pathname === "/services/control") {
      json(res, 200, d.controlEnabled ? { enabled: true, runtime: "compose", advanced: !!d.advanced } : { enabled: false });
      return;
    }
    if (method === "GET" && url.pathname === "/recovery") {
      const text = readFileSync(configFile, "utf8");
      const problems = check();
      if (problems.length === 0) { leave(res); json(res, 200, { active: false, port: nextPort(text) }); return; }
      json(res, 200, { active: true, file: configFile, secretsFile, etag: etagOf(text), problems: recoveryProblems(problems, text, readSecrets()) });
      return;
    }
    if (method === "POST" && (STACK_POST.test(url.pathname) || LIFECYCLE.test(url.pathname))) {
      req.resume();
      if (!d.controlEnabled) { res.writeHead(404); res.end("not found"); return; }
      json(res, 409, { ok: false, detail: configRefusal(() => check()) ?? RECOVERY_DETAIL });
      return;
    }
    const op = method === "POST" ? RECOVERY_POST.exec(url.pathname)?.[1] : undefined;
    if (!op) { req.resume(); json(res, 503, { ok: false, detail: RECOVERY_DETAIL }); return; }

    const tokenOk = d.controlToken !== undefined && bearerOk(req.headers.authorization, d.controlToken);
    if (d.controlEnabled && !tokenOk) { req.resume(); res.writeHead(401, { "www-authenticate": "Bearer" }); res.end("unauthorized"); return; }
    let body: { etag?: unknown; path?: unknown; value?: unknown };
    try { body = JSON.parse(await readText(req)) as typeof body; } catch (e) {
      if (e instanceof BodyTooLarge) throw e;
      refuse(res, [{ path: "", message: "the body is not JSON" }]);
      return;
    }
    if (typeof body?.etag !== "string" || (op !== "reset-all" && typeof body.path !== "string")) {
      refuse(res, [{ path: "", message: op === "reset-all" ? "the body must be { etag: string }" : "the body must be { etag: string, path: string, ... }" }]);
      return;
    }
    // From here to the write nothing is awaited, so no other request can change the file in between.
    const text = readFileSync(configFile, "utf8");
    const current = etagOf(text);
    if (body.etag !== current) { json(res, 409, { ok: false, etag: current }); return; }
    const path = body.path as string;

    if (op === "set") {
      if (PRESENTATION.keys[path]?.sensitive && !tokenOk) {
        const sensitive = [path];
        if (d.controlToken === undefined) { json(res, 403, { ok: false, detail: noTokenDetail(path), sensitive }); return; }
        json(res, 401, { ok: false, detail: `changing ${path} needs the control token (Authorization: Bearer)`, sensitive }, { "www-authenticate": "Bearer" });
        return;
      }
      if (secretPathOf(resetPathOf(path)) !== undefined) { refuse(res, [{ path, message: "a credential: it belongs in secrets.yaml, set through its masked field on the Settings screen once the dashboard is back" }]); return; }
      const value = typeof body.value === "string" ? inputValue(path, body.value) : body.value;
      const edit = setConfigKey(text, path, value);
      if (!edit.ok) { refuse(res, edit.issues); return; }
      write(configFile, edit.text);
      written(res, `set ${path}`);
      return;
    }

    const secretsText = readSecrets();
    const problems = recoveryProblems(check(), text, secretsText);
    if (op === "reset") {
      const p = problems.find((x) => x.actions.reset && (x.path === path || x.resetPath === path));
      if (!p) { refuse(res, [{ path, message: "no failing key at this path can be reset" }]); return; }
      if (p.file === "secrets") {
        if (!tokenOk) { refuseSecrets(res, [p.path]); return; }
        updateSecrets(secretsFile, { [p.path]: secretRepair(secretsText, p.path).value });
      } else {
        const edit = resetConfigKey(text, p.resetPath!);
        if (!edit.ok) { refuse(res, edit.issues); return; }
        write(configFile, edit.text);
      }
      written(res, `reset ${p.resetPath ?? p.path}`);
      return;
    }

    // reset-all: rounds on the text in memory, then one write per file.
    // A secrets.yaml change needs the control token in both modes (DASH-SECRET-003): without it only config.yaml is repaired, and
    // the secrets paths are reported as waiting for the token.
    let next = text;
    const repairs = new Map<string, string | null>();
    const tokenNeeded: string[] = [];
    let edits = 0;
    for (let round = 0; round < 10; round++) {
      let changed = false;
      for (const p of recoveryProblems(check(next), next, secretsText)) {
        if (p.file === "secrets") {
          if (!p.actions.reset || repairs.has(p.path) || tokenNeeded.includes(p.path)) continue;
          if (tokenOk) { repairs.set(p.path, secretRepair(secretsText, p.path).value); edits++; } else tokenNeeded.push(p.path);
          continue;
        }
        if (p.actions.fallback) {
          const edit = setConfigKey(next, p.path, p.fallback);
          if (edit.ok && edit.text !== next) { next = edit.text; changed = true; edits++; continue; }
        }
        if (p.actions.reset) {
          const edit = resetConfigKey(next, p.path);
          if (edit.ok) { next = edit.text; changed = true; edits++; }
        }
      }
      if (!changed) break;
    }
    if (next !== text) write(configFile, next);
    if (repairs.size) updateSecrets(secretsFile, Object.fromEntries(repairs));
    written(res, `reset all (${edits} key${edits === 1 ? "" : "s"})`, tokenNeeded.length ? { tokenNeeded } : {});
  };

  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof BodyTooLarge) { if (!res.headersSent) { res.writeHead(413); res.end("body too large"); } return; }
      d.log.error({ err, url: req.url }, "config recovery: request failed");
      if (res.headersSent) res.destroy();
      else json(res, 500, { ok: false, detail: "the request failed; the dashboard's log has the details" });
    });
  };
}

export interface RecoveryOptions {
  env: NodeJS.ProcessEnv;
  log: Pick<Logger, "info" | "error" | "fatal">;
  /** The loader's error that started recovery mode. */
  error: ConfigError;
  files?: RecoveryFiles;
  exit?: (code: number) => void;
  uiDir?: string;
  /** Install SIGINT and SIGTERM handlers that close the listener and exit 0 (default true). */
  signals?: boolean;
}

/**
 * Runs config recovery mode: one full-surface listener with the recovery routes, until a request finds the files valid. Resolves
 * true once the listener is closed and the files validate, false when the listener could not bind (the process exit was asked for).
 */
// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-003, DASH-RCV-011
export async function runRecovery(o: RecoveryOptions): Promise<boolean> {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const files = o.files ?? { configFile: ensureFromExample("config.yaml", "config.example.yaml"), secretsFile: secretsPath() };
  const { bind, cfg } = fullSurfaceBind(o.env);
  let text: string | undefined;
  try { text = readFileSync(files.configFile, "utf8"); } catch { text = undefined; }
  const { port, allowedHosts } = recoveryAddress(text);
  let resolveValid: () => void = () => {};
  const valid = new Promise<void>((r) => { resolveValid = r; });
  const handler = createRecoveryHandler({
    log: o.log, files, controlEnabled: cfg.enabled, advanced: cfg.enabled && cfg.advanced, controlToken: controlTokenFromEnv(o.env),
    ...(o.uiDir ? { uiDir: o.uiDir } : {}), onValid: () => resolveValid(),
  });
  const server = http.createServer(guardFullSurface(handler, { loopback: isLoopback(bind), controlEnabled: cfg.enabled, allowedHosts }));
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => { o.log.fatal({ err }, `dashboard cannot listen on ${bind}:${port} (config recovery): ${err.message}`); resolve(false); });
    server.listen(port, bind, () => { server.removeAllListeners("error"); resolve(true); });
  });
  if (!listening) { exit(1); return false; }
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}:${addr.port}`;
  const n = o.error.problems.length;
  o.log.error({ url }, `config recovery mode: ${n} problem${n === 1 ? "" : "s"}; fix them at ${url}`);

  const stop = (): void => { server.close(); server.closeAllConnections(); exit(0); };
  if (o.signals !== false) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  await valid;
  if (o.signals !== false) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return true;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  log: Pick<Logger, "info" | "error" | "fatal">;
  exit?: (code: number) => void;
  /** Starts normal operation with the loaded configuration, or with none when it failed for a reason that is not the files. */
  run: (cfg: Config | undefined) => Promise<void>;
}

/**
 * The dashboard's start: load the configuration, and while it fails with a `ConfigError`, log the loader's message and run config
 * recovery mode; then start normal operation in this process. Any other failure is left to the bootstrap, which logs it and exits.
 */
// @spec DASH-HTTP-016, DASH-RCV-001, DASH-RCV-011
export async function startDashboard(o: StartOptions): Promise<void> {
  const env = o.env ?? process.env;
  let cfg: Config | undefined;
  for (;;) {
    try {
      cfg = loadConfig(true);
      break;
    } catch (e) {
      if (!(e instanceof ConfigError)) { cfg = undefined; break; }
      o.log.error(e.message);
      let ok: boolean;
      try { ok = await runRecovery({ env, log: o.log, error: e, ...(o.exit ? { exit: o.exit } : {}) }); } catch (err) {
        o.log.error(err instanceof Error ? err.message : String(err));
        (o.exit ?? ((c: number) => process.exit(c)))(1);
        return;
      }
      if (!ok) return;
    }
  }
  await o.run(cfg);
}
