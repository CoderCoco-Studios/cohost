import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

/**
 * The owner's case behind the logging design: `mise run dashboard` (`node services/dashboard/dist/index.js` from the workspace
 * root) with an invalid config.yaml. The loader's error is printed as readable, indented lines on the terminal and kept as a
 * JSON entry in data/logs/dashboard.log, before the dashboard goes on into config recovery mode.
 */
// @spec CFG-LOG-005, CFG-LOG-006, CFG-LOG-012, CFG-LOG-013, DASH-RCV-001
test("an invalid config.yaml under the dashboard prints as indented terminal lines and lands in data/logs/dashboard.log", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-log-"));
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config);
  const [port, lanPort] = [await freePort(), await freePort()];
  const example = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const invalid = example
    .replace(/^ {2}name: "Coco"/m, '  name: ""')
    .replace(/^ {2}working_memory_own_lines: 4 /m, "  working_memory_own_lines: 30 ")
    .replace(/^ {2}port: 3000 /m, `  port: ${port} `)
    .replace(/^ {2}lan_port: 3001 /m, `  lan_port: ${lanPort} `);
  assert.notEqual(invalid, example);
  writeFileSync(join(config, "config.yaml"), invalid);

  const child = spawn(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data,
      COHOST_ENV_FILE: join(root, ".env"), COHOST_SECRETS_FILE: join(root, "secrets.yaml"), REDIS_URL: "redis://127.0.0.1:1",
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
  const head = out.findIndex((l) => /^\d\d:\d\d:\d\d\.\d{3} ERROR dashboard: Invalid .*config\.yaml:$/.test(l));
  assert.ok(head >= 0, `no readable error line in:\n${stdout}`);
  const issues = out.slice(head + 1).filter((l) => l.startsWith("      "));
  assert.ok(issues.some((l) => /^ {6}cohost\.name: /.test(l)), `cohost.name issue six spaces in:\n${stdout}`);
  assert.ok(issues.some((l) => /^ {6}brain\.working_memory_own_lines: must be less/.test(l)), `own_lines issue six spaces in:\n${stdout}`);
  assert.doesNotMatch(stdout, /\\n|"msg"/, "no JSON on the terminal");
  assert.doesNotMatch(stdout, /\u001b/, "no colour on a pipe");

  const entries = readFileSync(join(data, "logs", "dashboard.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const error = entries.find((e) => e.level === 50);
  assert.ok(error, "the error is in the file");
  assert.equal(error.name, "dashboard");
  assert.match(String(error.msg), /^Invalid .*config\.yaml:\n {2}cohost\.name: [^\n]+\n {2}brain\.working_memory_own_lines: must be less/);
});
