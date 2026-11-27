import http from "node:http";
import { authorized, handleUnlock, hasSession, pathOf, tokenRefusal, unlockBase, unlockLine, UnlockLinks } from "./access.js";
import type { AddressInfo } from "node:net";
import { chmodSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  ConfigError, ConfigSchema, PRESENTATION, SECTION_PATHS, canSetKey, checkConfig, ensureFromExample, etagOf, inputValue, loadConfig,
  parseConfigText, placeholderFallback, rawSection, resetConfigKey, resetPathOf, secretPathOf, secretRepair, secretsPath, setConfigKey, updateSecrets,
  writeFileAtomic, type Config, type ConfigIssue, type ConfigProblem, type Logger,
} from "@cohost/config";
import { LifecycleLock, StackController, configRefusal, isLoopback, type LockResult, type StackResult } from "@cohost/control";
import { BodyTooLarge, readBody, readText } from "./body.js";
import { fullSurfaceBind } from "./control.js";
import { guardFullSurface } from "./host.js";
import { controlTokenFromEnv, refuseSecretToken } from "./secrets.js";
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
  /** The file does not parse as YAML: it is fixed as text through the raw editor (`GET`/`POST /recovery/raw`). */
  raw?: true;
  actions: RecoveryActions;
}

/** The files recovery mode reads and writes. */
export interface RecoveryFiles { configFile: string; secretsFile: string }

/**
 * Whether the presentation table marks the key a path names `sensitive`: the key itself, or, for an entry `key[i]`, its list
 * (`dashboard.allowed_hosts[0]` is as sensitive as `dashboard.allowed_hosts`). Only the table's own entries count.
 */
const isSensitive = (path: string): boolean => {
  const key = resetPathOf(path);
  return Object.hasOwn(PRESENTATION.keys, key) && PRESENTATION.keys[key]!.sensitive === true;
};

/** The cap on a `POST /recovery/raw` body, which carries a whole file as text inside its JSON (DASH-HTTP-015). */
export const RAW_LIMIT = 1024 * 1024;

/** The files the raw editor edits, by the name its routes take. */
const RAW_FILES = { config: "config.yaml", secrets: "secrets.yaml" } as const;
type RawFile = keyof typeof RAW_FILES;
const isRawFile = (v: unknown): v is RawFile => v === "config" || v === "secrets";

/**
 * Whether `text`, read as the loader reads a file, gives no mapping at its root: a YAML syntax error, or a document that is
 * empty, a scalar or a list. No key of such a file can be named, so it is fixed as text.
 */
const noMapping = (text: string): boolean => {
  const parsed = parseConfigText(text);
  if (parsed.ok) return false;
  if (parsed.kind === "syntax") return true;
  if (parsed.kind !== "schema") return false;
  const root = parsed.raw;
  return root === null || root === undefined || typeof root !== "object" || Array.isArray(root);
};

/** The line and column a loader's syntax message names (`not valid YAML at line <l>, column <c>`). */
const positionOf = (message: string): { line?: number; col?: number } => {
  const m = /at line (\d+), column (\d+)/.exec(message);
  return m ? { line: Number(m[1]), col: Number(m[2]) } : {};
};

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
      const raw = p.path === "" && noMapping(secretsText);
      return { file: "secrets", path: p.path, message: p.message, kind: p.kind, secret: true, sensitive: false, ...(p.path ? { resetPath: p.path, repair } : {}), ...(raw ? { raw: true as const } : {}), actions: { ...none, reset: p.path !== "" } };
    }
    const base = { file: "config" as const, path: p.path, message: p.message, kind: p.kind };
    if (p.kind === "syntax" || (p.path === "" && noMapping(text))) return { ...base, secret: false, sensitive: false, raw: true, actions: none };
    if (p.path === "") return { ...base, secret: false, sensitive: false, actions: none };
    const resetPath = resetPathOf(p.path);
    const secret = secretPathOf(resetPath) !== undefined;
    const section = sectionOf(p.path);
    const held = resetConfigKey(text, p.path).ok;
    const fb = !secret && p.kind === "placeholder" ? placeholderFallback(text, p.path) : undefined;
    const fallbackOk = fb !== undefined && setConfigKey(text, p.path, fb.value).ok;
    return {
      ...base, secret, sensitive: isSensitive(p.path), ...(section ? { section } : {}),
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
export function recoveryAddress(text: string | undefined): { port: number; allowedHosts: string[]; fromFile: boolean } {
  const schema = ConfigSchema.shape.dashboard;
  const raw = text === undefined ? undefined : rawSection(text, "dashboard");
  const parsed = raw === undefined ? undefined : schema.safeParse(raw);
  const d = parsed?.success ? parsed.data : schema.parse({});
  return { port: d.port, allowedHosts: [...d.allowed_hosts], fromFile: parsed?.success === true };
}

export interface RecoveryHandlerDeps {
  log: Pick<Logger, "info" | "error">;
  files: RecoveryFiles;
  /** `CONTROL_ENABLED=1`: every recovery write needs the token, and the stack routes answer 409 instead of 404. */
  controlEnabled: boolean;
  /** `CONTROL_ADVANCED`, reported by `GET /services/control` as in normal mode. */
  advanced?: boolean;
  /** The control token whenever one is configured, in either control mode; it also keys the session cookies (DASH-UNL-005). */
  controlToken?: string;
  /**
   * The full surface is bound to a loopback address (CTRL-CONFIG-002): a `config.yaml` reset, a fallback and the `config.yaml`
   * part of reset-all then need no token in either control mode (DASH-RCV-003). Default false.
   */
  loopback?: boolean;
  /** The unlock link's nonces (DASH-UNL-002); a private set by default. */
  unlock?: UnlockLinks;
  /**
   * Replaces `config.yaml` atomically, with `mode` as the new file's permission bits when given; `writeFileAtomic` by default.
   * `secrets.yaml` is never written through it: `updateSecrets` and the raw editor write it with `writeFileAtomic` at mode 0600.
   */
  write?: (file: string, text: string, opts?: { mode?: number }) => void;
  /** The built UI; defaults to the one beside the server. */
  uiDir?: string;
  /** The port the recovery listener is bound to; a valid answer says `moved` when the normal dashboard will listen elsewhere. */
  boundPort?: number;
  /** Called once a response that found the files valid has been sent, or its client has gone. */
  onValid: () => void;
  /** The environment the Stop's Compose command runs with (`COHOST_DOCKER_BIN`, `COMPOSE_FILE`, ...); the process's by default. */
  env?: NodeJS.ProcessEnv;
  /** What the Stop runs: a `StackController`, which reads no configuration (control-plane CTRL-GATE-002); built per request by default. */
  stack?: Pick<StackController, "stopAll">;
  /** The control plane's lifecycle lock the Stop takes (DASH-STACK-009); the workspace's by default. */
  lock?: { tryAcquire(action: string): LockResult };
}

const json = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
};

const STACK_POST = /^\/stack\/[^/]+$/;
const LIFECYCLE = /^\/services\/[^/]+\/(start|stop|restart)$/;
const RECOVERY_POST = /^\/recovery\/(set|reset|reset-all|fallback|raw)$/;
/** The recovery writes that put no caller-chosen value in a file: ungated on a loopback bind (DASH-RCV-003). */
const NO_VALUE_OPS = new Set(["reset", "reset-all", "fallback"]);
const RECOVERY_DETAIL = "the dashboard is in config recovery mode: fix the config on its recovery screen first";

/**
 * The full surface in config recovery mode: the UI, `/health`, `GET /services/control`, the problem list, its three writes, the
 * raw editor of a file that does not parse and, with control on, the Stop; the other stack and lifecycle routes are refused,
 * everything else is a 503. The Host and Origin checks wrap it at the listener.
 */
// @spec DASH-RCV-003, DASH-RCV-004, DASH-RCV-005, DASH-RCV-006, DASH-RCV-007, DASH-RCV-009, DASH-RCV-010, DASH-RCV-012, DASH-RCV-015
// @spec DASH-RCV-011, DASH-RCV-016, DASH-RCV-017, DASH-RCV-018, DASH-RCV-019, DASH-RCV-022, DASH-RCV-023, DASH-CTRL-011
export function createRecoveryHandler(d: RecoveryHandlerDeps): http.RequestListener {
  const write = d.write ?? writeFileAtomic;
  const uiDir = d.uiDir ?? locateUiDir();
  const { configFile, secretsFile } = d.files;
  const links = d.unlock ?? new UnlockLinks();
  const check = (configText?: string): ConfigProblem[] => checkConfig({ configFile, secretsFile, ...(configText !== undefined ? { configText } : {}) });
  let left = false;
  let fired = false;
  /** Each running Stop, settled once its answer is sent or its client has gone; leaving recovery mode waits for them all. */
  const stops = new Set<Promise<void>>();
  /**
   * Leaves recovery mode once the answer is sent, or its client has gone, so a dropped page cannot strand the server; a Stop
   * still running is waited for first, so `docker compose stop` finishes and is answered before the listener closes.
   */
  const leave = (res: http.ServerResponse): void => {
    if (left) return;
    left = true;
    const go = (): void => {
      if (fired) return;
      fired = true;
      void (async () => {
        while (stops.size) await Promise.all(stops);
        d.log.info("config recovery: the config is valid; leaving config recovery mode");
        d.onValid();
      })();
    };
    res.once("finish", go);
    res.once("close", go);
  };
  const readSecrets = (): string => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } };
  /**
   * Where the normal dashboard listens once the file is valid, said only when it is not the recovery listener's port: then
   * `{moved: true, port}`, else nothing, and the page reloads where it is (which also holds behind a tunnel or a proxy).
   */
  const moved = (text: string): { moved?: true; port?: number } => {
    const port = recoveryAddress(text).port;
    return d.boundPort !== undefined && port !== d.boundPort ? { moved: true, port } : {};
  };

  /** Answers a write that has been carried out: the fresh problem list, and leaving recovery mode when it is empty. */
  const written = (res: http.ServerResponse, what: string, extra: Record<string, unknown> = {}): void => {
    const text = readFileSync(configFile, "utf8");
    const problems = check();
    d.log.info(`config recovery: ${what}`);
    if (problems.length) d.log.info(`config recovery: ${problems.length} problem${problems.length === 1 ? "" : "s"} remain${problems.length === 1 ? "s" : ""}`);
    else leave(res);
    const valid = problems.length === 0;
    json(res, 200, { ok: true, etag: etagOf(text), problems: recoveryProblems(problems, text, readSecrets()), valid, ...(valid ? moved(text) : {}), ...extra });
  };

  /** The refusal of a `secrets.yaml` change without the control token (DASH-SECRET-003): 403 when none is configured, else 401. */
  const refuseSecrets = (res: http.ServerResponse, paths: string[]): void => {
    if (d.controlToken === undefined) { json(res, 403, { ok: false, detail: `changing secrets.yaml (${paths.join(", ")}) needs the control token, and none is configured: set CONTROL_TOKEN in .env (CONTROL_ENABLED does not have to be 1) and restart the dashboard`, secrets: paths }); return; }
    json(res, 401, { ok: false, detail: `changing secrets.yaml (${paths.join(", ")}) needs the control token (Authorization: Bearer)`, secrets: paths }, { "www-authenticate": "Bearer" });
  };

  const refuse = (res: http.ServerResponse, issues: ConfigIssue[]): void => json(res, 400, { ok: false, issues });

  const rawPath = (file: RawFile): string => (file === "config" ? configFile : secretsFile);
  const readRaw = (file: RawFile): string => (file === "config" ? readFileSync(configFile, "utf8") : readSecrets());

  /** The problem that offers the raw editor for `file`, read fresh; undefined when the file parses as a mapping. */
  const rawProblem = (file: RawFile): RecoveryProblem | undefined =>
    recoveryProblems(check(), readFileSync(configFile, "utf8"), readSecrets()).find((p) => p.file === file && p.raw === true);

  /**
   * Whether the caller may read (`write` false) or replace `file` as text (DASH-RCV-018), answering the refusal when not:
   * `secrets.yaml` only with the token, in both control modes; `config.yaml` with the token whenever one is configured (a raw
   * write may change any key, and the text can hold a credential typed at a secret path), open only with control off and no token.
   */
  const rawAccess = (res: http.ServerResponse, file: RawFile, write: boolean, tokenOk: boolean): boolean => {
    if (tokenOk) return true;
    if (file === "secrets") {
      if (d.controlToken === undefined) {
        json(res, 403, { ok: false, detail: "secrets.yaml as text needs the control token, and none is configured: set CONTROL_TOKEN in .env (CONTROL_ENABLED does not have to be 1) and restart the dashboard" });
      } else {
        json(res, 401, { ok: false, detail: "secrets.yaml as text needs the control token (Authorization: Bearer)" }, { "www-authenticate": "Bearer" });
      }
      return false;
    }
    if (d.controlEnabled || d.controlToken !== undefined) {
      json(res, 401, { ok: false, detail: `${write ? "changing" : "reading"} config.yaml as text needs the control token (Authorization: Bearer)` }, { "www-authenticate": "Bearer" });
      return false;
    }
    return true;
  };

  /** `GET /recovery/raw?file=`: the whole text of a file that does not parse, with its etag and position (DASH-RCV-016). */
  const getRaw = (res: http.ServerResponse, url: URL, tokenOk: boolean): void => {
    const file = url.searchParams.get("file");
    if (!isRawFile(file)) { json(res, 400, { ok: false, detail: "file must be config or secrets" }); return; }
    if (!rawAccess(res, file, false, tokenOk)) return;
    const p = rawProblem(file);
    if (!p) { json(res, 409, { ok: false, detail: `${RAW_FILES[file]} parses as a mapping: fix it with the rows of the recovery screen` }); return; }
    const text = readRaw(file);
    json(res, 200, { ok: true, file, path: rawPath(file), text, etag: etagOf(text), message: p.message, ...positionOf(p.message) });
  };

  /**
   * `POST /recovery/raw`: replaces a file that does not parse with the text sent, when its etag is current (DASH-RCV-017). The
   * write follows a symbolic link, keeps `config.yaml`'s permission bits and writes `secrets.yaml` 0600. The text is never logged.
   */
  const postRaw = async (req: http.IncomingMessage, res: http.ServerResponse, tokenOk: boolean): Promise<void> => {
    const { data, tooLarge } = await readBody(req, RAW_LIMIT);
    if (tooLarge) throw new BodyTooLarge();
    let body: { file?: unknown; etag?: unknown; text?: unknown };
    try { body = JSON.parse(data.toString("utf8")) as typeof body; } catch { refuse(res, [{ path: "", message: "the body is not JSON" }]); return; }
    if (!isRawFile(body?.file) || typeof body.etag !== "string" || typeof body.text !== "string") {
      refuse(res, [{ path: "", message: "the body must be { file: \"config\" | \"secrets\", etag: string, text: string }" }]);
      return;
    }
    const file = body.file;
    if (!rawAccess(res, file, true, tokenOk)) return;
    // From here to the write nothing is awaited, so no other request can change the file in between.
    const current = etagOf(readRaw(file));
    if (body.etag !== current) { json(res, 409, { ok: false, etag: current }); return; }
    if (!rawProblem(file)) { json(res, 409, { ok: false, detail: `${RAW_FILES[file]} parses as a mapping: fix it with the rows of the recovery screen` }); return; }
    let target = rawPath(file);
    try { if (lstatSync(target).isSymbolicLink()) target = realpathSync(target); } catch { /* no such file: it is written where it is named */ }
    let mode = 0o600;
    if (file === "config") { try { mode = statSync(target).mode & 0o777; } catch { mode = 0o644; } }
    if (file === "config") write(target, body.text, { mode }); else writeFileAtomic(target, body.text, { mode });
    // The creation mode passes through the umask; the file keeps exactly the bits it had.
    if ((statSync(target).mode & 0o777) !== mode) chmodSync(target, mode);
    written(res, `raw edit ${RAW_FILES[file]}`, { rawEtag: etagOf(body.text) });
  };

  /**
   * `POST /stack/stop` with control on: `docker compose stop` through a `StackController`, which needs no configuration, under
   * the lifecycle lock, answered with its result since this mode has no feed to carry it (DASH-RCV-019).
   */
  const stop = async (res: http.ServerResponse): Promise<void> => {
    const answered = new Promise<void>((r) => { res.once("finish", r); res.once("close", r); });
    stops.add(answered);
    void answered.then(() => stops.delete(answered));
    const held = (d.lock ?? new LifecycleLock({ by: "dashboard" })).tryAcquire("stop");
    if (!held.ok) { json(res, 409, { ok: false, detail: held.detail }); return; }
    d.log.info("config recovery: stop");
    let r: StackResult;
    try {
      r = await (d.stack ?? new StackController({ env: d.env ?? process.env })).stopAll();
    } finally {
      held.release();
    }
    if (r.ok) { json(res, 200, { ok: true, action: "stop" }); return; }
    const detail = r.detail ?? "docker compose stop failed";
    d.log.error({ detail }, `config recovery: stop failed: ${detail}`);
    json(res, 502, { ok: false, detail });
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    if (handleUi(uiDir, "cohost", req, res, url)) return;
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
    if (method === "GET" && url.pathname === "/services/control") {
      const unlocked = hasSession(d.controlToken, req);
      json(res, 200, d.controlEnabled ? { enabled: true, runtime: "compose", advanced: !!d.advanced, unlocked } : { enabled: false, unlocked });
      return;
    }
    if (handleUnlock({ token: d.controlToken, links }, req, res, url)) return;
    // The Access dialog's token check (DASH-RCV-022): the secret route's token order, then "unknown secret" for every path. It
    // reads no body and no file and writes nothing; a secret is set on the Settings screen once the dashboard is back.
    if (method === "PUT" && url.pathname.startsWith("/secrets/")) {
      req.resume();
      if (refuseSecretToken(res, tokenRefusal({ required: true, token: d.controlToken }, req))) return;
      json(res, 404, { ok: false, detail: "unknown secret" });
      return;
    }
    if (method === "GET" && url.pathname === "/recovery") {
      const text = readFileSync(configFile, "utf8");
      const problems = check();
      if (problems.length === 0) { leave(res); json(res, 200, { active: false, ...moved(text) }); return; }
      json(res, 200, { active: true, file: configFile, secretsFile, etag: etagOf(text), problems: recoveryProblems(problems, text, readSecrets()) });
      return;
    }
    const tokenOk = d.controlToken !== undefined && authorized(d.controlToken, req);
    if (method === "GET" && url.pathname === "/recovery/raw") { getRaw(res, url, tokenOk); return; }
    if (method === "POST" && url.pathname === "/stack/stop" && d.controlEnabled) {
      req.resume();
      if (!tokenOk) { res.writeHead(401, { "www-authenticate": "Bearer" }); res.end("unauthorized"); return; }
      await stop(res);
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

    // With a token configured, whatever CONTROL_ENABLED says, every write needs it or a session cookie, except, on a loopback bind, the ones that write no caller-chosen value; a
    // reset of a secrets.yaml problem and the secrets.yaml part of reset-all are judged below in both modes (DASH-SECRET-003).
    if (d.controlToken !== undefined && !tokenOk && !(d.loopback && NO_VALUE_OPS.has(op))) { req.resume(); res.writeHead(401, { "www-authenticate": "Bearer" }); res.end("unauthorized"); return; }
    if (op === "raw") { await postRaw(req, res, tokenOk); return; }
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
      if (isSensitive(path) && !tokenOk) {
        const key = resetPathOf(path);
        const sensitive = [key];
        if (d.controlToken === undefined) { json(res, 403, { ok: false, detail: noTokenDetail(key), sensitive }); return; }
        json(res, 401, { ok: false, detail: `changing ${key} needs the control token (Authorization: Bearer)`, sensitive }, { "www-authenticate": "Bearer" });
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
    // @spec DASH-RCV-023
    if (op === "fallback") {
      const p = problems.find((x) => x.file === "config" && x.actions.fallback && x.path === path);
      if (!p) { refuse(res, [{ path, message: "no failing key at this path has a placeholder fallback to use" }]); return; }
      const edit = setConfigKey(text, p.path, p.fallback);
      if (!edit.ok) { refuse(res, edit.issues); return; }
      write(configFile, edit.text);
      written(res, `fallback ${p.path}`);
      return;
    }
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
      d.log.error({ err, path: pathOf(req) }, "config recovery: request failed"); // never the query string (DASH-UNL-002)
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
  /** Writes the unlock line to the terminal (DASH-UNL-001); standard output by default, never the logger. */
  print?: (line: string) => void;
}

/** The terminal alone: the unlock line goes to standard output and never through the logger, so never to its log file (DASH-UNL-001). */
export const printToTerminal = (line: string): void => { process.stdout.write(`${line}\n`); };

/**
 * Runs config recovery mode: one full-surface listener with the recovery routes, until a request finds the files valid. Resolves
 * true once the listener is closed and the files validate, false when the listener could not bind (the process exit was asked for).
 */
// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-003, DASH-RCV-011
export async function runRecovery(o: RecoveryOptions): Promise<boolean> {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const files = o.files ?? { configFile: ensureFromExample("config.yaml", "config.example.yaml"), secretsFile: secretsPath() };
  const { bind, cfg } = fullSurfaceBind(o.env);
  const controlToken = controlTokenFromEnv(o.env);
  const links = new UnlockLinks();
  let text: string | undefined;
  try { text = readFileSync(files.configFile, "utf8"); } catch { text = undefined; }
  const { port, allowedHosts, fromFile } = recoveryAddress(text);
  let resolveValid: () => void = () => {};
  const valid = new Promise<void>((r) => { resolveValid = r; });
  const handler = createRecoveryHandler({
    log: o.log, files, controlEnabled: cfg.enabled, advanced: cfg.enabled && cfg.advanced, controlToken, loopback: isLoopback(bind), unlock: links, boundPort: port, env: o.env,
    ...(o.uiDir ? { uiDir: o.uiDir } : {}), onValid: () => resolveValid(),
  });
  const server = http.createServer(guardFullSurface(handler, { loopback: isLoopback(bind), controlEnabled: cfg.enabled, allowedHosts }));
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // A broken dashboard section leaves nothing but the default port: say so, so the operator knows what to free or fix.
      const why = fromFile ? "" : `; the dashboard section of config.yaml could not be read, so the default port ${port} was used: free that port, or fix config.yaml by hand`;
      o.log.fatal({ err }, `dashboard cannot listen on ${bind}:${port} (config recovery): ${err.message}${why}`);
      resolve(false);
    });
    server.listen(port, bind, () => { server.removeAllListeners("error"); resolve(true); });
  });
  if (!listening) { exit(1); return false; }
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}:${addr.port}`;
  const n = o.error.problems.length;
  o.log.error({ url }, `config recovery mode: ${n} problem${n === 1 ? "" : "s"}; fix them at ${url}`);
  links.base = unlockBase(bind, addr.port);
  // @spec DASH-UNL-001
  if (controlToken !== undefined) (o.print ?? printToTerminal)(unlockLine(unlockBase(bind, addr.port), links.issue()));

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
