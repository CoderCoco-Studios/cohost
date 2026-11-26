import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

/**
 * The owner's case behind the logging design: `mise run dashboard` (`node services/dashboard/dist/index.js` from the workspace
 * root) with an invalid config.yaml. The loader's error is printed as readable, indented lines on the terminal and kept as a
 * JSON entry in data/logs/dashboard.log, and the process ends with status 1.
 */
// @spec CFG-LOG-005, CFG-LOG-006, CFG-LOG-012, CFG-LOG-013, SHARED-BOOT-002
test("an invalid config.yaml under the dashboard prints as indented terminal lines and lands in data/logs/dashboard.log", () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-dash-log-"));
  const config = join(root, "config");
  const data = join(root, "data");
  mkdirSync(config);
  const example = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const invalid = example.replace(/^ {2}name: "Coco"/m, '  name: ""').replace(/^ {2}port: 3000 /m, "  port: 3001 ");
  assert.notEqual(invalid, example);
  writeFileSync(join(config, "config.yaml"), invalid);

  const r = spawnSync(process.execPath, [join(repo, "services", "dashboard", "dist", "index.js")], {
    cwd: repo, encoding: "utf8", timeout: 60_000,
    env: {
      PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data,
      COHOST_ENV_FILE: join(root, ".env"), COHOST_SECRETS_FILE: join(root, "secrets.yaml"), REDIS_URL: "redis://127.0.0.1:1",
    },
  });
  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const out = r.stdout.split("\n");
  const head = out.findIndex((l) => /^\d\d:\d\d:\d\d\.\d{3} ERROR dashboard: Invalid .*config\.yaml:$/.test(l));
  assert.ok(head >= 0, `no readable error line in:\n${r.stdout}`);
  const issues = out.slice(head + 1).filter((l) => l.startsWith("      "));
  assert.ok(issues.some((l) => /^ {6}cohost\.name: /.test(l)), `cohost.name issue six spaces in:\n${r.stdout}`);
  assert.ok(issues.some((l) => /^ {6}dashboard\.lan_port: must differ/.test(l)), `lan_port issue six spaces in:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /\\n|"msg"/, "no JSON on the terminal");
  assert.doesNotMatch(r.stdout, /\u001b/, "no colour on a pipe");

  const entries = readFileSync(join(data, "logs", "dashboard.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const error = entries.find((e) => e.level === 50);
  assert.ok(error, "the error is in the file");
  assert.equal(error.name, "dashboard");
  assert.match(String(error.msg), /^Invalid .*config\.yaml:\n {2}cohost\.name: [^\n]+\n {2}dashboard\.lan_port: must differ/);
});
