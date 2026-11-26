import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig } from "@cohost/config";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

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

/**
 * The owner's case: `mise run dashboard` (`node services/dashboard/dist/index.js` from the workspace root) against a config.yaml
 * from the `${VAR}` era. The dashboard starts in config recovery mode, serves the failing keys, "Reset all failing keys" makes
 * the file valid, and the same process becomes the normal dashboard.
 */
// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-007, DASH-RCV-011, DASH-HTTP-016
test("the built dashboard on a stale config.yaml serves recovery mode, reset-all fixes the file, and it comes up normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-rcv-"));
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config);
  const [port, lanPort] = [await freePort(), await freePort()];
  const stale = readFileSync(join(repo, "services", "dashboard", "test", "fixtures", "stale-config.yaml"), "utf8");
  const fixture = stale.replace(/^ {2}port: 3000$/m, `  port: ${port}\n  lan_port: ${lanPort}`);
  assert.notEqual(fixture, stale);
  assert.ok((fixture.match(/^[^#\n]*\$\{/gm) ?? []).length >= 30, "the fixture holds the placeholders of the old example");
  const configFile = join(config, "config.yaml");
  const secretsFile = join(root, "secrets.yaml");
  writeFileSync(configFile, fixture);

  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data, COHOST_ENV_FILE: join(root, ".env"), COHOST_SECRETS_FILE: secretsFile,
      REDIS_URL: "redis://127.0.0.1:1", COHOST_DOCKER_BIN: join(root, "no-docker"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  try {
    await until("the recovery line", async () => (/config recovery mode: \d+ problems; fix them at http:\/\/127\.0\.0\.1:\d+/.test(out) ? true : undefined));
    assert.match(out, /ERROR dashboard: Invalid .*config\.yaml:/, "the loader's error is logged first");

    const s = await (await fetch(`${base}/recovery`)).json() as { active: boolean; etag: string; problems: { path: string; kind: string }[] };
    assert.equal(s.active, true);
    assert.ok(s.problems.length >= 30, `${s.problems.length} problems`);
    assert.ok(s.problems.every((p) => p.kind === "placeholder"));
    assert.equal(readFileSync(configFile, "utf8"), fixture, "nothing is written without a save");
    assert.equal((await fetch(`${base}/stack`)).status, 503, "the normal routes are not up");

    const res = await fetch(`${base}/recovery/reset-all`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ etag: s.etag }) });
    assert.equal(res.status, 200);
    const body = await res.json() as { valid: boolean; problems: unknown[] };
    assert.equal(body.valid, true, JSON.stringify(body.problems));
    assert.deepEqual(checkConfig({ configFile, secretsFile }), []);
    const fixed = readFileSync(configFile, "utf8");
    assert.doesNotMatch(fixed.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n"), /\$\{[A-Z0-9_]+/, "no placeholder left in a value");
    assert.ok(fixed.includes("# Behavioural config"), "the operator's comments are kept");

    await until("normal mode", async () => {
      const r = await (await fetch(`${base}/recovery`)).json() as { active: boolean };
      return r.active ? undefined : true;
    });
    await until("the stack route", async () => ((await fetch(`${base}/stack`)).status === 200 ? true : undefined));
    assert.match(out, /leaving config recovery mode/);
    assert.match(out, /dashboard online: http:\/\/127\.0\.0\.1:\d+/);
    const logged = readFileSync(join(data, "logs", "dashboard.log"), "utf8");
    assert.match(logged, /config recovery: reset all/);
  } finally {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") child.kill("SIGKILL");
  }
});

/** Whether `port` on 127.0.0.1 can be bound right now. */
const portFree = (port: number): Promise<boolean> => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
});

/**
 * A config.yaml with a YAML syntax error, control enabled: the recovery screen's Stop runs `docker compose stop` through
 * `COHOST_DOCKER_BIN` (a script that records its argv) without a valid config, the raw editor reads and saves the file with the
 * token, and the same process comes up normally on the port the saved text names. A file that does not parse names no port,
 * so recovery listens on the default 3000; the case is skipped when that port is taken on this machine.
 */
// @spec DASH-RCV-016, DASH-RCV-017, DASH-RCV-019, DASH-RCV-011, CTRL-GATE-002
test("the built dashboard on a config.yaml syntax error stops the stack and is fixed through the raw editor", async (t) => {
  if (!(await portFree(3000))) { t.skip("port 3000, the recovery default for a file that does not parse, is in use"); return; }
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-raw-"));
  // A workspace root of its own, so the Stop's lifecycle lock (data/control.lock under the workspace root) is never the repo's.
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config);
  const [port, lanPort] = [await freePort(), await freePort()];
  const example = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const valid = example.replace(/^ {2}port: 3000 .*$/m, `  port: ${port}`).replace(/^ {2}lan_port: 3001 .*$/m, `  lan_port: ${lanPort}`);
  assert.notEqual(valid, example);
  const broken = valid.replace(/^ {2}name: "Coco"/m, "  name: [Coco");
  assert.notEqual(broken, valid);
  const configFile = join(config, "config.yaml");
  const secretsFile = join(root, "secrets.yaml");
  writeFileSync(configFile, broken);
  const calls = join(root, "docker-calls");
  const docker = join(root, "docker");
  writeFileSync(docker, `#!/bin/sh\necho "$@" >> '${calls}'\nif [ "$1 $2" = "compose ps" ]; then echo '[]'; fi\nexit 0\n`, { mode: 0o755 });

  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], {
    cwd: root, // the workspace root findWorkspaceRoot resolves: the lifecycle lock is taken in this temp root, never in the repo's data/
    env: {
      PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data, COHOST_ENV_FILE: join(root, ".env"), COHOST_SECRETS_FILE: secretsFile,
      REDIS_URL: "redis://127.0.0.1:1", COHOST_DOCKER_BIN: docker, CONTROL_ENABLED: "1", CONTROL_TOKEN: "tok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const base = "http://127.0.0.1:3000";
  const auth = { authorization: "Bearer tok" };
  try {
    await until("the recovery line", async () => (/config recovery mode: 1 problem; fix them at http:\/\/127\.0\.0\.1:3000/.test(out) ? true : undefined));
    const s = await (await fetch(`${base}/recovery`)).json() as { problems: { kind: string; raw?: boolean }[] };
    assert.deepEqual(s.problems.map((p) => [p.kind, p.raw]), [["syntax", true]]);

    assert.equal((await fetch(`${base}/stack/stop`, { method: "POST" })).status, 401);
    const stop = await fetch(`${base}/stack/stop`, { method: "POST", headers: auth });
    assert.equal(stop.status, 200);
    assert.deepEqual(await stop.json(), { ok: true, action: "stop" });
    assert.equal(readFileSync(calls, "utf8"), "compose stop\n");
    assert.equal(existsSync(join(root, "data", "control.lock")), false, "the lifecycle lock, taken in the temp workspace root, is released");

    assert.equal((await fetch(`${base}/recovery/raw?file=config`)).status, 401);
    const raw = await (await fetch(`${base}/recovery/raw?file=config`, { headers: auth })).json() as { text: string; etag: string; message: string; line: number };
    assert.equal(raw.text, broken);
    assert.match(raw.message, /^not valid YAML at line \d+, column \d+/);
    const saved = await fetch(`${base}/recovery/raw`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ file: "config", etag: raw.etag, text: valid }) });
    assert.equal(saved.status, 200);
    const body = await saved.json() as { valid: boolean; moved?: boolean; port?: number };
    assert.deepEqual([body.valid, body.moved, body.port], [true, true, port]);
    assert.equal(readFileSync(configFile, "utf8"), valid);
    assert.deepEqual(checkConfig({ configFile, secretsFile }), []);

    await until("the normal dashboard", async () => ((await fetch(`http://127.0.0.1:${port}/recovery`)).ok ? true : undefined));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/recovery`)).json(), { active: false });
    assert.match(out, /leaving config recovery mode/);
    const logged = readFileSync(join(data, "logs", "dashboard.log"), "utf8");
    assert.match(logged, /config recovery: stop/);
    assert.match(logged, /config recovery: raw edit config\.yaml/);
    assert.ok(!logged.includes("[Coco"), "the file's text is never logged");
  } finally {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") child.kill("SIGKILL");
  }
});

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
 * The owner's case of issue #366: the stale config.yaml with control on and a token. The dashboard prints an unlock link to its
 * terminal and never to its log file; the link unlocks the browser in recovery mode (the Access dialog's check passes with the
 * cookie), Reset all fixes config.yaml with no token, the normal dashboard prints a fresh link, `dashboard:unlock` mints another,
 * and a client with neither token nor cookie is refused.
 */
// @spec DASH-UNL-001, DASH-UNL-003, DASH-UNL-007, DASH-RCV-003, DASH-RCV-022, DASH-CTRL-011
test("the built dashboard prints an unlock link to the terminal only, and the link, Reset all and dashboard:unlock work without the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-unlock-"));
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config);
  const [port, lanPort] = [await freePort(), await freePort()];
  const stale = readFileSync(join(repo, "services", "dashboard", "test", "fixtures", "stale-config.yaml"), "utf8");
  const configFile = join(config, "config.yaml");
  writeFileSync(configFile, stale.replace(/^ {2}port: 3000$/m, `  port: ${port}\n  lan_port: ${lanPort}`));
  const env = {
    PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data, COHOST_ENV_FILE: join(root, ".env"), COHOST_SECRETS_FILE: join(root, "secrets.yaml"),
    REDIS_URL: "redis://127.0.0.1:1", COHOST_DOCKER_BIN: join(root, "no-docker"), CONTROL_ENABLED: "1", CONTROL_TOKEN: "tok",
  };
  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { out += c.toString(); });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const LINK = new RegExp(`Unlock this browser: http://127\\.0\\.0\\.1:${port}(/unlock\\?n=[A-Za-z0-9_-]{43})`, "g");
  const links = (): string[] => [...out.matchAll(LINK)].map((m) => m[1]!);
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
    const res = await raw(port, "POST", "/recovery/reset-all", {}, { etag: s.etag });
    assert.equal(res.status, 200, "Reset all needs no token on loopback");
    assert.equal((JSON.parse(res.text) as { valid: boolean }).valid, true);

    await until("the normal dashboard's unlock line", async () => (links().length >= 2 ? true : undefined));
    assert.equal((await raw(port, "PUT", "/secrets/x", {}, { value: "v" })).status, 401, "normal mode: no token, no cookie, refused");
    assert.equal((await raw(port, "PUT", "/secrets/access-check", { cookie, ...same }, { value: null })).status, 404, "the session holds across the switch to normal mode");

    const cli = spawnSync(process.execPath, [join(repo, "services", "dashboard", "dist", "unlock-link.js")], { cwd: repo, env, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    const fresh = /\/unlock\?n=[A-Za-z0-9_-]{43}/.exec(cli.stdout)?.[0];
    assert.ok(fresh, cli.stdout);
    assert.equal((await raw(port, "GET", fresh)).status, 303, "dashboard:unlock's link unlocks");

    const logged = readFileSync(join(data, "logs", "dashboard.log"), "utf8");
    for (const l of [...links(), fresh]) assert.ok(!logged.includes(l.split("n=")[1]!), "no nonce in the log file");
    assert.doesNotMatch(logged, /Unlock this browser/);
  } finally {
    child.kill("SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 15_000))]);
    if (code === "timeout") child.kill("SIGKILL");
  }
  const down = spawnSync(process.execPath, [join(repo, "services", "dashboard", "dist", "unlock-link.js")], { cwd: repo, env, encoding: "utf8" });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /not running/);
});
