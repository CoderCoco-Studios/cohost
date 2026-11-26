import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
