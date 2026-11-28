import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { handleUnlock, hasSession, pass, pathOf, unlockBase, unlockLine, unlockUrl, UnlockLinks, type Gate } from "./access.js";
import { plainTerminal, processTerminal, type UnlockTerminal } from "./pinned-line.js";
import {
  ConfigSchema, PRESENTATION, canSetKey, dotEnvPath, findWorkspaceRoot, inputValue, loadDotEnv, resetPathOf, setLoggingSource, type Config, type ConfigIssue, type Logger,
} from "@cohost/config";
import {
  LifecycleLock, StackController, configRefusal, controlTokenRefusal, isLoopback, isLoopbackPeer, type LockResult, type StackResult,
} from "@cohost/control";
import {
  BearerChecker, StoreError, applyPersonalityOutbox, backupDir, checkStore, dailyBackup, importToStore, listBackups, openSecrets, openStore, peekStore,
  personalityUnits, readExport, restoreBackup, sectionOf, writeProjections, type NoticeOut, type Store, type StoreOptions, type StorePeek, type StoreProblem,
} from "@cohost/store";
import { BodyTooLarge, readBody } from "./body.js";
import { fullSurfaceBind } from "./control.js";
import { guardFullSurface } from "./host.js";
import { handleUi, locateUiDir } from "./static.js";

/** Why the settings store cannot be used, the first that applies in this order (settings-store STORE-RCV-001). */
export type RecoveryCause = "damaged-store" | "newer-store" | "missing-key" | "invalid-settings";
const CAUSE_OF: Record<StoreProblem["cause"], RecoveryCause> = { damaged: "damaged-store", newer: "newer-store", key: "missing-key", settings: "invalid-settings" };
/** The cause as the log line of DASH-RCV-001 names it. */
export const CAUSE_TEXT: Record<RecoveryCause, string> = { "damaged-store": "damaged store", "newer-store": "newer store", "missing-key": "missing key", "invalid-settings": "invalid settings" };

/** What the recovery screen offers for one problem. */
export interface RecoveryActions { set: boolean; reset: boolean }

/** One problem as `GET /recovery` serves it (DASH-RCV-004). */
export interface RecoveryProblem {
  path: string;
  message: string;
  /** The settings section that holds the key, with its title. */
  section?: { path: string; title: string };
  /** A key the presentation table marks `sensitive`. */
  sensitive: boolean;
  actions: RecoveryActions;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const getIn = (root: unknown, segs: readonly string[]): unknown => segs.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);

/**
 * Whether the presentation table marks the key a path names `sensitive`: the key itself, or, for an entry `key[i]`, its list
 * (`dashboard.allowed_hosts[0]` is as sensitive as `dashboard.allowed_hosts`). Only the table's own entries count.
 */
const isSensitive = (path: string): boolean => {
  const key = resetPathOf(path);
  return Object.hasOwn(PRESENTATION.keys, key) && PRESENTATION.keys[key]!.sensitive === true;
};

/** The cause of a problem list: the first problem's (they are all of one cause, STORE-RCV-001). */
export const causeOf = (problems: readonly StoreProblem[]): RecoveryCause | undefined => (problems[0] ? CAUSE_OF[problems[0].cause] : undefined);

/**
 * The problems as the recovery screen shows them (DASH-RCV-004). For invalid settings each names its key, its section, and
 * what can be done: `set` for a key `ConfigSchema` defines or a single-value list entry, `reset` when the stored settings
 * `tree` hold the key or list at the path before its first `[`. Every other cause is one problem with no path and no action,
 * whose message names the fix.
 */
// @spec DASH-RCV-004
export function recoveryProblems(problems: readonly StoreProblem[], tree: Record<string, unknown> | undefined): RecoveryProblem[] {
  return problems.map((p): RecoveryProblem => {
    const none: RecoveryActions = { set: false, reset: false };
    if (p.cause !== "settings") {
      const message = p.cause === "newer" ? `${p.message}. Nothing on this page changes the store: update cohost (git pull), then start the dashboard again.` : p.message;
      return { path: "", message, sensitive: false, actions: none };
    }
    // The store names a list entry by a numeric segment (`dashboard.allowed_hosts.0`); the screen and the writes name it `[0]`.
    const path = (p.path ?? "").replace(/\.(\d+)(?=\.|$)/g, "[$1]");
    const key = resetPathOf(path);
    const section = sectionOf(key);
    // A key that names nothing of the schema (`__proto__`, a removed key) is never a key to set, only to reset.
    const held = path !== "" && tree !== undefined && getIn(tree, key.split(".")) !== undefined;
    return {
      path, message: p.message, sensitive: isSensitive(path),
      ...(section ? { section: { path: section, title: PRESENTATION.sections[section]?.title ?? section } } : {}),
      actions: { set: path !== "" && canSetKey(path), reset: held },
    };
  });
}

/**
 * The recovery listener's port and allowed host names: the stored `dashboard` section when the store can be read and the
 * section validates against the `dashboard` schema, else the schema defaults.
 */
// @spec DASH-RCV-002
export function recoveryAddress(peek: StorePeek | undefined): { port: number; allowedHosts: string[]; fromStore: boolean } {
  const schema = ConfigSchema.shape.dashboard;
  const parsed = peek?.dashboard === undefined ? undefined : schema.safeParse(peek.dashboard);
  const d = parsed?.success ? parsed.data : schema.parse({});
  return { port: d.port, allowedHosts: [...d.allowed_hosts], fromStore: parsed?.success === true };
}

/** The host commands that fix a store whose verifier cannot be read (DASH-RCV-028), run as the owner's OS user. */
export const HOST_COMMANDS = "mise run config:restore -- <backup>, mise run config:import -- <export file>, or mise run config:key -- --restore";

export interface RecoveryHandlerDeps {
  log: Pick<Logger, "info" | "error">;
  /** Where the store and the key file are (tests point at temporary ones); the defaults otherwise. */
  store?: StoreOptions;
  /** `CONTROL_ADVANCED`, reported by `GET /services/control` as in normal mode. */
  advanced?: boolean;
  /** The unlock link's nonces (DASH-UNL-002); a private set by default. */
  unlock?: UnlockLinks;
  /** The built UI; defaults to the one beside the server. */
  uiDir?: string;
  /** The port the recovery listener is bound to; a valid answer says `moved` when the normal dashboard will listen elsewhere. */
  boundPort?: number;
  /** Called once a response that found the store usable has been sent, or its client has gone. */
  onValid: () => void;
  /** The environment the Stop's Compose command runs with (`COHOST_DOCKER_BIN`, `COMPOSE_FILE`, ...); the process's by default. */
  env?: NodeJS.ProcessEnv;
  /** What the Stop runs: a `StackController`, which reads no configuration (control-plane CTRL-GATE-002); built per request by default. */
  stack?: Pick<StackController, "stopAll">;
  /** The control plane's lifecycle lock the Stop takes (DASH-STACK-009); the workspace's by default. */
  lock?: { tryAcquire(action: string): LockResult };
  /** Where a recovery key made by discarding the credentials is shown: the terminal only (DASH-RCV-027). */
  notice?: NoticeOut;
}

const json = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
};

const STACK_POST = /^\/stack\/[^/]+$/;
const LIFECYCLE = /^\/services\/[^/]+\/(start|stop|restart)$/;
const RECOVERY_POST = /^\/recovery\/(set|reset|reset-all|restore|import|key|discard-credentials)$/;
const RECOVERY_DETAIL = "the dashboard is in config recovery mode: fix the settings store on its recovery screen first";
/** The cap on a `POST /recovery/import` body, which carries a whole export (DASH-HTTP-015). */
export const IMPORT_LIMIT = 1024 * 1024;
const BODY_LIMIT = 64 * 1024;
/** What `POST /recovery/discard-credentials` needs typed (DASH-RCV-027, settings-store STORE-KEY-009). */
export const DISCARD_CONFIRMATION = "delete credentials";

/** The terminal alone, for the recovery-key notice: standard output when it is a terminal, else the pointer on standard error. */
export const terminalNotice = (): NoticeOut => ({
  isTTY: process.stdout.isTTY,
  write: (t: string) => { process.stdout.write(t); },
  warn: (t: string) => { process.stderr.write(t); },
});

/**
 * The full surface in config recovery mode: the UI, `/health`, `GET /services/control`, the unlock routes, the problem list,
 * the recovery writes and, with the token, the Stop; the other stack and lifecycle routes are refused, everything else is a
 * 503. The Host and Origin checks wrap it at the listener.
 */
// @spec DASH-RCV-003, DASH-RCV-004, DASH-RCV-005, DASH-RCV-006, DASH-RCV-007, DASH-RCV-009, DASH-RCV-010, DASH-RCV-011, DASH-RCV-012
// @spec DASH-RCV-015, DASH-RCV-019, DASH-RCV-022, DASH-RCV-024, DASH-RCV-025, DASH-RCV-026, DASH-RCV-027, DASH-RCV-028, DASH-CTRL-011
// @spec STORE-TASK-006
export function createRecoveryHandler(d: RecoveryHandlerDeps): http.RequestListener {
  const uiDir = d.uiDir ?? locateUiDir();
  const links = d.unlock ?? new UnlockLinks();
  const opts: StoreOptions = { ...d.store, profile: "dashboard", seed: false, warn: () => undefined };
  let cause: RecoveryCause | undefined;
  /** The session key, read while the cause is invalid settings (the master key can be used then), else none (DASH-RCV-028). */
  let session: Buffer | undefined;
  const check = async (): Promise<StoreProblem[]> => {
    const problems = await checkStore(opts);
    cause = causeOf(problems);
    session = undefined;
    if (cause === "invalid-settings") { try { session = await withStore((s) => s.sessionKey()); } catch { session = undefined; } }
    return problems;
  };
  /** Opens the store for one operation with the key optional, so a missing key is not a failure to open. */
  const withStore = async <T>(fn: (s: Store) => T | Promise<T>): Promise<T> => {
    const s = await openStore({ ...opts, keyOptional: true });
    try { return await fn(s); } finally { s.close(); }
  };
  // The one lock (DASH-CTRL-011): a bearer checked against the verifier, read through a read-only connection whatever else is
  // wrong with the store; a session cookie only while the session key can be read.
  const checker = new BearerChecker(() => peekStore(opts)?.verifier);
  const gate: Gate = { verify: (t) => checker.check(t), sessionKey: () => session };
  const tree = async (): Promise<Record<string, unknown> | undefined> => {
    try { return await withStore((s) => s.settingsTree()); } catch { return undefined; }
  };

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
        d.log.info("config recovery: the settings store can be used; leaving config recovery mode");
        d.onValid();
      })();
    };
    res.once("finish", go);
    res.once("close", go);
  };
  /**
   * Where the normal dashboard listens once the store is usable, said only when it is not the recovery listener's port: then
   * `{moved: true, port}`, else nothing, and the page reloads where it is (which also holds behind a tunnel or a proxy).
   */
  const moved = (): { moved?: true; port?: number } => {
    const port = recoveryAddress(peekStore(opts)).port;
    return d.boundPort !== undefined && port !== d.boundPort ? { moved: true, port } : {};
  };
  const etag = (): string | undefined => {
    const r = peekStore(opts)?.revision;
    return r === undefined ? undefined : String(r);
  };

  /** Answers a write that has been carried out: the fresh problem list, and leaving recovery mode when it is empty. */
  const written = async (res: http.ServerResponse, what: string): Promise<void> => {
    const problems = await check();
    d.log.info(`config recovery: ${what}`);
    if (problems.length) d.log.info(`config recovery: ${problems.length} problem${problems.length === 1 ? "" : "s"} remain${problems.length === 1 ? "s" : ""}`);
    else leave(res);
    const valid = problems.length === 0;
    const e = etag();
    json(res, 200, { ok: true, ...(e !== undefined ? { etag: e } : {}), problems: recoveryProblems(problems, await tree()), valid, ...(valid ? moved() : {}) });
  };

  const refuse = (res: http.ServerResponse, issues: ConfigIssue[]): void => json(res, 400, { ok: false, issues });

  /**
   * `POST /stack/stop`: `docker compose stop` through a `StackController`, which needs no configuration, under the lifecycle
   * lock, answered with its result since this mode has no feed to carry it (DASH-RCV-019).
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

  /** A write's result from the store: 409 for a stale etag, 400 with the issues; true when it was carried out. */
  const settled = (res: http.ServerResponse, r: { ok: true } | { ok: false; conflict: true; revision: number } | { ok: false; conflict?: false; issues: ConfigIssue[] }): boolean => {
    if (r.ok) return true;
    if (r.conflict) json(res, 409, { ok: false, etag: String(r.revision) });
    else refuse(res, r.issues);
    return false;
  };

  /** The first check, run before the first request is answered: the unlock link printed at start needs the session key. */
  let first: Promise<unknown> | undefined;
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    await (first ??= check().catch(() => undefined));
    // A browser unlocked on an earlier run is unlocked already: the pinned line goes (DASH-UNL-012). This listener is the full surface.
    if (links.watched && hasSession(gate, req)) links.unlocked();
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    if (handleUi(uiDir, "cohost", req, res, url)) return;
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
    if (method === "GET" && url.pathname === "/services/control") {
      json(res, 200, { runtime: "compose", advanced: !!d.advanced, unlocked: hasSession(gate, req) });
      return;
    }
    if (await handleUnlock({ gate, links }, req, res, url)) return;
    // The Access dialog's token check (DASH-RCV-022): the gate, then "unknown secret" for every path. It reads no body and
    // writes nothing; a secret is set on the Settings screen once the dashboard is back.
    if (method === "PUT" && url.pathname.startsWith("/secrets/")) {
      if (!(await pass(gate, req, res, "json"))) return;
      req.resume();
      json(res, 404, { ok: false, detail: "unknown secret" });
      return;
    }
    if (method === "GET" && url.pathname === "/recovery") {
      const problems = await check();
      if (problems.length === 0) { leave(res); json(res, 200, { active: false, ...moved() }); return; }
      const peek = peekStore(opts);
      const e = etag();
      json(res, 200, {
        active: true, cause, ...(e !== undefined ? { etag: e } : {}), problems: recoveryProblems(problems, await tree()),
        backups: listBackups(opts.dataDir), gated: peek?.verifier !== undefined,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/stack/stop") {
      if (!(await pass(gate, req, res, "json"))) return;
      req.resume();
      await stop(res);
      return;
    }
    if (method === "POST" && (STACK_POST.test(url.pathname) || LIFECYCLE.test(url.pathname))) {
      req.resume();
      json(res, 409, { ok: false, detail: (await configRefusal(() => checkStore(opts))) ?? RECOVERY_DETAIL });
      return;
    }
    const op = method === "POST" ? RECOVERY_POST.exec(url.pathname)?.[1] : undefined;
    if (!op) { req.resume(); json(res, 503, { ok: false, detail: RECOVERY_DETAIL }); return; }

    // A store whose verifier cannot be read (or holds none) is fixed on the host, as the owner's OS user (DASH-RCV-028).
    if (peekStore(opts)?.verifier === undefined) {
      req.resume();
      json(res, 409, { ok: false, detail: `the settings store's token verifier cannot be read, so the dashboard cannot check the control token: fix it on the host with ${HOST_COMMANDS}` });
      return;
    }
    // Every recovery write passes the one gate, whatever address the full surface is bound to: no write is exempt (DASH-RCV-003).
    if (!(await pass(gate, req, res, "json"))) return;
    const { data, tooLarge } = await readBody(req, op === "import" ? IMPORT_LIMIT : BODY_LIMIT);
    if (tooLarge) throw new BodyTooLarge();
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data.toString("utf8")) as unknown;
      if (!isObj(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      refuse(res, [{ path: "", message: "the body is not a JSON object" }]);
      return;
    }
    const problems = await check();
    if (problems.length === 0) { json(res, 409, { ok: false, detail: "the settings store can be used: reload the page" }); return; }
    const wrongCause = (want: RecoveryCause[]): boolean => {
      if (want.includes(cause!)) return false;
      json(res, 409, { ok: false, detail: `this action does not apply while the cause is ${CAUSE_TEXT[cause!]}` });
      return true;
    };

    if (op === "set" || op === "reset" || op === "reset-all") {
      if (wrongCause(["invalid-settings"])) return;
      if (typeof body.etag !== "string" || (op !== "reset-all" && typeof body.path !== "string")) {
        refuse(res, [{ path: "", message: op === "reset-all" ? "the body must be { etag: string }" : "the body must be { etag: string, path: string, ... }" }]);
        return;
      }
      const expectedRevision = /^\d+$/.test(body.etag) ? Number(body.etag) : -1;
      const current = etag();
      if (body.etag !== current) { json(res, 409, { ok: false, etag: current }); return; }
      const shown = recoveryProblems(problems, await tree());
      const path = body.path as string;
      if (op === "set") {
        if (!canSetKey(path)) { refuse(res, [{ path, message: "this key cannot be set on its own: reset it, or set its keys one at a time" }]); return; }
        const value = typeof body.value === "string" ? inputValue(path, body.value) : body.value;
        const entry = /^(.+)\[(\d+)\]$/.exec(path);
        const r = await withStore((s) => {
          if (!entry) return s.setKey(path, value, { expectedRevision });
          const list = getIn(s.settingsTree(), entry[1]!.split("."));
          if (!Array.isArray(list)) return { ok: false as const, issues: [{ path, message: "the store holds no list here: reset it or set the whole list" }] };
          const next = structuredClone(list) as unknown[];
          next[Number(entry[2])] = value;
          return s.setKey(entry[1]!, next, { expectedRevision });
        });
        if (settled(res, r)) await written(res, `set ${path}`);
        return;
      }
      if (op === "reset") {
        const p = shown.find((x) => x.actions.reset && (x.path === path || resetPathOf(x.path) === path));
        if (!p) { refuse(res, [{ path, message: "no failing key at this path can be reset" }]); return; }
        const key = resetPathOf(p.path);
        const r = await withStore((s) => s.resetKey(key, { expectedRevision }));
        if (settled(res, r)) await written(res, `reset ${key}`);
        return;
      }
      const keys = [...new Set(shown.filter((x) => x.actions.reset).map((x) => resetPathOf(x.path)))];
      const outer = keys.filter((k) => !keys.some((o) => o !== k && k.startsWith(`${o}.`)));
      const r = await withStore((s) => s.resetKeys(outer, { expectedRevision }));
      if (settled(res, r)) await written(res, `reset all (${outer.length} key${outer.length === 1 ? "" : "s"})`);
      return;
    }

    if (op === "restore" || op === "import") {
      if (wrongCause(["damaged-store", "missing-key", "invalid-settings"])) return;
      if (op === "restore") {
        const name = body.backup;
        if (typeof name !== "string" || !listBackups(opts.dataDir).some((b) => b.name === name)) { json(res, 404, { ok: false, detail: "no listed backup has that name" }); return; }
        try {
          await restoreBackup(join(backupDir(opts.dataDir), name), opts);
        } catch (e) {
          if (!(e instanceof StoreError)) throw e;
          json(res, 400, { ok: false, detail: e.message });
          return;
        }
        await written(res, `restored ${name}`);
        return;
      }
      if (typeof body.text !== "string" || (body.passphrase !== undefined && typeof body.passphrase !== "string")) {
        refuse(res, [{ path: "", message: "the body must be { text: string, passphrase?: string }" }]);
        return;
      }
      const { plan, issues } = readExport(body.text);
      if (issues.length === 0 && plan.sealed) {
        if (typeof body.passphrase !== "string" || body.passphrase === "") { refuse(res, [{ path: "secrets", message: "the export holds credentials: give its passphrase" }]); return; }
        const opened = openSecrets(plan.sealed, body.passphrase);
        issues.push(...opened.issues);
        plan.secrets = opened.values;
      }
      if (issues.length > 0) { refuse(res, issues); return; }
      let result;
      try {
        ({ result } = await importToStore(plan, opts));
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        json(res, 400, { ok: false, issues: e.issues.length ? e.issues : [{ path: "", message: e.message }] });
        return;
      }
      if (!result.ok) { refuse(res, result.conflict ? [{ path: "", message: "the store changed during the import; try again" }] : result.issues); return; }
      await written(res, "imported");
      return;
    }

    if (wrongCause(["missing-key"])) return;
    if (op === "key") {
      // The recovery key is the whole root of trust: it is accepted from this machine only, whatever the Host header says.
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        json(res, 403, { ok: false, detail: "the recovery key is accepted only from this machine: restore it on the host with mise run config:key -- --restore" });
        return;
      }
      if (typeof body.recoveryKey !== "string") { refuse(res, [{ path: "recoveryKey", message: "the body must be { recoveryKey: string }" }]); return; }
      const key = body.recoveryKey;
      try {
        await withStore((s) => s.restoreKey(key));
      } catch (e) {
        if (!(e instanceof StoreError)) throw e;
        json(res, 400, { ok: false, detail: e.message });
        return;
      }
      await written(res, "key restored");
      return;
    }
    if (body.confirm !== DISCARD_CONFIRMATION) { json(res, 400, { ok: false, detail: `type "${DISCARD_CONFIRMATION}" to confirm` }); return; }
    await withStore((s) => s.resetCredentials(d.notice ?? terminalNotice()));
    await written(res, "credentials discarded");
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
  log: Pick<Logger, "info" | "warn" | "error" | "fatal">;
  /** The problems that started recovery mode (`checkStore()`). */
  problems: readonly StoreProblem[];
  store?: StoreOptions;
  exit?: (code: number) => void;
  uiDir?: string;
  /** Install SIGINT and SIGTERM handlers that close the listener and exit 0 (default true). */
  signals?: boolean;
  /** Writes the unlock line to the terminal (DASH-UNL-001); standard output by default, never the logger. */
  print?: (line: string) => void;
  /** Where the unlock line is shown and pinned (DASH-UNL-009); this process's terminal by default, `print` when that is given. */
  terminal?: UnlockTerminal;
  /** Set by `--open`: hands the start link to the browser opener, `warn` logging its failure (DASH-UNL-014, DASH-UNL-015). */
  open?: (url: string, warn: (msg: string) => void) => void;
  notice?: NoticeOut;
}

/** How long before its nonce's 10 minutes end the pinned link is renewed, so the link shown always has time left. */
export const RENEW_EARLY_MS = 30_000;

/**
 * Writes the unlock line at start (DASH-UNL-001), in normal mode and in config recovery mode: to the terminal, which pins it and
 * renews it when its nonce is due by the wall clock or was dropped by the cap (DASH-UNL-009, DASH-UNL-011), releases it on the
 * first unlock (DASH-UNL-012) and, with `--open`, hands the same link to the opener, which opens the first line of the process
 * only (DASH-UNL-014). Called once the listener is bound.
 */
// @spec DASH-UNL-001, DASH-UNL-009, DASH-UNL-011, DASH-UNL-012, DASH-UNL-014
export function showUnlockLine(o: { base: string; links: UnlockLinks; terminal: UnlockTerminal; open?: ((url: string, warn: (msg: string) => void) => void) | undefined; warn: (msg: string) => void }): void {
  const first = o.links.issue();
  let nonce = first;
  const renewal = {
    next: (): string => { nonce = o.links.issue(); return unlockLine(o.base, nonce); },
    stale: (): boolean => { const until = o.links.expiresAt(nonce); return until === undefined || o.links.now() >= until - RENEW_EARLY_MS; },
  };
  o.terminal.show(unlockLine(o.base, first), renewal);
  if (o.terminal.pinned) {
    o.links.watch(() => { o.terminal.release(); });
    o.links.afterIssue(() => { o.terminal.check(); });
  }
  o.open?.(unlockUrl(o.base, first), o.warn);
}

/**
 * Runs config recovery mode: one full-surface listener with the recovery routes, until a request finds the store usable.
 * Resolves true once the listener is closed and the store can be used, false when the listener could not bind (the process
 * exit was asked for).
 */
// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-003, DASH-RCV-011, DASH-UNL-001
export async function runRecovery(o: RecoveryOptions): Promise<boolean> {
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const { bind, cfg } = fullSurfaceBind(o.env);
  const links = new UnlockLinks();
  const { port, allowedHosts, fromStore } = recoveryAddress(peekStore(o.store ?? {}));
  let resolveValid: () => void = () => {};
  const valid = new Promise<void>((r) => { resolveValid = r; });
  const handler = createRecoveryHandler({
    log: o.log, ...(o.store ? { store: o.store } : {}), advanced: cfg.advanced, unlock: links, boundPort: port, env: o.env,
    ...(o.uiDir ? { uiDir: o.uiDir } : {}), ...(o.notice ? { notice: o.notice } : {}), onValid: () => resolveValid(),
  });
  const server = http.createServer(guardFullSurface(handler, { loopback: isLoopback(bind), allowedHosts }));
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      // A stored dashboard section that cannot be used leaves nothing but the default port: say so, so the owner knows what to free.
      const why = fromStore ? "" : `; the stored dashboard section could not be used, so the default port ${port} was used: free that port`;
      o.log.fatal({ err }, `dashboard cannot listen on ${bind}:${port} (config recovery): ${err.message}${why}`);
      resolve(false);
    });
    server.listen(port, bind, () => { server.removeAllListeners("error"); resolve(true); });
  });
  if (!listening) { exit(1); return false; }
  const addr = server.address() as AddressInfo;
  const url = `http://${addr.family === "IPv6" ? `[${addr.address}]` : addr.address}:${addr.port}`;
  const n = o.problems.length;
  const cause = causeOf(o.problems)!;
  o.log.error({ url }, `config recovery mode: ${CAUSE_TEXT[cause]}, ${n} problem${n === 1 ? "" : "s"}; fix them at ${url}`);
  const base = unlockBase(bind, addr.port);
  links.base = base;
  // Only while the session key can be read is a link any use (DASH-UNL-001, DASH-RCV-028).
  let terminal: UnlockTerminal | undefined;
  if (cause === "invalid-settings") {
    terminal = o.terminal ?? (o.print ? plainTerminal(o.print) : processTerminal());
    showUnlockLine({ base, links, terminal, open: o.open, warn: (m) => o.log.warn(m) });
  }

  const stop = (): void => { server.close(); server.closeAllConnections(); exit(0); };
  if (o.signals !== false) { process.once("SIGINT", stop); process.once("SIGTERM", stop); }
  await valid;
  if (o.signals !== false) { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
  await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  // Its link died with the listener: the pinned line goes before normal mode writes its own (DASH-UNL-012).
  terminal?.release(); // @spec DASH-UNL-012
  return true;
}

export interface StartOptions {
  env?: NodeJS.ProcessEnv;
  /** Creates the logger, once the store's `logging` section is registered as the logging source (STORE-PKG-003). */
  makeLog: () => Pick<Logger, "info" | "warn" | "error" | "fatal">;
  exit?: (code: number) => void;
  /** Where the store, its key and its seed are (tests); the defaults otherwise. */
  store?: StoreOptions;
  /** The workspace root projections are written under; the one found from the working directory by default. */
  root?: string;
  /** The `.env` file checked for `CONTROL_TOKEN`; `dotEnvPath()` by default. */
  envFile?: string;
  /** Recovery mode's options for tests (its UI directory, its signal handlers, its terminal). */
  recovery?: Pick<RecoveryOptions, "uiDir" | "signals" | "print" | "terminal" | "notice">;
  /** Set by `--open`: hands recovery mode's unlock link to the browser opener (DASH-UNL-014). */
  open?: RecoveryOptions["open"];
  /** Starts normal operation with the open store and the configuration it assembles (DASH-HTTP-016). */
  run: (store: Store, cfg: Config) => Promise<void>;
}

/**
 * The dashboard's start (DASH-HTTP-016): checks the store; opens it and registers its `logging` section as the logging source
 * before the first log line (STORE-PKG-003); refuses a `CONTROL_TOKEN` in `.env` or the environment and a store with no token
 * verifier, binding nothing (DASH-CTRL-002); while `checkStore()` finds problems, runs config recovery mode (DASH-RCV-001); then
 * applies the reflection outbox (STORE-OUT-002), takes the day's first backup (STORE-DB-008) and starts normal operation with
 * the assembled configuration in this process. A failure that is not the store's is left to the caller, which exits.
 */
// @spec DASH-HTTP-016, DASH-RCV-001, DASH-RCV-011, DASH-CTRL-002, DASH-RCV-002, STORE-PKG-003, STORE-TOK-005, STORE-OUT-002, STORE-DB-008
// @spec STORE-DB-003, STORE-DB-010
export async function startDashboard(o: StartOptions): Promise<void> {
  const env = o.env ?? process.env;
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const storeOpts: StoreOptions = { ...o.store, profile: "dashboard" };
  let problems = await checkStore(storeOpts);
  let store: Store | undefined;
  if (problems.length === 0) store = await openStore(storeOpts);
  // The logging source is the store's own section, read lazily; while the store cannot be used the defaults apply.
  setLoggingSource(() => (store ? store.sections().logging : undefined));
  const log = o.makeLog();
  const fail = (message: string): void => { log.fatal(`the dashboard cannot start: ${message}`); store?.close(); exit(1); };

  if (env === process.env) loadDotEnv();
  const refusal = controlTokenRefusal(env, o.envFile ?? dotEnvPath());
  if (refusal) { fail(`${refusal}; delete the line once the token is in your password manager`); return; }
  const noVerifier = "the settings store holds no control token: run mise run config:token (or mise run config:token -- --stdin with your own) and keep the token in your password manager";
  if (store && !store.hasVerifier()) { fail(noVerifier); return; }

  while (problems.length > 0) {
    for (const p of problems) log.error(`${p.cause}: ${p.path ? `${p.path}: ` : ""}${p.message}`);
    const peek = peekStore(storeOpts);
    if (peek !== undefined && peek.verifier === undefined) { fail(noVerifier); return; }
    let ok: boolean;
    try {
      ok = await runRecovery({ env, log, problems, store: storeOpts, ...(o.exit ? { exit: o.exit } : {}), ...(o.open ? { open: o.open } : {}), ...o.recovery });
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      exit(1);
      return;
    }
    if (!ok) return;
    problems = await checkStore(storeOpts);
  }
  store ??= await openStore(storeOpts);
  // A recovery import into a new store, or a restore of a backup taken before the token was set, can leave no verifier.
  if (!store.hasVerifier()) { fail(noVerifier); return; }

  const root = o.root ?? findWorkspaceRoot() ?? process.cwd();
  const outbox = applyPersonalityOutbox(store, store.dataDir);
  if (outbox.applied) {
    log.info("applied the reflection pass's personality block");
    try { writeProjections(store, root, personalityUnits()); } catch (err) { log.warn({ err }, "the personality projections could not be rewritten"); }
  } else if (outbox.reason !== "none") log.warn(outbox.message);
  try { await dailyBackup(store); } catch (err) { log.warn({ err }, "the day's backup of the settings store could not be taken"); }
  await o.run(store, store.config());
}
