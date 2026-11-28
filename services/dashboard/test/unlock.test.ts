import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { createRecoveryHandler, runRecovery, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { guardFullSurface } from "../src/host.js";
import { BAD_LINK_PAGE, SESSION_COOKIE, UnlockLinks, authorized, newSession, sessionValid, unlockBase, unlockLine, type Gate } from "../src/access.js";
import { storeGate } from "../src/service.js";
import type { StackService, StackSnapshot } from "../src/stack.js";
import { SESSION_KEY, TEST_GATE, TOKEN, gateFor, testControl } from "./control-fixture.js";
import { brokenStore, testStore } from "./store-fixture.js";

/** A gate for `token` whose session key follows from it, so a dashboard under another token holds another session key. */
const gateOf = (token: string): Gate => gateFor(token, createHash("sha256").update(`session key of ${token}`).digest());

interface Res { status: number; headers: http.IncomingHttpHeaders; text: string }
/** A raw request, so `Cookie`, `Origin` and `Host` go out exactly as given (as a browser, or a client faking them, sends them). */
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

const listen = async (h: http.RequestListener): Promise<number> => {
  const s = http.createServer(h);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  after(() => { s.close(); s.closeAllConnections(); });
  return (s.address() as AddressInfo).port;
};

/** The cookie a 303 from `GET /unlock` sets, as a `Cookie` header value. */
const cookieOf = (r: Res): string => (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

/**
 * The normal dashboard on loopback whose gate accepts `token` (and sessions under the key that goes with it), over a store of
 * its own, with its unlock nonces and log exposed.
 */
async function normal(token: string = TOKEN, o: { links?: UnlockLinks } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-"));
  const st = await testStore({ token: false });
  after(() => st.close());
  const bus = new FakeBus();
  const links = o.links ?? new UnlockLinks();
  const rec = recordingLog();
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: st.store, root: st.root, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    uiDir: join(dir, "no-ui"), docsDir: join(dir, "no-docs"),
    unlock: links,
    control: testControl({ gate: gateOf(token) }),
  });
  const port = await listen(guardFullSurface(handler, { loopback: true }));
  const host = `127.0.0.1:${port}`;
  const same = { origin: `http://${host}` };
  const unlock = async (): Promise<string> => {
    const r = await call(port, "GET", `/unlock?n=${links.issue()}`);
    assert.equal(r.status, 303);
    return cookieOf(r);
  };
  return { port, host, same, links, bus, rec, unlock, secrets: () => st.store.secretValues() };
}

// @spec DASH-UNL-002
test("a nonce is accepted once, only within its 10 minutes, and at most 16 unused are kept", () => {
  let now = 0;
  const links = new UnlockLinks(() => now);
  const n = links.issue();
  assert.match(n, /^[A-Za-z0-9_-]{43}$/, "32 random bytes in base64url");
  assert.equal(links.consume(n), true);
  assert.equal(links.consume(n), false, "single use");
  const late = links.issue();
  now += 10 * 60_000 + 1;
  assert.equal(links.consume(late), false, "expired");
  const first = links.issue();
  for (let i = 0; i < 16; i++) links.issue();
  assert.equal(links.consume(first), false, "the oldest is dropped past 16");
  assert.equal(links.consume(null), false);
  assert.equal(links.consume("nope"), false);
});

// @spec DASH-UNL-005
test("a session is valid under the session key that made it and nothing else: a new key (mise run config:token) ends every session", () => {
  const s = newSession(SESSION_KEY);
  assert.match(s, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(sessionValid(SESSION_KEY, s), true);
  assert.equal(sessionValid(Buffer.alloc(32, 8), s), false);
  assert.equal(sessionValid(undefined, s), false, "no session key, no session");
  assert.equal(sessionValid(SESSION_KEY, `${s.split(".")[0]}.${"A".repeat(43)}`), false);
  assert.equal(sessionValid(SESSION_KEY, "garbage"), false);
  assert.equal(sessionValid(SESSION_KEY, undefined), false);
  assert.notEqual(newSession(SESSION_KEY), s, "a fresh id each time");
});

// @spec DASH-UNL-005, STORE-TOK-002, STORE-TOK-004
test("through the store's gate a session is made under the store's session key; setting the token replaces the key and ends every session", async () => {
  const st = await testStore();
  after(() => st.close());
  const gate = storeGate(st.store);
  const key = gate.sessionKey()!;
  assert.equal(key.length, 32);
  const s = newSession(key);
  assert.equal(sessionValid(gate.sessionKey(), s), true);
  st.store.setToken(TOKEN); // mise run config:token, even with the same token
  assert.notDeepEqual(gate.sessionKey(), key, "a new session key");
  assert.equal(sessionValid(gate.sessionKey(), s), false, "the old session is over");
});

// @spec DASH-UNL-001
test("the terminal line names the bound address, 127.0.0.1 for an unspecified one, an IPv6 one in brackets", () => {
  assert.equal(unlockLine(unlockBase("127.0.0.1", 3000), "abc"), "Unlock this browser: http://127.0.0.1:3000/unlock?n=abc");
  assert.equal(unlockBase("0.0.0.0", 3000), "http://127.0.0.1:3000");
  assert.equal(unlockBase("::", 3000), "http://127.0.0.1:3000");
  assert.equal(unlockBase("::1", 3000), "http://[::1]:3000");
  assert.equal(unlockBase("192.168.1.5", 3000), "http://192.168.1.5:3000");
});

// @spec DASH-UNL-003, DASH-UNL-004
test("GET /unlock consumes the nonce and sets the session cookie with HttpOnly, SameSite=Strict, Path=/ and a 90-day Max-Age, then redirects to /; a used or bad nonce is a static HTML page linking to / with no cookie", async () => {
  const t = await normal();
  const n = t.links.issue();
  const ok = await call(t.port, "GET", `/unlock?n=${n}`);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, "/", "no nonce in the final address");
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal(ok.headers["referrer-policy"], "no-referrer");
  const cookie = String(ok.headers["set-cookie"]?.[0]);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000$`));
  assert.doesNotMatch(cookie, /Secure/);
  for (const path of [`/unlock?n=${n}`, "/unlock?n=made-up", "/unlock", "/unlock?n=%3Cscript%3E"]) {
    const bad = await call(t.port, "GET", path);
    assert.equal(bad.status, 400, path);
    assert.equal(bad.headers["set-cookie"], undefined);
    assert.equal(bad.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(bad.headers["cache-control"], "no-store");
    assert.equal(bad.headers["referrer-policy"], "no-referrer");
    assert.equal(bad.text, BAD_LINK_PAGE, "static: the same bytes for every request, nothing from the request");
  }
  assert.match(BAD_LINK_PAGE, /mise run dashboard:unlock/);
  assert.match(BAD_LINK_PAGE, /restart the dashboard/);
  assert.match(BAD_LINK_PAGE, /<a href="\/">/, "links to / so an unlocked browser reaches the dashboard in one click");
  assert.match(BAD_LINK_PAGE, /not valid/);
  const foreign = await call(t.port, "GET", `/unlock?n=${t.links.issue()}`, { host: "evil.example" });
  assert.equal(foreign.status, 403, "the Host guard runs first");
});

// @spec CTRL-RUNTIME-017, DASH-UNL-005
test("the session key is random, never the ears listener key the token derives, so the listener key is never a session MAC key", async () => {
  const st = await testStore();
  after(() => st.close());
  const listener = st.store.earsListenerKey()!;
  assert.match(listener, /^[0-9a-f]{64}$/);
  assert.notEqual(st.store.sessionKey()!.toString("hex"), listener);
});

// @spec DASH-UNL-004
test("the link opened again in the browser it unlocked (a second click, a restored tab) goes on to / with no new cookie; without a valid cookie it stays the 400 page", async () => {
  const t = await normal();
  const n = t.links.issue();
  const first = await call(t.port, "GET", `/unlock?n=${n}`);
  assert.equal(first.status, 303);
  const cookie = cookieOf(first);
  for (const path of [`/unlock?n=${n}`, "/unlock?n=made-up", "/unlock"]) {
    const again = await call(t.port, "GET", path, { cookie });
    assert.equal(again.status, 303, path);
    assert.equal(again.headers.location, "/", "no nonce in the final address");
    assert.equal(again.headers["cache-control"], "no-store");
    assert.equal(again.headers["referrer-policy"], "no-referrer");
    assert.equal(again.headers["set-cookie"], undefined, "the browser keeps the session it holds");
  }
  const used = await call(t.port, "GET", `/unlock?n=${n}`);
  assert.equal(used.status, 400, "a used nonce with no cookie is the bad-link page");
  assert.equal(used.headers["set-cookie"], undefined);
  assert.equal(used.text, BAD_LINK_PAGE);
  const forged = await call(t.port, "GET", `/unlock?n=${n}`, { cookie: `${SESSION_COOKIE}=forged.value` });
  assert.equal(forged.status, 400, "a cookie that is no valid session does not count");
  const rotated = await normal("rotated-token-0123456789abcdef-012345");
  assert.equal((await call(rotated.port, "GET", `/unlock?n=${n}`, { cookie })).status, 400, "a session made under another session key does not count");
});

// @spec DASH-UNL-003, DASH-CTRL-007
test("after the link, a reload of / is the page with no nonce, and the page's GET /services/control reports unlocked from the cookie alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>cohost</title>");
  const links = new UnlockLinks();
  const handler = createDashboardHandler({
    bus: new FakeBus(), log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: {} as never, services: () => [],
    stack: { snapshot: () => ({ state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] }) } as unknown as StackService,
    uiDir: dir, docsDir: join(dir, "no-docs"), unlock: links, control: testControl(),
  });
  const port = await listen(guardFullSurface(handler, { loopback: true }));
  const got = await call(port, "GET", `/unlock?n=${links.issue()}`);
  assert.equal(got.status, 303);
  assert.equal(got.headers.location, "/");
  const cookie = cookieOf(got);
  // What the browser does on a reload, or after closing and restoring the tab: it asks for /, then the page asks the server.
  const page = await call(port, "GET", "/", { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>cohost<\/title>/);
  assert.equal(JSON.parse((await call(port, "GET", "/services/control", { cookie })).text).unlocked, true);
});

// @spec DASH-CTRL-011, DASH-UNL-005, DASH-SECRET-003, DASH-CTRL-004
test("with the session cookie and a same-origin Origin a mutation passes; without an Origin, with a foreign one, or with neither cookie nor token it is refused", async () => {
  const t = await normal();
  const cookie = await t.unlock();
  assert.equal((await call(t.port, "POST", "/control", { cookie, ...t.same }, { cmd: "mute" })).status, 204);
  const secret = await call(t.port, "PUT", "/secrets/llm.openai.api_key", { cookie, ...t.same }, { value: "sk-cookie" });
  assert.equal(secret.status, 200, secret.text);
  assert.equal(t.secrets()["llm.openai.api_key"], "sk-cookie");
  assert.equal((await call(t.port, "POST", "/control", { cookie }, { cmd: "mute" })).status, 401, "a cookie without an Origin does not count on a mutation");
  assert.equal((await call(t.port, "POST", "/control", { cookie, origin: "http://evil.example" }, { cmd: "mute" })).status, 403, "a foreign Origin is refused by the guard");
  // A program on this machine or a container through host.docker.internal: it sends any Host and no cookie.
  for (const headers of [{}, { host: "127.0.0.1" }, { host: "127.0.0.1", origin: "http://127.0.0.1" }] as Record<string, string>[]) {
    assert.equal((await call(t.port, "POST", "/control", headers, { cmd: "mute" })).status, 401, JSON.stringify(headers));
    assert.equal((await call(t.port, "PUT", "/secrets/llm.openai.api_key", headers, { value: "x" })).status, 401);
  }
  assert.equal((await call(t.port, "POST", "/control", { cookie: `${SESSION_COOKIE}=forged.value`, ...t.same }, { cmd: "mute" })).status, 401);
  assert.equal(t.bus.published.length, 1, "only the cookie-backed mute went out");
});

// @spec DASH-CTRL-011, DASH-ACC-004
test("a request carrying Authorization is judged by it alone: a mistyped token is refused in an unlocked browser, so the Access dialog never stores it", async () => {
  const t = await normal();
  const cookie = await t.unlock();
  assert.equal((await call(t.port, "PUT", "/secrets/access-check", { cookie, ...t.same, authorization: "Bearer typo" }, { value: null })).status, 401);
  assert.equal((await call(t.port, "PUT", "/secrets/access-check", { cookie, ...t.same, authorization: `Bearer ${TOKEN}` }, { value: null })).status, 404);
  assert.equal((await call(t.port, "PUT", "/secrets/access-check", { cookie, ...t.same }, { value: null })).status, 404, "the cookie alone passes the check");
});

// @spec DASH-CTRL-007, DASH-UNL-005
test("GET /services/control says whether the request carries a valid session; a cookie made under another session key is no session", async () => {
  const t = await normal();
  const cookie = await t.unlock();
  assert.equal(JSON.parse((await call(t.port, "GET", "/services/control", { cookie })).text).unlocked, true);
  assert.equal(JSON.parse((await call(t.port, "GET", "/services/control")).text).unlocked, false);
  const rotated = await normal("rotated-token-0123456789abcdef-012345");
  assert.equal(JSON.parse((await call(rotated.port, "GET", "/services/control", { cookie })).text).unlocked, false);
  assert.equal((await call(rotated.port, "POST", "/control", { cookie, origin: `http://${rotated.host}` }, { cmd: "mute" })).status, 401, "the old session is revoked");
});

// @spec DASH-CTRL-011
test("on a read the cookie counts with no Origin or a same-origin one", async () => {
  const value = newSession(SESSION_KEY);
  const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: "127.0.0.1:3000", cookie: `${SESSION_COOKIE}=${value}`, ...headers } }) as unknown as http.IncomingMessage;
  assert.equal(await authorized(TEST_GATE, req("GET", {})), "ok");
  assert.equal(await authorized(TEST_GATE, req("GET", { origin: "http://127.0.0.1:3000" })), "ok");
  assert.equal(await authorized(TEST_GATE, req("GET", { origin: "http://evil.example" })), "bad");
  assert.equal(await authorized(TEST_GATE, req("POST", {})), "bad");
  assert.equal(await authorized(TEST_GATE, req("POST", { origin: "http://127.0.0.1:3000" })), "ok");
  assert.equal(await authorized(TEST_GATE, req("POST", { origin: "http://127.0.0.1:3000", authorization: "Bearer typo" })), "bad", "an Authorization header is judged alone");
  assert.equal(await authorized(TEST_GATE, req("POST", { authorization: `Bearer ${TOKEN}` })), "ok");
  const busy: Gate = { verify: async () => "busy", sessionKey: () => SESSION_KEY };
  assert.equal(await authorized(busy, req("POST", { authorization: `Bearer ${TOKEN}` })), "busy", "the checker's busy answer is passed on (STORE-TOK-003)");
});

// @spec DASH-CTRL-011
test("a loopback peer lifts no gate: a request from 127.0.0.1 with neither the token nor a session is refused", async () => {
  const req = { method: "POST", headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as http.IncomingMessage;
  assert.equal(await authorized(TEST_GATE, req), "bad");
});

// @spec DASH-CTRL-011, STORE-TOK-003
test("through the store's gate the right bearer passes, a wrong one is 401, and a busy checker is 429 with retry-after: 1", async () => {
  const st = await testStore();
  after(() => st.close());
  const port = await listen(guardFullSurface(createDashboardHandler({
    bus: new FakeBus(), log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: st.store, root: st.root, services: () => [],
    stack: { snapshot: () => ({ state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] }) } as unknown as StackService,
    control: testControl({ gate: storeGate(st.store) }),
  }), { loopback: true }));
  assert.equal((await call(port, "POST", "/control", { authorization: `Bearer ${TOKEN}` }, { cmd: "mute" })).status, 204);
  const wrong = await call(port, "POST", "/control", { authorization: `Bearer ${TOKEN}-wrong` }, { cmd: "mute" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["www-authenticate"], "Bearer");
  const busyPort = await listen(guardFullSurface(createDashboardHandler({
    bus: new FakeBus(), log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    store: st.store, root: st.root, services: () => [],
    stack: { snapshot: () => ({ state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] }) } as unknown as StackService,
    control: testControl({ gate: storeGate({ checkBearer: async () => "busy", sessionKey: () => undefined }) }),
  }), { loopback: true }));
  for (const [method, path, body] of [["POST", "/control", { cmd: "mute" }], ["PUT", "/secrets/llm.openai.api_key", { value: "x" }], ["POST", "/unlock/link", {}]] as const) {
    const busy = await call(busyPort, method, path, { authorization: `Bearer ${TOKEN}` }, body);
    assert.equal(busy.status, 429, `${method} ${path}`);
    assert.equal(busy.headers["retry-after"], "1", `${method} ${path}`);
  }
  assert.deepEqual(st.store.secretPaths(), [], "nothing written while busy");
});

// @spec DASH-UNL-006
test("POST /unlock/link answers a fresh link through the one gate: the bearer token, or an unlocked browser's cookie on a same-origin request; otherwise 401", async () => {
  const t = await normal();
  const r = await call(t.port, "POST", "/unlock/link", { authorization: `Bearer ${TOKEN}` });
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  const { url } = JSON.parse(r.text) as { url: string };
  assert.match(url, new RegExp(`^http://${t.host.replace(/\./g, "\\.")}/unlock\\?n=[A-Za-z0-9_-]{43}$`));
  assert.equal((await call(t.port, "GET", new URL(url).pathname + new URL(url).search)).status, 303, "the link unlocks");
  const cookie = await t.unlock();
  const minted = await call(t.port, "POST", "/unlock/link", { cookie, ...t.same });
  assert.equal(minted.status, 200, "an unlocked browser may mint a link for another browser");
  assert.equal((await call(t.port, "GET", new URL((JSON.parse(minted.text) as { url: string }).url).pathname + new URL((JSON.parse(minted.text) as { url: string }).url).search)).status, 303);
  assert.equal((await call(t.port, "POST", "/unlock/link", { cookie })).status, 401, "a cookie without an Origin does not count on a POST");
  for (const headers of [{}, { authorization: "Bearer nope" }, { cookie, ...t.same, authorization: "Bearer nope" }] as Record<string, string>[]) {
    const refused = await call(t.port, "POST", "/unlock/link", headers);
    assert.equal(refused.status, 401, JSON.stringify(headers));
    assert.equal(refused.headers["www-authenticate"], "Bearer");
  }
  assert.ok(!JSON.stringify(t.rec.lines).includes("unlock?n="), "neither the nonce nor the link is logged");
});

/** Recovery mode over a store with invalid settings (the cause whose session key can be read), with its unlock nonces. */
async function recovery(o: Partial<RecoveryHandlerDeps> = {}) {
  const st = await brokenStore("invalid-settings");
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-rcv-"));
  const links = new UnlockLinks();
  const handler = createRecoveryHandler({ log: { info() {}, error() {} } as never, store: st.opts, uiDir: join(dir, "no-ui"), onValid: () => {}, unlock: links, ...o });
  const port = await listen(guardFullSurface(handler, { loopback: true }));
  const same = { origin: `http://127.0.0.1:${port}` };
  const state = async () => JSON.parse((await call(port, "GET", "/recovery")).text) as { etag: string; problems: RecoveryProblem[] };
  /** The stored llm section and the revision as text: unchanged text means nothing was written. */
  const snapshot = async () => {
    const { openStore } = await import("@cohost/store");
    const s = await openStore({ ...st.opts, keyOptional: true });
    try { return JSON.stringify({ revision: s.revision(), llm: s.sections()["llm"], secrets: s.secretPaths() }); } finally { s.close(); }
  };
  return { port, same, links, state, snapshot, st };
}

// @spec DASH-UNL-003, DASH-CTRL-011, DASH-RCV-003, DASH-RCV-010
test("recovery mode with invalid settings serves the unlock link, and its cookie counts for every recovery write", async () => {
  const r = await recovery();
  const got = await call(r.port, "GET", `/unlock?n=${r.links.issue()}`);
  assert.equal(got.status, 303);
  const cookie = cookieOf(got);
  assert.equal(JSON.parse((await call(r.port, "GET", "/services/control", { cookie })).text).unlocked, true);
  const s = await r.state();
  assert.equal((await call(r.port, "POST", "/recovery/set", {}, { etag: s.etag, path: "llm.temperature", value: "1" })).status, 401, "a set needs the token or a session");
  const set = await call(r.port, "POST", "/recovery/set", { cookie, ...r.same }, { etag: s.etag, path: "llm.temperature", value: "1" });
  assert.equal(set.status, 200, set.text);
  const etag = (JSON.parse(set.text) as { etag: string }).etag;
  const reset = await call(r.port, "POST", "/recovery/reset", { cookie, ...r.same }, { etag, path: "llm.retired_key" });
  assert.equal(reset.status, 200, reset.text);
  assert.equal((JSON.parse(reset.text) as { valid: boolean }).valid, true);
  assert.equal((await call(r.port, "POST", "/unlock/link", { authorization: `Bearer ${TOKEN}` })).status, 200);
});

// @spec DASH-RCV-003, DASH-RCV-007
test("no recovery write is exempt: set, reset, reset-all, restore, import, key and discard-credentials are each 401 {ok: false, detail} without the token or a cookie, writing nothing", async () => {
  const r = await recovery();
  const before = await r.snapshot();
  const s = await r.state();
  const ops: [string, unknown][] = [
    ["set", { etag: s.etag, path: "llm.temperature", value: "1" }],
    ["reset", { etag: s.etag, path: "llm.temperature" }],
    ["reset-all", { etag: s.etag }],
    ["restore", { backup: "cohost-20200101T000000Z.db" }],
    ["import", { text: "x" }],
    ["key", { recoveryKey: "x" }],
    ["discard-credentials", { confirm: "delete credentials" }],
  ];
  for (const [op, body] of ops) {
    for (const headers of [{}, { authorization: "Bearer wrong" }, { host: "127.0.0.1" }] as Record<string, string>[]) {
      const res = await call(r.port, "POST", `/recovery/${op}`, headers, body);
      assert.equal(res.status, 401, `${op} ${JSON.stringify(headers)}`);
      assert.equal(res.headers["www-authenticate"], "Bearer");
      const j = JSON.parse(res.text) as { ok: boolean; detail: string };
      assert.equal(j.ok, false);
      assert.equal(typeof j.detail, "string");
    }
  }
  assert.equal(await r.snapshot(), before);
});

// @spec DASH-RCV-007, DASH-RCV-003
test("reset-all through the gate repairs every failing key in one request, a sensitive key needing nothing more", async () => {
  const r = await recovery();
  const s = await r.state();
  const all = await call(r.port, "POST", "/recovery/reset-all", { authorization: `Bearer ${TOKEN}` }, { etag: s.etag });
  assert.equal(all.status, 200, all.text);
  const j = JSON.parse(all.text) as { ok: boolean; valid: boolean; etag: string; tokenNeeded?: unknown };
  assert.equal(j.ok, true);
  assert.equal(j.valid, true);
  assert.equal(j.etag, String(Number(s.etag) + 1), "one store write");
  assert.equal(j.tokenNeeded, undefined, "nothing waits for the token");
});

// @spec DASH-RCV-022, DASH-RCV-012, DASH-ACC-004
test("recovery answers the Access dialog's token check: 401 for a missing or wrong token, 404 otherwise, writing nothing", async () => {
  const cases: [Record<string, string>, number][] = [
    [{}, 401],
    [{ authorization: "Bearer wrong" }, 401],
    [{ host: "127.0.0.1" }, 401],
    [{ authorization: `Bearer ${TOKEN}` }, 404],
  ];
  const r = await recovery();
  const before = await r.snapshot();
  for (const [headers, status] of cases) {
    for (const path of ["/secrets/access-check", "/secrets/llm.openai.api_key"]) {
      const res = await call(r.port, "PUT", path, headers, { value: "sk-new" });
      assert.equal(res.status, status, `${JSON.stringify(headers)} ${path}`);
      const body = JSON.parse(res.text) as { ok: boolean; detail: string };
      assert.equal(body.ok, false);
      assert.doesNotMatch(res.text, /sk-new/, "no secret in any answer");
      if (status === 401) assert.equal(res.headers["www-authenticate"], "Bearer");
      if (status === 404) assert.equal(body.detail, "unknown secret");
    }
  }
  assert.equal(await r.snapshot(), before);
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

// @spec DASH-RCV-002, DASH-RCV-003, DASH-UNL-001, DASH-CTRL-007
test("runRecovery on DASHBOARD_HOST=0.0.0.0 with invalid settings: the token gates reset-all, the unlock line goes to the terminal printer only", async () => {
  const port = await freePort();
  const st = await brokenStore("invalid-settings", { edits: { dashboard: { port } } });
  const { checkStore } = await import("@cohost/store");
  const problems = await checkStore(st.opts);
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-run-"));
  const lines: string[] = [];
  const logged: string[] = [];
  const log = { info: (...a: unknown[]) => logged.push(JSON.stringify(a)), warn: (...a: unknown[]) => logged.push(JSON.stringify(a)), error: (...a: unknown[]) => logged.push(JSON.stringify(a)), fatal: (...a: unknown[]) => logged.push(JSON.stringify(a)) };
  const running = runRecovery({
    env: { DASHBOARD_HOST: "0.0.0.0" }, log, problems, store: st.opts, uiDir: join(dir, "no-ui"), signals: false, exit: () => {}, print: (l) => lines.push(l),
  });
  for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`^Unlock this browser: http://127\\.0\\.0\\.1:${port}/unlock\\?n=[A-Za-z0-9_-]{43}$`));
  const nonce = lines[0]!.split("n=")[1]!;
  assert.ok(!logged.some((l) => l.includes(nonce)), "the nonce never goes through the logger");
  const control = JSON.parse((await call(port, "GET", "/services/control")).text) as { enabled: boolean; unlocked: boolean };
  assert.deepEqual(control, { runtime: "compose", advanced: false, unlocked: false });
  const etag = (JSON.parse((await call(port, "GET", "/recovery")).text) as { etag: string }).etag;
  assert.equal((await call(port, "POST", "/recovery/reset-all", {}, { etag })).status, 401, "beyond loopback nothing is exempt");
  const fixed = await call(port, "POST", "/recovery/reset-all", { authorization: `Bearer ${TOKEN}` }, { etag });
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal((JSON.parse(fixed.text) as { valid: boolean }).valid, true);
  assert.equal(await running, true, "valid: recovery mode ends");
});

// @spec DASH-UNL-008, DASH-ACC-007
test("POST /unlock/forget expires the cookie with no token, behind the Origin guard", async () => {
  const t = await normal();
  const r = await call(t.port, "POST", "/unlock/forget", { ...t.same });
  assert.equal(r.status, 204);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(String(r.headers["set-cookie"]?.[0]), `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  assert.equal((await call(t.port, "POST", "/unlock/forget", { origin: "http://evil.example" })).status, 403, "another site cannot send it");
  assert.equal((await call(t.port, "POST", "/unlock/forget")).status, 204, "a client without an Origin may drop its own cookie");
});

// @spec DASH-UNL-006, DASH-UNL-001
test("POST /unlock/link builds its url from the bound address and port once they are known, whatever Host the request names", async () => {
  const links = new UnlockLinks();
  links.base = unlockBase("0.0.0.0", 4321);
  const t = await normal(TOKEN, { links });
  const r = await call(t.port, "POST", "/unlock/link", { authorization: `Bearer ${TOKEN}`, host: `localhost:${t.port}` });
  assert.equal(r.status, 200);
  assert.match((JSON.parse(r.text) as { url: string }).url, /^http:\/\/127\.0\.0\.1:4321\/unlock\?n=[A-Za-z0-9_-]{43}$/);
});

// @spec DASH-UNL-002, DASH-HTTP-004
test("a request that fails logs its path, never its query string: a throwing /unlock?n= leaves no nonce in the log", async () => {
  class Throwing extends UnlockLinks { override consume(): boolean { throw new Error("boom"); } }
  const t = await normal(TOKEN, { links: new Throwing() });
  const nonce = "SECRET-NONCE-1234567890";
  const r = await call(t.port, "GET", `/unlock?n=${nonce}`);
  assert.equal(r.status, 500);
  const logged = JSON.stringify(t.rec.lines, (_k, v: unknown) => (v instanceof Error ? { message: v.message } : v));
  assert.match(logged, /request failed/);
  assert.match(logged, /"path":"\/unlock"/);
  assert.ok(!logged.includes(nonce), logged);
});

// @spec DASH-CTRL-004, DASH-CTRL-011, DASH-CTRL-001, DASH-TOOL-002
test("every mutation needs the token or a session cookie, the stack routes included; no route answers 403 'not set up'", async () => {
  const t = await normal();
  const routes = [
    ["POST", "/control", { cmd: "mute" }], ["PUT", "/personality", "x"], ["POST", "/mouth/routing", { outputs: { obs: { enabled: true } } }],
    ["POST", "/inject/text", { level: "bus", text: "hi" }], ["POST", "/tools/answer", { id: "a", allow: true }],
    ["PUT", "/secrets/llm.openai.api_key", { value: "x" }], ["PUT", "/secrets", { values: { "llm.openai.api_key": "x" } }],
    ["PUT", "/config/cohost", { etag: "x", values: {} }], ["POST", "/stack/launch", {}], ["POST", "/services/cortex/stop", {}],
    ["POST", "/unlock/link", {}], ["GET", "/viewers", undefined],
  ] as const;
  for (const [method, path, body] of routes) {
    const res = await call(t.port, method, path, {}, body);
    assert.equal(res.status, 401, `${method} ${path}`);
    assert.equal(res.headers["www-authenticate"], "Bearer", `${method} ${path}`);
  }
  assert.equal(t.bus.published.length, 0);
  const cookie = await t.unlock();
  assert.equal((await call(t.port, "POST", "/control", { cookie, ...t.same }, { cmd: "mute" })).status, 204);
  assert.equal((await call(t.port, "POST", "/control", { authorization: `Bearer ${TOKEN}` }, { cmd: "unmute" })).status, 204);
});

// @spec DASH-CTRL-004, MOD-CFG-013
test("a ?dryRun=1 config check writes nothing and is not gated", async () => {
  const t = await normal();
  const etag = JSON.parse((await call(t.port, "GET", "/config/cohost")).text).etag as string;
  const dry = await call(t.port, "PUT", "/config/cohost?dryRun=1", {}, { etag, values: { name: "Mika" } });
  assert.equal(dry.status, 200, dry.text);
  assert.equal((JSON.parse(dry.text) as { dryRun?: boolean }).dryRun, true);
  assert.equal((await call(t.port, "PUT", "/config/cohost", {}, { etag, values: { name: "Mika" } })).status, 401);
});
