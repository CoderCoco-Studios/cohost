import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@cohost/config";
import { runRecovery, startDashboard } from "../src/recovery.js";
import { EXAMPLE } from "./config-fixture.js";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

/** A config directory whose config.yaml fails at `cohost.name` and whose dashboard section listens on `port`. */
function files(port: number): { dir: string; configFile: string; secretsFile: string; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "cohost-rcvl-"));
  const text = EXAMPLE.replace(/^ {2}name: "Coco"/m, '  name: "${NAME}"').replace(/^ {2}port: 3000 /m, `  port: ${port} `);
  writeFileSync(join(dir, "config.yaml"), text);
  return { dir, configFile: join(dir, "config.yaml"), secretsFile: join(dir, "secrets.yaml"), text };
}

const logger = () => {
  const lines: string[] = [];
  const at = (level: string) => (...a: unknown[]) => { lines.push(`${level} ${a.map((x) => (typeof x === "string" ? x : "")).join(" ").trim()}`); };
  return { lines, log: { info: at("info"), error: at("error"), fatal: at("fatal") } };
};

/** One raw request, so the Host header can be anything. */
const request = (port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers: o.headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(o.body);
  });

// @spec DASH-RCV-002, DASH-RCV-003
test("the recovery listener applies the Host and Origin rules: a foreign Host is a 403, a foreign Origin on a write is a 403 and writes nothing", async () => {
  const port = await freePort();
  const f = files(port);
  const { log, lines } = logger();
  const exits: number[] = [];
  const running = runRecovery({ env: {}, log, error: new ConfigError("Invalid", [{ file: f.configFile, path: "cohost.name", message: "x", kind: "placeholder" }]), files: f, exit: (c) => exits.push(c), signals: false, uiDir: join(f.dir, "ui") });
  try {
    for (let i = 0; i < 50 && !lines.some((l) => l.startsWith("error config recovery mode:")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.some((l) => l === `error config recovery mode: 1 problem; fix them at http://127.0.0.1:${port}`), lines.join("\n"));
    assert.equal(await request(port, { path: "/recovery", headers: { host: `127.0.0.1:${port}` } }), 200);
    assert.equal(await request(port, { path: "/recovery", headers: { host: "evil.example" } }), 403);
    const etag = ((await (await fetch(`http://127.0.0.1:${port}/recovery`)).json()) as { etag: string }).etag;
    const body = JSON.stringify({ etag });
    assert.equal(await request(port, { method: "POST", path: "/recovery/reset-all", body, headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "content-type": "application/json" } }), 403);
    assert.equal(readFileSync(f.configFile, "utf8"), f.text, "a refused write writes nothing");
    assert.deepEqual(exits, []);
  } finally {
    writeFileSync(f.configFile, EXAMPLE.replace(/^ {2}port: 3000 /m, `  port: ${port} `));
    await fetch(`http://127.0.0.1:${port}/recovery`);
    assert.equal(await running, true);
  }
});

// @spec DASH-RCV-002
test("a recovery port that is taken is logged at fatal and exits 1", async () => {
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  const port = (busy.address() as net.AddressInfo).port;
  try {
    const f = files(port);
    const { log, lines } = logger();
    const exits: number[] = [];
    const ok = await runRecovery({ env: {}, log, error: new ConfigError("Invalid", []), files: f, exit: (c) => exits.push(c), signals: false });
    assert.equal(ok, false);
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => l.startsWith(`fatal dashboard cannot listen on 127.0.0.1:${port} (config recovery)`)), lines.join("\n"));
  } finally { busy.close(); }
});

// @spec DASH-RCV-002, DASH-HOST-007
test("DASHBOARD_HOST beyond loopback with control off stops the start with exit 1 naming DASHBOARD_HOST", async () => {
  const f = files(await freePort());
  const keep = { c: process.env.CONFIG_DIR, s: process.env.COHOST_SECRETS_FILE, e: process.env.COHOST_ENV_FILE };
  process.env.CONFIG_DIR = f.dir;
  process.env.COHOST_SECRETS_FILE = f.secretsFile;
  process.env.COHOST_ENV_FILE = join(f.dir, "none.env");
  const { log, lines } = logger();
  const exits: number[] = [];
  let ran = false;
  try {
    await startDashboard({ env: { DASHBOARD_HOST: "0.0.0.0" }, log, exit: (c) => exits.push(c), run: async () => { ran = true; } });
  } finally {
    for (const [k, v] of [["CONFIG_DIR", keep.c], ["COHOST_SECRETS_FILE", keep.s], ["COHOST_ENV_FILE", keep.e]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.deepEqual(exits, [1]);
  assert.equal(ran, false);
  assert.ok(lines.some((l) => l.startsWith("error DASHBOARD_HOST is 0.0.0.0")), lines.join("\n"));
});
