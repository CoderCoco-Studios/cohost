import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outboxPath, sha256Hex } from "@cohost/config";
import { openStore, type StoreOptions } from "@cohost/store";
import { runUnit } from "../src/run-unit.js";

const quiet = { notice: { isTTY: false, write: () => {}, warn: () => {} }, warn: () => {} };

/** A workspace root with `services/<unit>/`, a sandboxed store and an entry script that reports what it was started with. */
async function world(unit: string, entryName = "probe.js", exit = 7) {
  const base = mkdtempSync(join(tmpdir(), "cohost-run-unit-"));
  const root = join(base, "ws");
  mkdirSync(join(root, "services", unit), { recursive: true });
  const data = join(base, "data");
  const store: StoreOptions = { ...quiet, dataDir: data, keyFile: join(base, "key", "master.key") };
  const s = await openStore(store);
  assert.ok(s.write({ secrets: { "voice.openai.api_key": "sk-voice" } }).ok);
  s.close();
  const report = join(base, "report.json");
  const entry = join(base, entryName);
  writeFileSync(entry, `
const fs = require("node:fs");
let message = null;
if (process.env.COHOST_CREDENTIALS_FD) message = fs.readFileSync(Number(process.env.COHOST_CREDENTIALS_FD), "utf8");
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ cwd: process.cwd(), configDir: process.env.CONFIG_DIR, fd: process.env.COHOST_CREDENTIALS_FD ?? null, message, token: process.env.CONTROL_TOKEN ?? null }));
if (process.env.WRITE_OUTBOX) fs.writeFileSync(process.env.WRITE_OUTBOX, process.env.OUTBOX_TEXT);
process.exit(${exit});
`.replace(/^\n/, ""));
  writeFileSync(join(base, "package.json"), JSON.stringify({ type: "commonjs" }));
  return { root, store, entry, report, data, read: () => JSON.parse(readFileSync(report, "utf8")) as Record<string, string | null> };
}

// @spec STORE-DLV-007, STORE-DLV-001, DEPLOY-TOOL-014
test("the unit runner writes the projection, starts the entry in the service directory with CONFIG_DIR and the message on descriptor 3, and exits with the child's status", async () => {
  const w = await world("voice");
  const errs: string[] = [];
  const code = await runUnit(["voice", w.entry], { root: w.root, env: { PATH: process.env.PATH }, store: w.store, err: (l) => errs.push(l), onSignal: () => {} });
  assert.equal(code, 7, errs.join("\n"));
  const r = w.read();
  assert.equal(r.cwd, join(w.root, "services", "voice"));
  assert.equal(r.configDir, join(w.root, "data", "projections", "voice"));
  assert.ok(existsSync(join(r.configDir!, "settings.json")));
  assert.equal(r.fd, "3");
  const m = JSON.parse(r.message!) as { unit: string; credentials: Record<string, string> };
  assert.equal(m.unit, "voice");
  assert.deepEqual(m.credentials, { "voice.openai.api_key": "sk-voice" });
  assert.doesNotMatch(readFileSync(join(r.configDir!, "settings.json"), "utf8"), /sk-voice/);
});

// @spec STORE-DLV-007
test("a unit that gets no message is started with no descriptor; a CONTROL_TOKEN in the environment refuses the start", async () => {
  const w = await world("mouth", "probe.js", 0);
  assert.equal(await runUnit(["mouth", w.entry], { root: w.root, env: { PATH: process.env.PATH }, store: w.store, err: () => {}, onSignal: () => {} }), 0);
  assert.equal(w.read().fd, null);
  assert.equal(w.read().message, null);
  const errs: string[] = [];
  assert.equal(await runUnit(["mouth", w.entry], { root: w.root, env: { PATH: process.env.PATH, CONTROL_TOKEN: "an-owner-chosen-control-token-long-enough" }, store: w.store, err: (l) => errs.push(l), onSignal: () => {} }), 1);
  assert.match(errs.join("\n"), /the environment defines CONTROL_TOKEN/);
  assert.equal(await runUnit([], { err: () => {} }), 2);
  assert.equal(await runUnit(["redis"], { root: w.root, err: () => {} }), 2, "a unit with no settings does not run on the host");
});

// @spec STORE-OUT-002, MEM-REFLECT-007
test("after reflect exits 0 the runner applies the personality outbox and rewrites the personality projections", async () => {
  const w = await world("memory", "reflect.js", 0);
  const s = await openStore(w.store);
  const before = s.personality()!;
  s.close();
  const text = `${before}\n## Learned\n\n### 2026-11-27\n- likes frogs\n`;
  const file = outboxPath(w.data);
  mkdirSync(join(w.data, "memory"), { recursive: true });
  writeFileSync(file, JSON.stringify({ base: sha256Hex(before), text }));
  assert.equal(await runUnit(["memory", w.entry], { root: w.root, env: { PATH: process.env.PATH }, store: w.store, err: () => {}, onSignal: () => {} }), 0);
  assert.equal(existsSync(file), false, "the outbox is applied and deleted");
  const after = await openStore(w.store);
  assert.equal(after.personality(), text);
  after.close();
  const cortex = JSON.parse(readFileSync(join(w.root, "data", "projections", "cortex", "settings.json"), "utf8")) as { documents: { personality: string } };
  assert.equal(cortex.documents.personality, text, "the personality projections are rewritten");
});
