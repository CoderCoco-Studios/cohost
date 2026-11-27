import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LifecycleLock, StackController, type ExecFile } from "@cohost/control";
import { backupDir, exportStore, formatKey, listBackups, openStore, peekStore, type Store } from "@cohost/store";
import { createRecoveryHandler, recoveryAddress, HOST_COMMANDS, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { SESSION_COOKIE, newSession } from "../src/access.js";
import { AUTH } from "./control-fixture.js";
import { brokenStore, dbState, rawSection, storedSection, testStore, type BrokenCause, type TestStore } from "./store-fixture.js";

// Config recovery mode's handler over a settings store that cannot be used (DASH-RCV-*), driven over HTTP.

interface Rig { url: string; port: number; st: TestStore; logs: string[]; notices: string[]; valid: () => number; close: () => Promise<void> }

interface RigOpts extends Partial<RecoveryHandlerDeps> {
  /** Runs on the store while it is still usable (a backup, the recovery key, a stored port). */
  before?: (s: Store) => unknown;
  /** Wraps the handler (a test that fakes the peer's address). */
  wrap?: (h: http.RequestListener) => http.RequestListener;
  /** Whether the store holds the test token's verifier (default true). */
  token?: boolean;
}

async function rig(cause: BrokenCause, o: RigOpts = {}): Promise<Rig> {
  const st = await brokenStore(cause, { ...(o.before ? { before: o.before } : {}), ...(o.token === false ? { token: false } : {}) });
  const dir = mkdtempSync(join(tmpdir(), "cohost-rcv-"));
  const logs: string[] = [];
  const notices: string[] = [];
  let valid = 0;
  const line = (level: string) => (...a: unknown[]) => { logs.push(`${level} ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`); };
  const log = { info: line("info"), error: line("error") } as never;
  const handler = createRecoveryHandler({
    log, store: st.opts, uiDir: join(dir, "no-ui"), onValid: () => { valid++; },
    notice: { isTTY: false, write: (t) => { notices.push(t); }, warn: (t) => { notices.push(t); } }, ...o,
  });
  const server = http.createServer(o.wrap ? o.wrap(handler) : handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, port, st, logs, notices, valid: () => valid,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

type State = { active: boolean; cause?: string; etag?: string; problems: RecoveryProblem[]; backups: { name: string; time: string }[]; gated: boolean };
const state = async (r: Rig): Promise<State> => (await (await fetch(`${r.url}/recovery`)).json()) as State;
const post = (r: Rig, op: string, body: unknown, headers: Record<string, string> = AUTH) =>
  fetch(`${r.url}/recovery/${op}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const db = (r: Rig): string => dbState(r.st.opts.dataDir!);

// @spec DASH-RCV-004, DASH-RCV-012
test("GET /recovery with invalid settings lists every failing key with its section, the actions it allows and the backups, and writes nothing", async () => {
  const r = await rig("invalid-settings", { before: (s) => s.backup() });
  try {
    const before = db(r);
    const res = await fetch(`${r.url}/recovery`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const s = (await res.json()) as State;
    assert.equal(s.active, true);
    assert.equal(s.cause, "invalid-settings");
    assert.equal(s.etag, String(peekStore(r.st.opts)!.revision));
    assert.equal(s.gated, true);
    assert.deepEqual(s.backups, listBackups(r.st.opts.dataDir!));
    assert.equal(s.backups.length, 1);
    const by = Object.fromEntries(s.problems.map((p) => [p.path, p]));
    assert.deepEqual(Object.keys(by).toSorted(), ["llm.retired_key", "llm.temperature"]);
    assert.deepEqual(by["llm.temperature"]!.actions, { set: true, reset: true });
    assert.deepEqual(by["llm.temperature"]!.section, { path: "llm", title: by["llm.temperature"]!.section!.title });
    assert.equal(typeof by["llm.temperature"]!.section!.title, "string");
    assert.deepEqual(by["llm.retired_key"]!.actions, { set: false, reset: true }, "a key the schema does not define is only reset");
    for (const p of s.problems) assert.equal(p.sensitive, false);
    assert.equal(db(r), before, "a read writes nothing");
    assert.equal(r.valid(), 0);
  } finally { await r.close(); }
});

// @spec DASH-RCV-004, DASH-RCV-028
test("a readable store that holds no verifier is not gated: every recovery write is 409 naming the host commands, and nothing is written", async () => {
  const r = await rig("invalid-settings", { token: false });
  try {
    const s = await state(r);
    assert.equal(s.cause, "invalid-settings");
    assert.equal(s.gated, false, "no verifier to check a bearer against");
    const before = dbState(r.st.opts.dataDir!);
    const res = await fetch(`${r.url}/recovery/reset-all`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify({ etag: s.etag }) });
    assert.equal(res.status, 409);
    assert.ok(((await res.json()) as { detail: string }).detail.includes(HOST_COMMANDS));
    assert.equal(dbState(r.st.opts.dataDir!), before);
  } finally { await r.close(); }
});

// @spec DASH-RCV-004, DASH-RCV-028
test("each other cause is one problem with no path and no action: a damaged store with no etag and gated false, a newer store naming the update, a missing key", async () => {
  const damaged = await rig("damaged-store");
  try {
    const s = await state(damaged);
    assert.equal(s.cause, "damaged-store");
    assert.equal(s.etag, undefined, "no etag while the store cannot be read");
    assert.equal(s.gated, false, "the verifier cannot be read");
    assert.equal(s.problems.length, 1);
    assert.deepEqual({ ...s.problems[0], message: "" }, { path: "", message: "", sensitive: false, actions: { set: false, reset: false } });
  } finally { await damaged.close(); }
  const newer = await rig("newer-store");
  try {
    const s = await state(newer);
    assert.equal(s.cause, "newer-store");
    assert.equal(s.gated, true);
    assert.equal(s.problems.length, 1);
    assert.match(s.problems[0]!.message, /git pull/);
    assert.deepEqual(s.problems[0]!.actions, { set: false, reset: false });
  } finally { await newer.close(); }
  const key = await rig("missing-key");
  try {
    const s = await state(key);
    assert.equal(s.cause, "missing-key");
    assert.equal(s.gated, true);
    assert.equal(typeof s.etag, "string");
    assert.equal(s.problems.length, 1);
    assert.equal(s.problems[0]!.path, "");
  } finally { await key.close(); }
});

// @spec DASH-RCV-005, DASH-RCV-009, DASH-RCV-012, DASH-RCV-015
test("set writes the one key, reads typed text as YAML when the key accepts it, and answers the fresh problem list", async () => {
  const r = await rig("invalid-settings");
  try {
    let s = await state(r);
    const before = db(r);
    const stale = await post(r, "set", { etag: String(Number(s.etag) + 7), path: "llm.temperature", value: "1" });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { ok: false, etag: s.etag });
    const refused = await post(r, "set", { etag: s.etag, path: "llm.temperature", value: "50" });
    assert.equal(refused.status, 400, "the key's schema refuses it");
    assert.ok(((await refused.json()) as { issues: { path: string }[] }).issues.some((i) => i.path === "llm.temperature"));
    assert.equal(db(r), before, "a refusal writes nothing");
    const ok = await post(r, "set", { etag: s.etag, path: "llm.temperature", value: "0.5" });
    assert.equal(ok.status, 200);
    const j = (await ok.json()) as { ok: boolean; etag: string; problems: RecoveryProblem[]; valid: boolean; moved?: unknown };
    assert.equal(j.ok, true);
    assert.equal(j.etag, String(Number(s.etag) + 1));
    assert.deepEqual(j.problems.map((p) => p.path), ["llm.retired_key"]);
    assert.equal(j.valid, false);
    assert.equal("moved" in j, false);
    const s2 = await openStore({ ...r.st.opts, keyOptional: true });
    try { assert.equal(storedSection(s2, "llm")["temperature"], 0.5, "the YAML text became a number"); } finally { s2.close(); }
    assert.ok(r.logs.includes("info config recovery: set llm.temperature"), r.logs.join("\n"));
    assert.ok(r.logs.includes("info config recovery: 1 problem remains"), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("0.5")), "no value in the log");
    s = await state(r);
    assert.equal(s.problems.length, 1);
    assert.equal(r.valid(), 0);
  } finally { await r.close(); }
});

// @spec DASH-RCV-006, DASH-RCV-009, DASH-RCV-011, DASH-RCV-015
test("reset removes the key so its default applies, a path that is no current problem is 400, and the last fix answers valid and leaves", async () => {
  const r = await rig("invalid-settings");
  try {
    let s = await state(r);
    const before = db(r);
    assert.equal((await post(r, "reset", { etag: s.etag, path: "llm.model" })).status, 400, "no problem at this path");
    assert.equal(db(r), before);
    const first = await post(r, "reset", { etag: s.etag, path: "llm.retired_key" });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { valid: boolean }).valid, false);
    s = await state(r);
    const last = await post(r, "reset", { etag: s.etag, path: "llm.temperature" });
    assert.equal(last.status, 200);
    const j = (await last.json()) as { valid: boolean; problems: unknown[] };
    assert.equal(j.valid, true);
    assert.deepEqual(j.problems, []);
    await new Promise((d) => setTimeout(d, 20));
    assert.equal(r.valid(), 1, "recovery mode is left once the answer is sent");
    const s2 = await openStore({ ...r.st.opts, keyOptional: true });
    try {
      assert.equal("retired_key" in storedSection(s2, "llm"), false);
      assert.equal("temperature" in storedSection(s2, "llm"), false);
    } finally { s2.close(); }
    assert.ok(r.logs.includes("info config recovery: reset llm.retired_key"), r.logs.join("\n"));
    assert.ok(r.logs.includes("info config recovery: the settings store can be used; leaving config recovery mode"), r.logs.join("\n"));
  } finally { await r.close(); }
});

// @spec DASH-RCV-007, DASH-RCV-009, DASH-RCV-015
test("reset-all removes every failing key in one store write and answers valid", async () => {
  const r = await rig("invalid-settings");
  try {
    const s = await state(r);
    const res = await post(r, "reset-all", { etag: s.etag });
    assert.equal(res.status, 200);
    const j = (await res.json()) as { valid: boolean; etag: string };
    assert.equal(j.valid, true);
    assert.equal(j.etag, String(Number(s.etag) + 1), "one write");
    assert.ok(r.logs.includes("info config recovery: reset all (2 keys)"), r.logs.join("\n"));
  } finally { await r.close(); }
});

// @spec DASH-RCV-003
test("every recovery write passes the gate: 401 {ok: false, detail} without the token, writing nothing; with it the write is made", async () => {
  const r = await rig("invalid-settings");
  try {
    const s = await state(r);
    const before = db(r);
    for (const [op, body] of [["set", { etag: s.etag, path: "llm.temperature", value: "1" }], ["reset", { etag: s.etag, path: "llm.temperature" }], ["reset-all", { etag: s.etag }]] as const) {
      const refused = await post(r, op, body, {});
      assert.equal(refused.status, 401, op);
      assert.equal(refused.headers.get("www-authenticate"), "Bearer");
      assert.equal(((await refused.json()) as { ok: boolean }).ok, false);
      assert.equal((await post(r, op, body, { authorization: "Bearer wrong" })).status, 401, op);
    }
    assert.equal(db(r), before);
    assert.equal((await post(r, "reset-all", { etag: s.etag })).status, 200);
  } finally { await r.close(); }
});

// @spec DASH-RCV-003, DASH-RCV-004
test("an entry of a sensitive list is marked sensitive like the list, and setting it is gated like any set", async () => {
  const r = await rig("invalid-settings", {
    before: (s) => { rawSection(s.dataDir, "dashboard", { ...storedSection(s, "dashboard"), allowed_hosts: [5] }); },
  });
  try {
    const s = await state(r);
    const entry = s.problems.find((p) => p.path === "dashboard.allowed_hosts[0]");
    assert.ok(entry, JSON.stringify(s.problems));
    assert.equal(entry.sensitive, true);
    assert.deepEqual(entry.actions, { set: true, reset: true });
    assert.equal((await post(r, "set", { etag: s.etag, path: "dashboard.allowed_hosts[0]", value: "streampc" }, {})).status, 401);
    const ok = await post(r, "set", { etag: s.etag, path: "dashboard.allowed_hosts[0]", value: "streampc" });
    assert.equal(ok.status, 200, await ok.clone().text());
    const s2 = await openStore({ ...r.st.opts, keyOptional: true });
    try { assert.deepEqual(storedSection(s2, "dashboard")["allowed_hosts"], ["streampc"]); } finally { s2.close(); }
  } finally { await r.close(); }
});

// @spec DASH-RCV-004, DASH-RCV-005
test("paths that name an object's own properties are refused, never a 500", async () => {
  const r = await rig("invalid-settings");
  try {
    const s = await state(r);
    const before = db(r);
    for (const path of ["__proto__", "constructor", "llm.toString", "llm.__proto__"]) {
      const set = await post(r, "set", { etag: s.etag, path, value: "x" });
      assert.ok(set.status === 400 || set.status === 409, `${path}: ${set.status}`);
      const reset = await post(r, "reset", { etag: s.etag, path });
      assert.equal(reset.status, 400, path);
    }
    assert.equal(db(r), before);
  } finally { await r.close(); }
});

// @spec DASH-RCV-004, DASH-RCV-012
test("a write that does not apply to the cause is 409 naming the cause, and a body that is not a JSON object is 400, writing nothing", async () => {
  const r = await rig("missing-key");
  try {
    const before = db(r);
    const s = await state(r);
    const res = await post(r, "set", { etag: s.etag, path: "llm.temperature", value: "1" });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { detail: string }).detail, /missing key/);
    const bad = await fetch(`${r.url}/recovery/key`, { method: "POST", headers: AUTH, body: "[1]" });
    assert.equal(bad.status, 400);
    assert.equal(db(r), before);
  } finally { await r.close(); }
});

// @spec DASH-RCV-024, DASH-RCV-009
test("restore replaces the store with a listed backup and answers valid; a name not listed is 404 and a backup that fails the checks 400", async () => {
  const r = await rig("invalid-settings", { before: (s) => s.backup() });
  try {
    const before = db(r);
    assert.equal((await post(r, "restore", { backup: "cohost-20000101T000000Z.db" })).status, 404);
    assert.equal((await post(r, "restore", { backup: "../cohost.db" })).status, 404);
    // A file named like a backup that is none.
    mkdirSync(backupDir(r.st.opts.dataDir!), { recursive: true });
    writeFileSync(join(backupDir(r.st.opts.dataDir!), "cohost-19990101T000000Z.db"), "not a database ".repeat(100));
    const bogus = await post(r, "restore", { backup: "cohost-19990101T000000Z.db" });
    assert.equal(bogus.status, 400);
    assert.equal(db(r), before, "a refused restore writes nothing");
    const s = await state(r);
    const good = s.backups.find((b) => b.name !== "cohost-19990101T000000Z.db")!;
    const res = await post(r, "restore", { backup: good.name });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { valid: boolean }).valid, true);
    assert.ok(r.logs.includes(`info config recovery: restored ${good.name}`), r.logs.join("\n"));
  } finally { await r.close(); }
});

// @spec DASH-RCV-025, DASH-RCV-009
test("import replaces the stored settings with an export's and answers valid; text that does not parse is 400 with issues, writing nothing", async () => {
  const src = await testStore({ token: false, edits: { cohost: { timezone: "Asia/Tokyo" } } });
  const text = exportStore(src.store);
  src.close();
  const r = await rig("invalid-settings");
  try {
    const before = db(r);
    const bad = await post(r, "import", { text: "not: an: export" });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(((await bad.json()) as { issues: unknown[] }).issues));
    assert.equal((await post(r, "import", { text: 5 })).status, 400);
    assert.equal(db(r), before);
    const res = await post(r, "import", { text });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { valid: boolean }).valid, true);
    const s2 = await openStore({ ...r.st.opts, keyOptional: true });
    try { assert.equal(storedSection(s2, "cohost")["timezone"], "Asia/Tokyo"); } finally { s2.close(); }
    assert.ok(r.logs.includes("info config recovery: imported"), r.logs.join("\n"));
    assert.ok(!r.logs.some((l) => l.includes("Asia/Tokyo")), "no text of the import in the log");
  } finally { await r.close(); }
});

// @spec DASH-RCV-026, DASH-RCV-009
test("key restores the key file from the recovery key from a loopback peer; a key of another store is 400 naming the mismatch; nothing logs the key", async () => {
  let recoveryKey = "";
  const r = await rig("missing-key", { before: (s) => { recoveryKey = s.recoveryKey(); } });
  try {
    const before = db(r);
    const other = formatKey(randomBytes(32));
    const wrong = await post(r, "key", { recoveryKey: other });
    assert.equal(wrong.status, 400);
    assert.match(((await wrong.json()) as { detail: string }).detail, /key/);
    assert.equal(existsSync(r.st.opts.keyFile!), false, "no key file written");
    assert.equal(db(r), before);
    const ok = await post(r, "key", { recoveryKey });
    assert.equal(ok.status, 200, await ok.clone().text());
    const text = await ok.text();
    assert.equal(((JSON.parse(text)) as { valid: boolean }).valid, true);
    assert.ok(!text.includes(recoveryKey.split(":")[1]!), "the answer carries no key");
    assert.equal(existsSync(r.st.opts.keyFile!), true);
    assert.ok(r.logs.includes("info config recovery: key restored"));
    assert.ok(!r.logs.some((l) => l.includes(recoveryKey.split(":")[1]!) || l.includes(other.split(":")[1]!)), "no key in the log");
  } finally { await r.close(); }
});

// @spec DASH-RCV-026
test("key from a peer that is not loopback is 403 whatever the Host header says, writing nothing", async () => {
  let recoveryKey = "";
  const r = await rig("missing-key", {
    before: (s) => { recoveryKey = s.recoveryKey(); },
    // The peer's address as the socket reports it: a machine on the LAN.
    wrap: (h) => (req, res) => { Object.defineProperty(req.socket, "remoteAddress", { value: "192.168.1.5", configurable: true }); h(req, res); },
  });
  try {
    const res = await post(r, "key", { recoveryKey }, { ...AUTH, host: "127.0.0.1" });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { detail: string }).detail, /mise run config:key -- --restore/);
    assert.equal(existsSync(r.st.opts.keyFile!), false);
  } finally { await r.close(); }
});

// @spec DASH-RCV-027, DASH-RCV-009
test("discard-credentials needs the typed confirmation, then discards the credentials, makes a new key shown only on the terminal and answers valid", async () => {
  const r = await rig("missing-key", { before: (s) => s.write({ secrets: { "llm.openai.api_key": "sk-gone" } }) });
  try {
    const before = db(r);
    for (const body of [{}, { confirm: "delete" }, { confirm: "DELETE CREDENTIALS" }]) {
      assert.equal((await post(r, "discard-credentials", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(db(r), before);
    const res = await post(r, "discard-credentials", { confirm: "delete credentials" });
    assert.equal(res.status, 200, await res.clone().text());
    const text = await res.text();
    assert.equal((JSON.parse(text) as { valid: boolean }).valid, true);
    assert.doesNotMatch(text, /cohost-key-1:/, "the new key is never sent to the page");
    assert.ok(r.logs.includes("info config recovery: credentials discarded"));
    const s2 = await openStore({ ...r.st.opts });
    try {
      assert.deepEqual(s2.secretPaths(), []);
      assert.equal(s2.recoveryKeyUnconfirmed(), true, "no terminal: the banner flag is set");
    } finally { s2.close(); }
  } finally { await r.close(); }
});

// @spec DASH-RCV-028, DASH-UNL-001
test("with a damaged store, a newer store or a missing key no session counts and none is made; a bearer the verifier accepts still passes", async () => {
  for (const cause of ["newer-store", "missing-key"] as const) {
    const r = await rig(cause);
    try {
      const cookie = `${SESSION_COOKIE}=${newSession(randomBytes(32))}`;
      const control = (await (await fetch(`${r.url}/services/control`, { headers: { cookie } })).json()) as { unlocked: boolean };
      assert.equal(control.unlocked, false, cause);
      // No link can unlock: there is no session key to make one under.
      const link = await fetch(`${r.url}/unlock/link`, { method: "POST", headers: AUTH });
      assert.equal(link.status, 200, `${cause}: the bearer passes`);
      const url = new URL(((await link.json()) as { url: string }).url);
      const opened = await fetch(`${r.url}${url.pathname}${url.search}`, { redirect: "manual" });
      assert.equal(opened.status, 400, `${cause}: no session is made`);
      assert.equal(opened.headers.get("set-cookie"), null);
      assert.equal((await fetch(`${r.url}/recovery/set`, { method: "POST", headers: { cookie, origin: r.url }, body: "{}" })).status, 401, `${cause}: a cookie is no pass`);
    } finally { await r.close(); }
  }
});

// @spec DASH-RCV-028
test("while the verifier cannot be read every recovery write is 409 naming the host commands, whatever the bearer, writing nothing", async () => {
  const r = await rig("damaged-store");
  try {
    for (const op of ["set", "reset", "reset-all", "restore", "import", "key", "discard-credentials"]) {
      for (const headers of [AUTH, {}]) {
        const res = await post(r, op, {}, headers);
        assert.equal(res.status, 409, op);
        const detail = ((await res.json()) as { detail: string }).detail;
        assert.ok(detail.includes(HOST_COMMANDS), detail);
        assert.match(detail, /mise run config:restore/);
      }
    }
    assert.equal(r.valid(), 0);
  } finally { await r.close(); }
});

// @spec DASH-RCV-010
test("stack posts other than stop and every lifecycle post are refused with the config gate's text, other routes 503, health and the UI served", async () => {
  const r = await rig("invalid-settings");
  try {
    for (const path of ["/stack/launch", "/stack/rebuild", "/stack/restart", "/services/voice/start", "/services/voice/stop", "/services/voice/restart"]) {
      const res = await fetch(`${r.url}${path}`, { method: "POST", headers: AUTH });
      assert.equal(res.status, 409, path);
      assert.match(((await res.json()) as { detail: string }).detail, /^the settings store cannot be used \(2 problems; first: .*recovery screen/);
    }
    assert.equal((await fetch(`${r.url}/health`)).status, 200);
    assert.deepEqual(await (await fetch(`${r.url}/services/control`)).json(), { runtime: "compose", advanced: false, unlocked: false });
    for (const path of ["/stack/launch", "/services/voice/start"]) {
      assert.equal((await fetch(`${r.url}${path}`, { method: "POST" })).status, 409, `${path}: 409 whatever the bearer`);
    }
    const other = await fetch(`${r.url}/stack`);
    assert.equal(other.status, 503);
    assert.match(((await other.json()) as { detail: string }).detail, /config recovery mode/);
    assert.equal((await fetch(`${r.url}/`)).status, 503, "the UI route answers (its not-built page here)");
    for (const path of ["/recovery/raw", "/recovery/fallback"]) {
      assert.equal((await fetch(`${r.url}${path}`, { method: "POST", headers: AUTH, body: "{}" })).status, 503, `${path} is no route`);
    }
  } finally { await r.close(); }
});

// @spec DASH-RCV-011
test("GET /recovery on a store fixed outside the page answers inactive and leaves recovery mode", async () => {
  const r = await rig("invalid-settings");
  try {
    const s = await openStore({ ...r.st.opts, keyOptional: true });
    const llm = storedSection(s, "llm");
    s.close();
    delete llm["temperature"];
    delete llm["retired_key"];
    rawSection(r.st.opts.dataDir!, "llm", llm);
    assert.deepEqual(await (await fetch(`${r.url}/recovery`)).json(), { active: false });
    await new Promise((d) => setTimeout(d, 20));
    assert.equal(r.valid(), 1);
  } finally { await r.close(); }
});

// @spec DASH-RCV-002
test("the recovery port and allowed hosts come from the stored dashboard section when it validates, else the defaults", () => {
  const base = { port: 3400, lan_port: 3001, allowed_hosts: ["cohost.lan"] };
  assert.deepEqual(recoveryAddress({ verifier: undefined, revision: 1, dashboard: base }), { port: 3400, allowedHosts: ["cohost.lan"], fromStore: true });
  assert.equal(recoveryAddress({ verifier: undefined, revision: 1, dashboard: { ...base, port: 3001 } }).port, 3000, "port equal to lan_port fails the section");
  assert.equal(recoveryAddress({ verifier: undefined, revision: 1, dashboard: { port: "x" } }).fromStore, false);
  assert.deepEqual(recoveryAddress({ verifier: undefined, revision: 1, dashboard: undefined }), { port: 3000, allowedHosts: [], fromStore: false });
  assert.equal(recoveryAddress(undefined).port, 3000, "a store that cannot be read");
});

// @spec DASH-RCV-011
test("recovery mode is left once when the client of the answer that found the store usable goes away before the answer finishes", async () => {
  const st = await testStore({ token: false });
  st.close();
  let valid = 0;
  const handler = createRecoveryHandler({ log: { info() {}, error() {} } as never, store: st.opts, uiDir: join(st.root, "ui"), onValid: () => { valid++; } });
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/recovery", headers: {} });
  const state = { ended: false };
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead() { return this; }, end() { state.ended = true; return this; } });
  handler(req as never, res as never);
  for (let i = 0; i < 200 && !state.ended; i++) await new Promise((d) => setTimeout(d, 10));
  assert.equal(state.ended, true);
  assert.equal(valid, 0);
  res.emit("close");
  res.emit("finish");
  await new Promise((d) => setTimeout(d, 10));
  assert.equal(valid, 1);
});

// @spec DASH-RCV-009, DASH-RCV-011
test("the valid answer says moved, with the port, only when dashboard.port is not the bound recovery port", async () => {
  const same = await rig("invalid-settings", { boundPort: 3000 });
  try {
    const s = await state(same);
    const body = await (await post(same, "reset-all", { etag: s.etag })).json() as Record<string, unknown>;
    assert.equal(body.valid, true);
    assert.equal(body.moved, undefined);
    assert.equal(body.port, undefined);
  } finally { await same.close(); }
  const moved = await rig("invalid-settings", { boundPort: 3000, before: (s) => s.setKey("dashboard.port", 3100) });
  try {
    const s = await state(moved);
    const body = await (await post(moved, "reset-all", { etag: s.etag })).json() as Record<string, unknown>;
    assert.equal(body.valid, true);
    assert.equal(body.moved, true);
    assert.equal(body.port, 3100);
  } finally { await moved.close(); }
});

// @spec DASH-RCV-019, DASH-RCV-011
test("a Stop running when the store becomes usable is answered before recovery mode is left", async () => {
  let release: () => void = () => {};
  const stack = { stopAll: () => new Promise<{ ok: true }>((r) => { release = () => r({ ok: true }); }) };
  const r = await rig("invalid-settings", { stack, lock: new LifecycleLock({ by: "dashboard", dir: mkdtempSync(join(tmpdir(), "cohost-rcv-lock-")) }) });
  try {
    const stopping = fetch(`${r.url}/stack/stop`, { method: "POST", headers: AUTH });
    await new Promise((done) => setTimeout(done, 50));
    const s = await state(r);
    assert.equal((await post(r, "reset-all", { etag: s.etag })).status, 200);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(r.valid(), 0, "recovery mode is not left while docker compose stop runs");
    release();
    const res = await stopping;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, action: "stop" });
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(r.valid(), 1, "then it is left");
    const order = r.logs.filter((l) => l.includes("config recovery: stop") || l.includes("leaving config recovery mode"));
    assert.deepEqual(order, ["info config recovery: stop", "info config recovery: the settings store can be used; leaving config recovery mode"]);
  } finally { await r.close(); }
});

// @spec DASH-RCV-019, DASH-RCV-010
test("Stop runs docker compose stop with no usable store, behind the gate and the lifecycle lock", async () => {
  // A damaged store's verifier cannot be read, so no bearer passes: the Stop is then made from the host.
  const ran: string[][] = [];
  const damaged = await rig("damaged-store", {
    stack: new StackController({ exec: async (_f, args) => { ran.push(args); return { stdout: "", stderr: "" }; }, cwd: "/ws", env: {} }),
    lock: new LifecycleLock({ by: "dashboard", dir: mkdtempSync(join(tmpdir(), "cohost-rcv-lock-")) }),
  });
  try {
    assert.equal((await fetch(`${damaged.url}/stack/stop`, { method: "POST", headers: AUTH })).status, 401);
    assert.deepEqual(ran, []);
  } finally { await damaged.close(); }

  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const exec: ExecFile = async (file, args, opts) => { calls.push({ file, args, cwd: opts.cwd }); return { stdout: "", stderr: "" }; };
  const lockDir = mkdtempSync(join(tmpdir(), "cohost-rcv-lock-"));
  const on = await rig("invalid-settings", { stack: new StackController({ exec, cwd: "/ws", env: { COHOST_DOCKER_BIN: "/opt/docker" } }), lock: new LifecycleLock({ by: "dashboard", dir: lockDir }) });
  try {
    const no = await fetch(`${on.url}/stack/stop`, { method: "POST" });
    assert.equal(no.status, 401);
    assert.equal(no.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(calls, []);
    const res = await fetch(`${on.url}/stack/stop`, { method: "POST", headers: AUTH });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, action: "stop" });
    assert.deepEqual(calls, [{ file: "/opt/docker", args: ["compose", "stop"], cwd: "/ws" }]);
    assert.equal(existsSync(join(lockDir, "control.lock")), false, "the lock is released");
    assert.ok(on.logs.includes("info config recovery: stop"), on.logs.join("\n"));
    const held = new LifecycleLock({ by: "cohostctl", dir: lockDir, pid: process.ppid }).tryAcquire("launch");
    assert.ok(held.ok);
    const busy = await fetch(`${on.url}/stack/stop`, { method: "POST", headers: AUTH });
    assert.equal(busy.status, 409);
    assert.match(((await busy.json()) as { detail: string }).detail, /^busy: launch held by cohostctl/);
    assert.equal(calls.length, 1, "nothing runs while the lock is held");
    held.release();
  } finally { await on.close(); }

  const failExec: ExecFile = async () => { throw Object.assign(new Error("exit 1"), { stderr: "Cannot connect to the Docker daemon\n" }); };
  const failLock = mkdtempSync(join(tmpdir(), "cohost-rcv-lock-"));
  const failing = await rig("invalid-settings", { stack: new StackController({ exec: failExec, cwd: "/ws", env: { COHOST_DOCKER_BIN: "/opt/docker" } }), lock: new LifecycleLock({ by: "dashboard", dir: failLock }) });
  try {
    const res = await fetch(`${failing.url}/stack/stop`, { method: "POST", headers: AUTH });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, detail: "Cannot connect to the Docker daemon" });
    assert.equal(existsSync(join(failLock, "control.lock")), false, "the lock is released after a failure");
    assert.ok(failing.logs.some((l) => l.startsWith("error") && l.includes("Cannot connect to the Docker daemon")), failing.logs.join("\n"));
  } finally { await failing.close(); }
});

// @spec DASH-RCV-012
test("entering recovery mode and reading its routes write nothing to the store or the key file", async () => {
  const r = await rig("invalid-settings");
  try {
    const before = db(r);
    await state(r);
    await fetch(`${r.url}/services/control`);
    await fetch(`${r.url}/secrets/llm.openai.api_key`, { method: "PUT", headers: AUTH, body: JSON.stringify({ value: "sk-x" }) });
    assert.equal(db(r), before);
  } finally { await r.close(); }
});

// @spec DASH-HTTP-015, DASH-RCV-025, DASH-RCV-012
test("a recovery body is capped: an import over 1 MiB and any other write over 64 KiB are 413, writing nothing", async () => {
  const r = await rig("invalid-settings");
  try {
    const before = db(r);
    const s = await state(r);
    assert.equal((await post(r, "import", { text: "x".repeat(1024 * 1024 + 10) })).status, 413);
    assert.equal((await post(r, "set", { etag: s.etag, path: "llm.temperature", value: "x".repeat(65 * 1024) })).status, 413);
    const fits = await post(r, "import", { text: `${"#".repeat(200 * 1024)}\n` });
    assert.equal(fits.status, 400, "an import under 1 MiB is read and judged");
    assert.equal(db(r), before);
  } finally { await r.close(); }
});
