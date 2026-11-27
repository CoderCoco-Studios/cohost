import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokenStore, repo } from "./store-fixture.js";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

/**
 * The owner's case behind the logging design: `mise run dashboard` (`node services/dashboard/dist/index.js` from the workspace
 * root) over a settings store whose settings fail the schema. Each problem is printed as a readable terminal line and kept as a
 * JSON entry in data/logs/dashboard.log, before the dashboard goes on into config recovery mode.
 */
// @spec CFG-LOG-005, CFG-LOG-012, CFG-LOG-013, DASH-RCV-001
test("a store with invalid settings under the dashboard prints its problems as terminal lines and lands them in data/logs/dashboard.log", { timeout: 60_000 }, async () => {
  const [port, lanPort] = [await freePort(), await freePort()];
  const st = await brokenStore("invalid-settings", { edits: { dashboard: { port, lan_port: lanPort } } });
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-log-"));
  const data = st.opts.dataDir!;
  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, COHOST_DATA_DIR: data, COHOST_KEY_FILE: st.opts.keyFile, CONFIG_DIR: join(root, "config"),
      COHOST_ENV_FILE: join(root, ".env"), REDIS_URL: "redis://127.0.0.1:1",
    },
  });
  let stdout = "";
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    const end = Date.now() + 30_000;
    while (!/config recovery mode: /.test(stdout)) {
      if (Date.now() > end) assert.fail(`no recovery line in:\n${stdout}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
  }

  const out = stdout.split("\n");
  assert.ok(out.some((l) => /^\d\d:\d\d:\d\d\.\d{3} ERROR dashboard: settings: llm\.temperature: /.test(l)), `no readable problem line in:\n${stdout}`);
  assert.ok(out.some((l) => /^\d\d:\d\d:\d\d\.\d{3} ERROR dashboard: config recovery mode: invalid settings, 2 problems; fix them at http:\/\/127\.0\.0\.1:\d+\b/.test(l)), stdout);
  assert.doesNotMatch(stdout, /\\n|"msg"/, "no JSON on the terminal");
  assert.doesNotMatch(stdout, /\u001b/, "no colour on a pipe");

  const entries = readFileSync(join(data, "logs", "dashboard.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const errors = entries.filter((e) => e.level === 50);
  assert.ok(errors.some((e) => String(e.msg).startsWith('settings: llm.temperature: ')), "the problem is in the file");
  assert.ok(errors.every((e) => e.name === "dashboard"));
  assert.ok(errors.some((e) => String(e.msg).startsWith('config recovery mode: invalid settings, 2 problems')));
});
