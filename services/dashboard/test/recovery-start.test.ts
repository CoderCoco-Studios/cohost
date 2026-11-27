import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http, { request } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePersonalityOutbox, sha256Hex } from "@cohost/config";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, backupDir, checkStore, importToStore, listBackups, openStore, personalityUnits, projectionDir, projectionsDir, readExport, storeFile, type Store, type StoreOptions } from "@cohost/store";
import { runRecovery, startDashboard } from "../src/recovery.js";
import { freshUnlockLink } from "../src/unlock-link.js";
import { AUTH, TOKEN } from "./control-fixture.js";
import { brokenStore, dbState, repo, testStore, type BrokenCause } from "./store-fixture.js";

/** A port nothing listens on right now. */
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v !== undefined) return v; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

/** A raw request, so `Cookie` and `Origin` go out as a browser sends them. */
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/**
 * The built dashboard (`node services/dashboard/dist/index.js`, as `mise run dashboard` starts it) over a store of its own
 * that `cause` broke, on a free port pair stored in its `dashboard` section; `before` runs on the store while it is usable.
 */
async function built(cause: BrokenCause, o: { before?: (s: Store) => unknown; cwd?: string; docker?: string } = {}) {
  const [port, lanPort] = [await freePort(), await freePort()];
  const st = await brokenStore(cause, { edits: { dashboard: { port, lan_port: lanPort } }, ...(o.before ? { before: o.before } : {}) });
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-built-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, COHOST_DATA_DIR: st.opts.dataDir, COHOST_KEY_FILE: st.opts.keyFile, CONFIG_DIR: join(root, "config"),
    COHOST_ENV_FILE: join(root, ".env"), REDIS_URL: "redis://127.0.0.1:1", COHOST_DOCKER_BIN: o.docker ?? join(root, "no-docker"),
  };
  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], { cwd: o.cwd ?? repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const stop = async (): Promise<void> => {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") child.kill("SIGKILL");
  };
  return { st, port, root, env, out: () => out, exited, stop, base: `http://127.0.0.1:${port}` };
}

/**
 * The owner's case: `mise run dashboard` against a store whose settings a newer build refuses. The dashboard starts in config
 * recovery mode, serves the failing keys, "Reset all failing keys" makes the store usable, and the same process becomes the
 * normal dashboard.
 */
// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-007, DASH-RCV-011, DASH-HTTP-016
test("the built dashboard on invalid settings serves recovery mode, reset-all fixes the store, and it comes up normally", { timeout: 90_000 }, async () => {
  const d = await built("invalid-settings");
  try {
    await until("the recovery line", async () => (/config recovery mode: invalid settings, 2 problems; fix them at http:\/\/127\.0\.0\.1:\d+/.test(d.out()) ? true : undefined));
    assert.match(d.out(), /settings: llm\.temperature: /, "the problems are logged first");
    const before = dbState(d.st.opts.dataDir!);
    const s = await (await fetch(`${d.base}/recovery`)).json() as { active: boolean; cause: string; etag: string; problems: { path: string }[] };
    assert.equal(s.active, true);
    assert.equal(s.cause, "invalid-settings");
    assert.deepEqual(s.problems.map((p) => p.path).toSorted(), ["llm.retired_key", "llm.temperature"]);
    assert.equal(dbState(d.st.opts.dataDir!), before, "nothing is written without a save");
    assert.equal((await fetch(`${d.base}/stack`)).status, 503, "the normal routes are not up");

    const res = await fetch(`${d.base}/recovery/reset-all`, { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: JSON.stringify({ etag: s.etag }) });
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; problems: unknown[] };
    assert.equal(body.valid, true, JSON.stringify(body.problems));
    assert.deepEqual(await checkStore(d.st.opts), []);

    await until("normal mode", async () => {
      const r = await (await fetch(`${d.base}/recovery`)).json() as { active: boolean };
      return r.active ? undefined : true;
    });
    await until("the stack route", async () => ((await fetch(`${d.base}/stack`)).status === 200 ? true : undefined));
    assert.match(d.out(), /leaving config recovery mode/);
    assert.match(d.out(), /dashboard online: http:\/\/127\.0\.0\.1:\d+/);
    const logged = readFileSync(join(d.st.opts.dataDir!, "logs", "dashboard.log"), "utf8");
    assert.match(logged, /config recovery: reset all/);
  } finally { await d.stop(); }
});

/**
 * A missing master key: the screen's Stop runs `docker compose stop` through `COHOST_DOCKER_BIN` (a script that records its
 * argv) with no usable store, no unlock link is printed (no session key can be read), the recovery key restores the key file
 * and the same process comes up normally.
 */
// @spec DASH-RCV-019, DASH-RCV-026, DASH-RCV-028, DASH-RCV-011, DASH-UNL-001, CTRL-GATE-002
test("the built dashboard with a missing key prints no link, stops the stack, and is fixed with the recovery key", { timeout: 90_000 }, async () => {
  const ws = mkdtempSync(join(tmpdir(), "cohost-dash-ws-"));
  // A workspace root of its own, so the Stop's lifecycle lock (data/control.lock under the workspace root) is never the repo's.
  writeFileSync(join(ws, "pnpm-workspace.yaml"), "packages: []\n");
  const calls = join(ws, "docker-calls");
  const docker = join(ws, "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$1 $2" = "compose ps" ]; then echo '[]'; fi\nexit 0\n`, { mode: 0o755 });
  let recoveryKey = "";
  const d = await built("missing-key", { cwd: ws, docker, before: (s) => { recoveryKey = s.recoveryKey(); } });
  try {
    await until("the recovery line", async () => (/config recovery mode: missing key, 1 problem; fix them at http:\/\/127\.0\.0\.1:\d+/.test(d.out()) ? true : undefined));
    assert.doesNotMatch(d.out(), /Unlock this browser/, "no link: the session key cannot be read");
    assert.equal((await fetch(`${d.base}/stack/stop`, { method: "POST" })).status, 401);
    const stop = await fetch(`${d.base}/stack/stop`, { method: "POST", headers: AUTH });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { ok: true, action: "stop" });
    assert.equal(readFileSync(calls, "utf8"), "compose stop\n");
    assert.equal(existsSync(join(ws, "data", "control.lock")), false, "the lifecycle lock, taken in the temp workspace root, is released");

    const fixed = await fetch(`${d.base}/recovery/key`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ recoveryKey }) });
    assert.equal(fixed.status, 200, await fixed.clone().text());
    assert.equal(((await fixed.json()) as { valid: boolean }).valid, true);
    await until("the normal dashboard", async () => (/dashboard online:/.test(d.out()) ? true : undefined));
    assert.equal(((await (await fetch(`${d.base}/recovery`)).json()) as { active: boolean }).active, false);
    const logged = readFileSync(join(d.st.opts.dataDir!, "logs", "dashboard.log"), "utf8");
    assert.match(logged, /config recovery: stop/);
    assert.match(logged, /config recovery: key restored/);
    assert.ok(!logged.includes(recoveryKey.split(":")[1]!), "the key is never logged");
  } finally { await d.stop(); }
});

/**
 * Invalid settings with the token set: the dashboard prints an unlock link to its terminal and never to its log file; the link
 * unlocks the browser in recovery mode (the Access dialog's check passes with the cookie), Reset all is done with the cookie,
 * the normal dashboard prints a fresh link, `dashboard:unlock` mints another with the token from its own environment, and a
 * client with neither token nor cookie is refused.
 */
// @spec DASH-UNL-001, DASH-UNL-003, DASH-UNL-005, DASH-UNL-007, DASH-RCV-003, DASH-RCV-022, DASH-CTRL-011
test("the built dashboard prints an unlock link to the terminal only; Reset all is refused without the token or a cookie and done with the cookie; dashboard:unlock works", { timeout: 90_000 }, async () => {
  const d = await built("invalid-settings");
  const port = d.port;
  const LINK = new RegExp(`Unlock this browser: http://127\\.0\\.0\\.1:${port}(/unlock\\?n=[A-Za-z0-9_-]{43})`, "g");
  const links = (): string[] => [...d.out().matchAll(LINK)].map((m) => m[1]!);
  const same = { origin: `http://127.0.0.1:${port}` };
  try {
    await until("the recovery unlock line", async () => (links().length >= 1 ? true : undefined));
    const first = links()[0]!;
    const opened = await raw(port, "GET", first);
    assert.equal(opened.status, 303);
    const cookie = String((opened.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    assert.equal((await raw(port, "GET", first)).status, 400, "single use");
    assert.equal((await raw(port, "PUT", "/secrets/access-check", { cookie, ...same }, { value: null })).status, 404, "the Access dialog's check passes with the cookie");
    assert.equal((await raw(port, "PUT", "/secrets/access-check", {}, { value: null })).status, 401, "a client with neither token nor cookie is refused");

    const s = JSON.parse((await raw(port, "GET", "/recovery")).text) as { etag: string };
    assert.equal((await raw(port, "POST", "/recovery/reset-all", {}, { etag: s.etag })).status, 401, "no write is exempt, on loopback either");
    const res = await raw(port, "POST", "/recovery/reset-all", { cookie, ...same }, { etag: s.etag });
    assert.equal(res.status, 200, "the unlocked browser repairs");
    assert.equal((JSON.parse(res.text) as { valid: boolean }).valid, true);

    await until("the normal dashboard's unlock line", async () => (links().length >= 2 ? true : undefined));
    assert.equal((await raw(port, "PUT", "/secrets/x", {}, { value: "v" })).status, 401, "normal mode: no token, no cookie, refused");
    assert.equal((await raw(port, "PUT", "/secrets/access-check", { cookie, ...same }, { value: null })).status, 404, "the session holds across the switch to normal mode");

    const cli = spawnSync(process.execPath, [join(repo, "services", "dashboard", "dist", "unlock-link.js")], { cwd: repo, env: { ...d.env, CONTROL_TOKEN: TOKEN }, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const fresh = /\/unlock\?n=[A-Za-z0-9_-]{43}/.exec(cli.stdout)?.[0];
    assert.ok(fresh, cli.stdout);
    assert.equal((await raw(port, "GET", fresh)).status, 303, "dashboard:unlock's link unlocks");

    const logged = readFileSync(join(d.st.opts.dataDir!, "logs", "dashboard.log"), "utf8");
    for (const l of [...links(), fresh]) assert.ok(!logged.includes(l.split("n=")[1]!), "no nonce in the log file");
    assert.doesNotMatch(logged, /Unlock this browser/);
    assert.ok(!logged.includes(TOKEN), "the token is never logged");
  } finally { await d.stop(); }
  const down = spawnSync(process.execPath, [join(repo, "services", "dashboard", "dist", "unlock-link.js")], { cwd: repo, env: { ...d.env, CONTROL_TOKEN: TOKEN }, encoding: "utf8" });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /not running/);
});

// ---- startDashboard in this process

const quietLog = () => {
  const lines: string[] = [];
  const at = (level: string) => (...a: unknown[]) => { lines.push(`${level} ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`); };
  return { lines, log: { info: at("info"), warn: at("warn"), error: at("error"), fatal: at("fatal") } };
};

/** startDashboard over `opts` with its own env, `.env` and root; records exits, runs and log lines. */
async function start(opts: { dataDir?: string; keyFile?: string; seedDir?: string }, o: { env?: NodeJS.ProcessEnv; dotEnv?: string; root?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-dash-start-"));
  const envFile = join(dir, ".env");
  if (o.dotEnv !== undefined) writeFileSync(envFile, o.dotEnv);
  const { lines, log } = quietLog();
  const exits: number[] = [];
  const runs: { revision: number; name: string }[] = [];
  await startDashboard({
    makeLog: () => log, env: o.env ?? {}, envFile, exit: (c) => { exits.push(c); }, store: { ...opts, notice: { isTTY: false, write: () => undefined, warn: () => undefined }, warn: () => undefined },
    root: o.root ?? join(dir, "root"),
    recovery: { signals: false, print: () => {}, uiDir: join(dir, "ui") },
    run: async (store, cfg) => { runs.push({ revision: store.revision(), name: cfg.cohost.name }); store.close(); },
  });
  return { lines, exits, runs };
}

// @spec DASH-HTTP-016, STORE-DB-010
test("startDashboard hands the open store and the configuration it assembles to run", async () => {
  const st = await testStore();
  st.close();
  const r = await start(st.opts);
  assert.deepEqual(r.exits, []);
  assert.equal(r.runs.length, 1);
  assert.equal(typeof r.runs[0]!.name, "string");
});

// @spec DASH-CTRL-002
test("startDashboard refuses CONTROL_TOKEN in .env naming .env and the line, never the value: fatal, exit 1, no run, no listener", async () => {
  const port = await freePort();
  const st = await testStore({ edits: { dashboard: { port } } });
  st.close();
  const value = "s3cret-token-in-dot-env-0123456789abcdef";
  const r = await start(st.opts, { dotEnv: `# mine\nREDIS_URL=redis://x\nCONTROL_TOKEN=${value}\n` });
  assert.deepEqual(r.exits, [1]);
  assert.deepEqual(r.runs, []);
  const fatal = r.lines.find((l) => l.startsWith("fatal "));
  assert.ok(fatal, r.lines.join("\n"));
  assert.match(fatal, /\.env defines CONTROL_TOKEN on line 3/);
  assert.match(fatal, /mise run config:token/);
  assert.ok(!r.lines.some((l) => l.includes(value)), "the value is never logged");
  assert.ok(await new Promise<boolean>((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => s.close(() => resolve(true))); }), "nothing listens");
  const empty = await start(st.opts, { dotEnv: "CONTROL_TOKEN=\n" });
  assert.deepEqual(empty.exits, [], "an empty CONTROL_TOKEN line defines nothing");
});

// @spec DASH-CTRL-002
test("startDashboard refuses CONTROL_TOKEN in its environment, and a store that holds no token verifier, exiting 1 with no run", async () => {
  const st = await testStore();
  st.close();
  const inEnv = await start(st.opts, { env: { CONTROL_TOKEN: "s3cret-token-in-the-env-0123456789abcdef" } });
  assert.deepEqual(inEnv.exits, [1]);
  assert.deepEqual(inEnv.runs, []);
  assert.ok(inEnv.lines.some((l) => /^fatal .*the environment defines CONTROL_TOKEN/.test(l)), inEnv.lines.join("\n"));
  assert.ok(!inEnv.lines.some((l) => l.includes("s3cret-token-in-the-env")));

  const none = await testStore({ token: false });
  none.close();
  const noVerifier = await start(none.opts);
  assert.deepEqual(noVerifier.exits, [1]);
  assert.deepEqual(noVerifier.runs, []);
  assert.ok(noVerifier.lines.some((l) => /^fatal .*holds no control token: run mise run config:token/.test(l)), noVerifier.lines.join("\n"));

  const brokenNone = await brokenStore("invalid-settings", { token: false });
  const inRecovery = await start(brokenNone.opts);
  assert.deepEqual(inRecovery.exits, [1], "a broken store with no verifier is refused before recovery mode binds");
  assert.ok(inRecovery.lines.some((l) => /^fatal .*holds no control token/.test(l)), inRecovery.lines.join("\n"));
});

/** startDashboard over `opts`, not awaited: recovery mode keeps it running until a request finds the store usable. */
function startLive(opts: StoreOptions) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-dash-live-"));
  const { lines, log } = quietLog();
  const exits: number[] = [];
  const runs: number[] = [];
  const done = startDashboard({
    makeLog: () => log, env: {}, envFile: join(dir, ".env"), exit: (c) => { exits.push(c); },
    store: { ...opts, notice: { isTTY: false, write: () => undefined, warn: () => undefined }, warn: () => undefined },
    root: join(dir, "root"), recovery: { signals: false, print: () => {}, uiDir: join(dir, "ui") },
    run: async (store) => { runs.push(store.revision()); store.close(); },
  });
  return { lines, exits, runs, done };
}

// @spec DASH-CTRL-002, STORE-TOK-005
test("a store left with no verifier by recovery (an import into a damaged store on the host, a restore of a backup from before the token) is refused at start", async () => {
  // An import on the host over a store damaged while recovery mode runs makes a new store, which holds no verifier. (A store
  // damaged at start binds the default port, which a test must not take; the damage here comes after the listener is up.)
  const port = await freePort();
  const damaged = await brokenStore("invalid-settings", { edits: { dashboard: { port } } });
  const a = startLive(damaged.opts);
  await until("the recovery listener", async () => ((await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : undefined), 10_000);
  writeFileSync(storeFile(damaged.opts.dataDir!), "broken ".repeat(1000));
  const exported = `cohost_export: 1\nsettings:\n${readFileSync(join(repo, "config", "config.example.yaml"), "utf8").split("\n").map((l) => (l ? `  ${l}` : l)).join("\n")}\n`;
  const { plan, issues } = readExport(exported);
  assert.deepEqual(issues, []);
  const imported = await importToStore(plan, { ...damaged.opts, notice: { isTTY: false, write: () => undefined, warn: () => undefined }, warn: () => undefined });
  assert.ok(imported.result.ok && imported.moved, JSON.stringify(imported.result));
  assert.deepEqual(JSON.parse((await raw(port, "GET", "/recovery")).text).active, false);
  await a.done;
  assert.deepEqual(a.exits, [1]);
  assert.deepEqual(a.runs, []);
  assert.ok(a.lines.some((l) => /^fatal .*holds no control token: run mise run config:token/.test(l)), a.lines.join("\n"));

  // A restore through the recovery page of a backup taken before the token was set.
  const port2 = await freePort();
  let preToken = "";
  const st = await brokenStore("invalid-settings", {
    edits: { dashboard: { port: port2 } }, token: false,
    before: async (s) => { preToken = await s.backup(); s.setToken(TOKEN); },
  });
  const b = startLive(st.opts);
  await until("the invalid-settings listener", async () => ((await fetch(`http://127.0.0.1:${port2}/health`)).ok ? true : undefined), 10_000);
  const name = preToken.split("/").at(-1)!;
  const restored = await raw(port2, "POST", "/recovery/restore", AUTH, { backup: name });
  assert.equal(restored.status, 200, restored.text);
  await b.done;
  assert.deepEqual(b.exits, [1]);
  assert.deepEqual(b.runs, []);
  assert.ok(b.lines.some((l) => /^fatal .*holds no control token/.test(l)), b.lines.join("\n"));
});

// @spec STORE-OUT-002, STORE-PROJ-006
test("startDashboard applies a reflection outbox present at start and rewrites the personality projections before run", async () => {
  const st = await testStore();
  const current = st.store.personality() ?? "";
  st.close();
  writePersonalityOutbox(current, `${current}\n## Learned\n- likes tea\n`, st.opts.dataDir!);
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-proj-"));
  const r = await start(st.opts, { root });
  assert.deepEqual(r.exits, []);
  assert.equal(r.runs.length, 1);
  assert.ok(r.lines.includes("info applied the reflection pass's personality block"), r.lines.join("\n"));
  const s = await openStore({ ...st.opts });
  try { assert.match(s.personality() ?? "", /likes tea/); } finally { s.close(); }
  assert.equal(readdirSync(join(st.opts.dataDir!, "memory")).some((f) => f.includes("outbox")), false, "the outbox is gone");
  const units = personalityUnits();
  assert.deepEqual(readdirSync(projectionsDir(root)).toSorted(), units.map((u) => u.composeName).toSorted());
  for (const u of units) assert.match(readFileSync(join(projectionDir(root, u.composeName), "settings.json"), "utf8"), /likes tea/, u.id);
  assert.notEqual(sha256Hex(current), sha256Hex(`${current}\n## Learned\n- likes tea\n`));
});

// @spec STORE-DB-008
test("the day's first start takes a backup of the store; a second start the same day takes none", async () => {
  const st = await testStore();
  st.close();
  assert.deepEqual(listBackups(st.opts.dataDir!), []);
  await start(st.opts);
  const first = listBackups(st.opts.dataDir!);
  assert.equal(first.length, 1);
  assert.ok(first[0]!.time.startsWith(new Date().toISOString().slice(0, 10)), first[0]!.time);
  await start(st.opts);
  assert.deepEqual(listBackups(st.opts.dataDir!), first);
  assert.ok(existsSync(join(backupDir(st.opts.dataDir!), first[0]!.name)));
});

// @spec DASH-UNL-001, DASH-RCV-028
test("recovery mode prints the unlock link only while the session key can be read: with invalid settings, not with a newer store or a missing key", async () => {
  for (const [cause, printed] of [["invalid-settings", 1], ["newer-store", 0], ["missing-key", 0]] as const) {
    const port = await freePort();
    let keyText = "";
    const st = await brokenStore(cause, { edits: { dashboard: { port } }, before: (s) => { keyText = s.recoveryKey(); } });
    const lines: string[] = [];
    const { log } = quietLog();
    let exited: number | undefined;
    const running = runRecovery({ env: {}, log, problems: await checkStore(st.opts), store: st.opts, signals: false, print: (l) => lines.push(l), exit: (c) => { exited = c; }, uiDir: join(st.root, "ui") });
    await until(`the ${cause} listener`, async () => ((await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : undefined), 10_000);
    assert.equal(lines.length, printed, cause);
    assert.equal(exited, undefined);
    // Leave recovery mode: an answer that finds the store usable, each cause fixed as the owner would.
    if (cause === "invalid-settings") {
      const s = JSON.parse((await raw(port, "GET", "/recovery")).text) as { etag: string };
      assert.equal((await raw(port, "POST", "/recovery/reset-all", AUTH, { etag: s.etag })).status, 200);
    } else {
      if (cause === "newer-store") {
        const db = new DatabaseSync(storeFile(st.opts.dataDir!));
        db.exec(`UPDATE meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema_version'`);
        db.close();
      } else writeFileSync(st.opts.keyFile!, `${keyText}\n`, { mode: 0o600 });
      assert.deepEqual(JSON.parse((await raw(port, "GET", "/recovery")).text), { active: false });
    }
    assert.equal(await running, true);
  }
});

// @spec DASH-UNL-007, STORE-TOK-005
test("freshUnlockLink takes the token from its own environment, else asks for it, and the port from the stored dashboard section", async () => {
  const port = await freePort();
  const st = await testStore({ edits: { dashboard: { port } } });
  st.close();
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    const ok = req.method === "POST" && req.url === "/unlock/link" && req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true, url: `http://127.0.0.1:${port}/unlock?n=abc` } : { ok: false, detail: "unauthorized" }));
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  try {
    const store = { dataDir: st.opts.dataDir! };
    assert.deepEqual(await freshUnlockLink({ env: { CONTROL_TOKEN: ` ${TOKEN} ` }, store, askToken: () => { throw new Error("not asked"); } }), { ok: true, url: `http://127.0.0.1:${port}/unlock?n=abc` });
    assert.deepEqual(await freshUnlockLink({ env: {}, store, askToken: async () => TOKEN }), { ok: true, url: `http://127.0.0.1:${port}/unlock?n=abc` }, "asked on the terminal");
    const none = await freshUnlockLink({ env: {}, store, askToken: () => undefined });
    assert.equal(none.ok, false);
    assert.match((none as { why: string }).why, /no control token given/);
    const empty = await freshUnlockLink({ env: {}, store, askToken: async () => "  " });
    assert.deepEqual(empty, { ok: false, why: "no control token given" });
    const wrong = await freshUnlockLink({ env: { CONTROL_TOKEN: "not-the-token-0123456789abcdef-0123" }, store });
    assert.equal(wrong.ok, false);
    assert.match((wrong as { why: string }).why, /refused the control token/);
    assert.ok(!(wrong as { why: string }).why.includes("not-the-token"), "the token is never repeated");
    assert.ok(seen.every((h) => h?.startsWith("Bearer ")));
  } finally { server.close(); }
  const down = await freshUnlockLink({ env: { CONTROL_TOKEN: TOKEN }, store: { dataDir: st.opts.dataDir! } });
  assert.equal(down.ok, false);
  assert.match((down as { why: string }).why, /not running/);
});
