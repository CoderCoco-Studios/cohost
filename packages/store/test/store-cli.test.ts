import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseYaml } from "@cohost/config";
import { checkStore, storeFile } from "../src/index.js";
import { RESET_CONFIRMATION, runCli } from "../src/cli/run.js";
import { fakeIo, repo, sandbox } from "./helpers.js";

const TOKEN = "an-owner-chosen-control-token-long-enough";

// @spec STORE-TASK-002
test("config:get prints the effective value as YAML, marking a default, and set or not set for a credential", async () => {
  const sb = sandbox();
  let io = fakeIo();
  assert.equal(await runCli(["get", "cohost.timezone"], io, sb.opts), 0);
  assert.match(io.stdout, /^(# default\n)?\S+\n$/);
  io = fakeIo();
  assert.equal(await runCli(["get", "llm.temperature"], io, sb.opts), 0);
  assert.equal(io.stdout, "0.9\n", "the seed sets it");
  assert.equal(await runCli(["reset", "llm.temperature"], fakeIo(), sb.opts), 0);
  io = fakeIo();
  assert.equal(await runCli(["get", "llm.temperature"], io, sb.opts), 0);
  assert.equal(io.stdout, "# default\n0.9\n");
  io = fakeIo();
  assert.equal(await runCli(["get", "llm.openai.api_key"], io, sb.opts), 0);
  assert.equal(io.stdout, "not set\n");
  io = fakeIo();
  assert.equal(await runCli(["get", "nope.key"], io, sb.opts), 1);
});

// @spec STORE-TASK-002
test("config:set reads the value as YAML and validates; config:reset brings the default back; a credential path is refused", async () => {
  const sb = sandbox();
  let io = fakeIo();
  assert.equal(await runCli(["set", "llm.temperature", "1.2"], io, sb.opts), 0);
  assert.equal(io.stdout, "saved llm.temperature; salience, affect, memory, cortex, eyes apply it at their next start\n", "the units whose manifest declares the llm section");
  io = fakeIo();
  assert.equal(await runCli(["set", "dashboard.port", "8788"], io, sb.opts), 0);
  assert.equal(io.stdout, "saved dashboard.port; no unit declares the dashboard section; the dashboard reads it\n");
  io = fakeIo();
  await runCli(["get", "llm.temperature"], io, sb.opts);
  assert.equal(io.stdout, "1.2\n");
  io = fakeIo();
  assert.equal(await runCli(["set", "llm.temperature", "7"], io, sb.opts), 1);
  assert.match(io.stderr, /llm\.temperature: /);
  io = fakeIo();
  assert.equal(await runCli(["set", "llm.openai.api_key", "sk-x"], io, sb.opts), 1);
  assert.match(io.stderr, /config:secret/);
  io = fakeIo();
  assert.equal(await runCli(["reset", "llm.temperature"], io, sb.opts), 0);
  io = fakeIo();
  await runCli(["get", "llm.temperature"], io, sb.opts);
  assert.equal(io.stdout, "# default\n0.9\n");
});

// @spec STORE-TASK-003
test("config:secret reads the value from standard input (or the terminal without echo), never an argument, and --clear deletes it", async () => {
  const sb = sandbox();
  let io = fakeIo({ stdin: "sk-from-stdin\n" });
  assert.equal(await runCli(["secret", "llm.openai.api_key"], io, sb.opts), 0);
  assert.ok(!io.stdout.includes("sk-from-stdin"));
  io = fakeIo({ tty: true, hidden: ["sk-typed"] });
  assert.equal(await runCli(["secret", "chat.youtube.api_key"], io, sb.opts), 0);
  const s = await sb.open();
  assert.deepEqual(s.secretValues(), { "chat.youtube.api_key": "sk-typed", "llm.openai.api_key": "sk-from-stdin" });
  s.close();
  io = fakeIo();
  assert.equal(await runCli(["secret", "llm.openai.api_key", "--clear"], io, sb.opts), 0);
  io = fakeIo();
  await runCli(["get", "llm.openai.api_key"], io, sb.opts);
  assert.equal(io.stdout, "not set\n");
  assert.equal(await runCli(["secret", "llm.model"], fakeIo({ stdin: "x" }), sb.opts), 1);
});

// @spec STORE-TOK-001
test("config:token prints a generated 43-character token once; --stdin takes the owner's own and refuses a short one without echoing it", async () => {
  const sb = sandbox();
  let io = fakeIo();
  assert.equal(await runCli(["token"], io, sb.opts), 0);
  const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(io.stdout)?.[1];
  assert.ok(token, io.stdout);
  assert.match(io.stdout, /shown once.*password manager/s);
  let s = await sb.open();
  assert.equal(await s.checkBearer(token), "ok");
  s.close();
  io = fakeIo({ stdin: "short-token\n" });
  assert.equal(await runCli(["token", "--stdin"], io, sb.opts), 1);
  assert.ok(!io.stderr.includes("short-token"));
  io = fakeIo({ stdin: `${TOKEN}\n` });
  assert.equal(await runCli(["token", "--stdin"], io, sb.opts), 0);
  assert.ok(!io.stdout.includes(TOKEN));
  s = await sb.open();
  assert.equal(await s.checkBearer(TOKEN), "ok");
  s.close();
});

// @spec STORE-KEY-008, STORE-KEY-010
test("config:key --show prints the recovery key, --confirm clears the unconfirmed flag, --restore brings a lost key back", async () => {
  const sb = sandbox();
  await runCli(["secret", "llm.openai.api_key"], fakeIo({ stdin: "sk-1" }), sb.opts);
  let io = fakeIo();
  assert.equal(await runCli(["key", "--show"], io, sb.opts), 0);
  const recovery = io.stdout.trim();
  assert.equal(recovery, readFileSync(sb.keyFile, "utf8").trim());
  let s = await sb.open();
  assert.equal(s.recoveryKeyUnconfirmed(), true);
  s.close();
  io = fakeIo();
  assert.equal(await runCli(["key", "--confirm"], io, sb.opts), 0);
  assert.ok(io.stdout.includes(recovery));
  s = await sb.open();
  assert.equal(s.recoveryKeyUnconfirmed(), false);
  s.close();
  unlinkSync(sb.keyFile);
  assert.equal(await runCli(["get", "cohost.name"], fakeIo(), sb.opts), 1);
  io = fakeIo({ hidden: [recovery] });
  assert.equal(await runCli(["key", "--restore"], io, sb.opts), 0);
  assert.equal(statSync(sb.keyFile).mode & 0o777, 0o600);
  assert.deepEqual(await checkStore(sb.opts), []);
  assert.equal(await runCli(["key"], fakeIo(), sb.opts), 1);
});

// @spec STORE-KEY-009
test("config:reset-credentials changes nothing unless the owner types the confirmation", async () => {
  const sb = sandbox();
  await runCli(["secret", "llm.openai.api_key"], fakeIo({ stdin: "sk-1" }), sb.opts);
  unlinkSync(sb.keyFile);
  assert.equal(await runCli(["reset-credentials"], fakeIo({ typed: ["yes"] }), sb.opts), 1);
  assert.equal((await checkStore(sb.opts))[0]?.cause, "key");
  const io = fakeIo({ typed: [RESET_CONFIRMATION] });
  assert.equal(await runCli(["reset-credentials"], io, sb.opts), 0);
  assert.match(io.stdout, /ears has no listener key/);
  assert.deepEqual(await checkStore(sb.opts), []);
});

// @spec STORE-IO-002, STORE-IO-003, STORE-TASK-006
test("config:export writes a 0600 file; config:import --dry-run writes nothing; an import over a damaged store moves it aside", async () => {
  const sb = sandbox();
  await runCli(["secret", "llm.openai.api_key"], fakeIo({ stdin: "sk-exported" }), sb.opts);
  const dir = mkdtempSync(join(tmpdir(), "cohost-export-"));
  const file = join(dir, "export.yaml");
  assert.equal(await runCli(["export", file, "--secrets"], fakeIo({ hidden: ["pass phrase 1234", "pass phrase 1234"] }), sb.opts), 0);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(file, "utf8").includes("sk-exported"));
  assert.equal(await runCli(["export", "--secrets"], fakeIo({ hidden: ["pass phrase 1234", "different phrase"] }), sb.opts), 1);

  writeFileSync(file, readFileSync(file, "utf8").replace(/timezone: \S+/, "timezone: Asia/Tokyo"));
  let io = fakeIo({ hidden: ["pass phrase 1234"] });
  assert.equal(await runCli(["import", file, "--dry-run"], io, sb.opts), 0);
  assert.match(io.stdout, /dry run, nothing written/);
  assert.match(io.stdout, /credentials set: llm\.openai\.api_key/);
  assert.ok(!io.stdout.includes("sk-exported"));

  writeFileSync(storeFile(sb.data), "broken ".repeat(1000));
  io = fakeIo({ hidden: ["pass phrase 1234"] });
  assert.equal(await runCli(["import", file], io, sb.opts), 0, io.stderr);
  assert.match(io.stderr, /moved it aside as .*cohost\.db\.damaged-/);
  const s = await sb.open();
  assert.equal(s.config().cohost.timezone, "Asia/Tokyo");
  assert.equal(s.secret("llm.openai.api_key"), "sk-exported");
  assert.equal(s.revision(), 1, "a new store, seeded with nothing, then one import");
  s.close();
});

// @spec STORE-IO-004
test("config:import takes parts and reminds the owner to delete a plaintext secrets part", async () => {
  const sb = sandbox();
  const dir = mkdtempSync(join(tmpdir(), "cohost-parts-"));
  writeFileSync(join(dir, "secrets.yaml"), "connections:\n  discord:\n    token: disc-token\n");
  writeFileSync(join(dir, "personality.md"), "# Mine\n");
  const io = fakeIo();
  assert.equal(await runCli(["import", "--secrets", join(dir, "secrets.yaml"), "--personality", join(dir, "personality.md")], io, sb.opts), 0, io.stderr);
  assert.match(io.stdout, new RegExp(`delete ${join(dir, "secrets.yaml").replace(/[.]/g, "\\.")} now`));
  const s = await sb.open();
  assert.equal(s.secret("connections.discord.token"), "disc-token");
  assert.equal(s.personality(), "# Mine\n");
  s.close();
});

// @spec STORE-TASK-004
test("config:check prints ok and exits 0 for a usable store, and lists each problem and exits 1 otherwise", async () => {
  const sb = sandbox();
  (await sb.open()).close();
  let io = fakeIo();
  assert.equal(await runCli(["check"], io, sb.opts), 0);
  assert.equal(io.stdout, "ok\n");
  writeFileSync(storeFile(sb.data), "broken ".repeat(1000));
  io = fakeIo();
  assert.equal(await runCli(["check"], io, sb.opts), 1);
  assert.match(io.stderr, /^damaged: /);
});

// @spec STORE-TASK-005
test("config:backup writes a backup and config:restore puts it back", async () => {
  const sb = sandbox();
  await runCli(["set", "cohost.timezone", "Asia/Tokyo"], fakeIo(), sb.opts);
  let io = fakeIo();
  assert.equal(await runCli(["backup"], io, sb.opts), 0);
  const file = /backup written: (\S+)/.exec(io.stdout)![1]!;
  await runCli(["set", "cohost.timezone", "Europe/Rome"], fakeIo(), sb.opts);
  io = fakeIo();
  assert.equal(await runCli(["restore", file], io, sb.opts), 0, io.stderr);
  io = fakeIo();
  await runCli(["get", "cohost.timezone"], io, sb.opts);
  assert.equal(io.stdout, "Asia/Tokyo\n");
});

// @spec STORE-TASK-001
test("mise.toml runs each config:* task through the store's entry point after building it", () => {
  const listed = JSON.parse(execFileSync("mise", ["tasks", "ls", "--json", "--hidden"], { cwd: repo, encoding: "utf8", env: { ...process.env, MISE_QUIET: "1" } })) as { name: string; run: string[]; depends: string[] }[];
  const byName = new Map(listed.map((t) => [t.name, t]));
  const tasks = ["get", "set", "reset", "secret", "personality", "token", "key", "reset-credentials", "export", "import", "backup", "restore", "check"];
  for (const t of tasks) {
    const task = byName.get(`config:${t}`);
    assert.ok(task, `config:${t}`);
    assert.deepEqual(task.run, ["tsc -b packages/store", `node packages/store/dist/cli/index.js ${t}`], t);
    assert.deepEqual(task.depends, ["install"], t);
  }
});

// @spec STORE-KEY-002, STORE-IO-002
test("without a terminal the recovery-key pointer goes to standard error, so config:export to standard output is pure YAML", async () => {
  const sb = sandbox();
  const { notice: _ignored, ...opts } = sb.opts;
  const io = fakeIo();
  assert.equal(await runCli(["export"], io, opts), 0);
  assert.match(io.stderr, /a recovery key was created; run mise run config:key -- --show/);
  assert.ok(!io.stdout.includes("recovery key"));
  assert.equal((parseYaml(io.stdout) as { cohost_export: number }).cohost_export, 1);
});

// @spec STORE-IO-003
test("config:import --dry-run with no store yet creates neither the store nor the key file", async () => {
  const sb = sandbox();
  const dir = mkdtempSync(join(tmpdir(), "cohost-dry-"));
  writeFileSync(join(dir, "personality.md"), "# Dry\n");
  const io = fakeIo();
  assert.equal(await runCli(["import", "--personality", join(dir, "personality.md"), "--dry-run"], io, sb.opts), 0, io.stderr);
  assert.match(io.stderr, /no settings store .* yet/);
  assert.match(io.stdout, /dry run, nothing written/);
  assert.match(io.stdout, /changed: personality/);
  assert.equal(existsSync(storeFile(sb.data)), false);
  assert.equal(existsSync(sb.keyFile), false);
});

// @spec STORE-KEY-007
test("config:key --rotate keeps the old key file and, without a terminal, points at --show instead of printing the key", async () => {
  const sb = sandbox();
  await runCli(["secret", "llm.openai.api_key"], fakeIo({ stdin: "sk-1" }), sb.opts);
  const { notice: _ignored, ...opts } = sb.opts;
  const before = readFileSync(sb.keyFile, "utf8").trim();
  const io = fakeIo();
  assert.equal(await runCli(["key", "--rotate"], io, opts), 0, io.stderr);
  const after = readFileSync(sb.keyFile, "utf8").trim();
  assert.notEqual(after, before);
  assert.ok(!io.stdout.includes(after) && !io.stderr.includes(after));
  assert.match(io.stderr, /config:key -- --show/);
});
