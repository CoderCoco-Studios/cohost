import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { createRecoveryHandler, runRecovery, type RecoveryHandlerDeps, type RecoveryProblem } from "../src/recovery.js";
import { guardFullSurface } from "../src/host.js";
import { BAD_LINK_PAGE, SESSION_COOKIE, SESSION_LABEL, UnlockLinks, authorized, newSession, sessionValid, unlockBase, unlockLine } from "../src/access.js";
import { EARS_LISTENER_LABEL } from "@cohost/control";
import type { StackService, StackSnapshot } from "../src/stack.js";
import { EXAMPLE } from "./config-fixture.js";
import { TOKEN, testControl } from "./control-fixture.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

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
 * The normal dashboard on loopback with `token` as CONTROL_TOKEN, with its unlock nonces and log
 * exposed.
 */
async function normal(token: string = TOKEN, o: { links?: UnlockLinks } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, EXAMPLE);
  const bus = new FakeBus();
  const links = o.links ?? new UnlockLinks();
  const rec = recordingLog();
  const snap: StackSnapshot = { state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [] };
  const handler = createDashboardHandler({
    bus, log: rec.log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: { snapshot: () => snap } as unknown as StackService,
    configFile: () => configFile, secretsFile: () => secretsFile, uiDir: join(dir, "no-ui"), docsDir: join(dir, "no-docs"),
    unlock: links,
    control: testControl({ token }),
  });
  const port = await listen(guardFullSurface(handler, { loopback: true }));
  const host = `127.0.0.1:${port}`;
  const same = { origin: `http://${host}` };
  const unlock = async (): Promise<string> => {
    const r = await call(port, "GET", `/unlock?n=${links.issue()}`);
    assert.equal(r.status, 303);
    return cookieOf(r);
  };
  return { port, host, same, links, bus, rec, unlock, secrets: () => { try { return readFileSync(secretsFile, "utf8"); } catch { return ""; } } };
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
test("a session is valid under the token that made it and nothing else: changing CONTROL_TOKEN ends every session", () => {
  const s = newSession(TOKEN);
  assert.match(s, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(sessionValid(TOKEN, s), true);
  assert.equal(sessionValid("rotated", s), false);
  assert.equal(sessionValid(TOKEN, `${s.split(".")[0]}.${"A".repeat(43)}`), false);
  assert.equal(sessionValid(TOKEN, "garbage"), false);
  assert.equal(sessionValid(TOKEN, undefined), false);
  assert.notEqual(newSession(TOKEN), s, "a fresh id each time");
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
test("the ears listener key's label differs from the session-key label, so the listener key is never a session MAC key", () => {
  assert.equal(SESSION_LABEL, "cohost dashboard session");
  assert.notEqual(EARS_LISTENER_LABEL, SESSION_LABEL);
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
  const rotated = await normal("rotated-token");
  assert.equal((await call(rotated.port, "GET", `/unlock?n=${n}`, { cookie })).status, 400, "a session made under another token does not count");
});

// @spec DASH-UNL-003, DASH-CTRL-007
test("after the link, a reload of / is the page with no nonce, and the page's GET /services/control reports unlocked from the cookie alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-ui-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>cohost</title>");
  const links = new UnlockLinks();
  const handler = createDashboardHandler({
    bus: new FakeBus(), log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
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
  assert.match(t.secrets(), /sk-cookie/);
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
test("GET /services/control says whether the request carries a valid session; a cookie made under another token is no session", async () => {
  const t = await normal();
  const cookie = await t.unlock();
  assert.equal(JSON.parse((await call(t.port, "GET", "/services/control", { cookie })).text).unlocked, true);
  assert.equal(JSON.parse((await call(t.port, "GET", "/services/control")).text).unlocked, false);
  const rotated = await normal("rotated-token");
  assert.equal(JSON.parse((await call(rotated.port, "GET", "/services/control", { cookie })).text).unlocked, false);
  assert.equal((await call(rotated.port, "POST", "/control", { cookie, origin: `http://${rotated.host}` }, { cmd: "mute" })).status, 401, "the old session is revoked");
});

// @spec DASH-CTRL-011
test("on a read the cookie counts with no Origin or a same-origin one", () => {
  const value = newSession(TOKEN);
  const req = (method: string, headers: Record<string, string>) => ({ method, headers: { host: "127.0.0.1:3000", cookie: `${SESSION_COOKIE}=${value}`, ...headers } }) as unknown as http.IncomingMessage;
  assert.equal(authorized(TOKEN, req("GET", {})), true);
  assert.equal(authorized(TOKEN, req("GET", { origin: "http://127.0.0.1:3000" })), true);
  assert.equal(authorized(TOKEN, req("GET", { origin: "http://evil.example" })), false);
  assert.equal(authorized(TOKEN, req("POST", {})), false);
  assert.equal(authorized(TOKEN, req("POST", { origin: "http://127.0.0.1:3000" })), true);
  assert.equal(authorized(TOKEN, req("POST", { origin: "http://127.0.0.1:3000", authorization: "Bearer typo" })), false, "an Authorization header is judged alone");
  assert.equal(authorized(TOKEN, req("POST", { authorization: `Bearer ${TOKEN}` })), true);
});

// @spec DASH-CTRL-011
test("a loopback peer lifts no gate: a request from 127.0.0.1 with neither the token nor a session is refused", () => {
  const req = { method: "POST", headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "127.0.0.1" } } as unknown as http.IncomingMessage;
  assert.equal(authorized(TOKEN, req), false);
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

/** A config.yaml from the `${VAR}` era: placeholders with fallbacks, one without, and a secrets.yaml value to quote. */
const STALE = EXAMPLE
  .replace(/^ {2}name: "Coco"/m, '  name: "${COHOST_NAME:-Mika}"')
  .replace(/^ {2}provider: "ollama"/m, '  provider: "${LLM_PROVIDER:-openai}"');
const BAD_SECRETS = "llm:\n  openai:\n    api_key: 0123\n";

async function recovery(o: Partial<RecoveryHandlerDeps> & { text?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-rcv-"));
  const configFile = join(dir, "config.yaml");
  const secretsFile = join(dir, "secrets.yaml");
  writeFileSync(configFile, o.text ?? STALE);
  writeFileSync(secretsFile, BAD_SECRETS, { mode: 0o600 });
  const links = new UnlockLinks();
  const handler = createRecoveryHandler({ log: { info() {}, error() {} } as never, files: { configFile, secretsFile }, controlToken: TOKEN, uiDir: join(dir, "no-ui"), onValid: () => {}, unlock: links, ...o });
  const port = await listen(guardFullSurface(handler, { loopback: true }));
  const same = { origin: `http://127.0.0.1:${port}` };
  const state = async () => JSON.parse((await call(port, "GET", "/recovery")).text) as { etag: string; problems: RecoveryProblem[] };
  return { port, same, links, configFile, secretsFile, state, config: () => readFileSync(configFile, "utf8"), secrets: () => readFileSync(secretsFile, "utf8") };
}

// @spec DASH-UNL-003, DASH-CTRL-011, DASH-RCV-003, DASH-RCV-010
test("recovery mode serves the unlock link, and its cookie counts for every recovery write and the raw read", async () => {
  const r = await recovery();
  const got = await call(r.port, "GET", `/unlock?n=${r.links.issue()}`);
  assert.equal(got.status, 303);
  const cookie = cookieOf(got);
  assert.equal(JSON.parse((await call(r.port, "GET", "/services/control", { cookie })).text).unlocked, true);
  const s = await r.state();
  assert.equal((await call(r.port, "POST", "/recovery/set", {}, { etag: s.etag, path: "cohost.name", value: "Coco" })).status, 401, "control on: a set needs the token");
  const set = await call(r.port, "POST", "/recovery/set", { cookie, ...r.same }, { etag: s.etag, path: "cohost.name", value: "Coco" });
  assert.equal(set.status, 200, set.text);
  const reset = await call(r.port, "POST", "/recovery/reset", { cookie, ...r.same }, { etag: sha(r.config()), path: "llm.openai.api_key" });
  assert.equal(reset.status, 200, reset.text);
  assert.match(r.secrets(), /api_key: "0123"/);
  assert.equal((await call(r.port, "POST", "/unlock/link", { authorization: `Bearer ${TOKEN}` })).status, 200);
});

// @spec DASH-RCV-003, DASH-RCV-007, DASH-RCV-023
test("no recovery write is exempt: set, reset (either file), fallback, reset-all and raw are each 401 {ok: false, detail} without the token or a cookie, writing nothing", async () => {
  const r = await recovery();
  const s = await r.state();
  const ops: [string, unknown][] = [
    ["set", { etag: s.etag, path: "cohost.name", value: "X" }],
    ["reset", { etag: s.etag, path: "cohost.name" }],
    ["reset", { etag: s.etag, path: "llm.openai.api_key" }],
    ["fallback", { etag: s.etag, path: "llm.provider" }],
    ["reset-all", { etag: s.etag }],
    ["raw", { file: "config", etag: s.etag, text: "x: 1\n" }],
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
  assert.equal(r.config(), STALE);
  assert.equal(r.secrets(), BAD_SECRETS);
});

// @spec DASH-RCV-007, DASH-RCV-003
test("reset-all through the gate repairs config.yaml and the secrets.yaml problems in one request, a sensitive key needing nothing more", async () => {
  const r = await recovery();
  const s = await r.state();
  const all = await call(r.port, "POST", "/recovery/reset-all", { authorization: `Bearer ${TOKEN}` }, { etag: s.etag });
  assert.equal(all.status, 200, all.text);
  const j = JSON.parse(all.text) as { ok: boolean; tokenNeeded?: unknown };
  assert.equal(j.ok, true);
  assert.equal(j.tokenNeeded, undefined, "nothing waits for the token");
  assert.match(r.secrets(), /api_key: "0123"/, "the secrets.yaml problem is repaired too");
  assert.match(r.config(), /^ {2}provider: "?openai"?/m);
});

// @spec DASH-RCV-023
test("the fallback route writes the problem's own fallback, never a value from the request; another path is 400 and a stale etag 409", async () => {
  const r = await recovery();
  const auth = { authorization: `Bearer ${TOKEN}` };
  const s = await r.state();
  const before = r.config();
  const stale = await call(r.port, "POST", "/recovery/fallback", auth, { etag: "0".repeat(64), path: "cohost.name" });
  assert.equal(stale.status, 409);
  assert.equal((JSON.parse(stale.text) as { etag: string }).etag, s.etag);
  for (const path of ["llm.model", "cohost.timezone", "nope", "llm.openai.api_key"]) {
    const res = await call(r.port, "POST", "/recovery/fallback", auth, { etag: s.etag, path });
    assert.equal(res.status, 400, path);
  }
  assert.equal(r.config(), before);
  const res = await call(r.port, "POST", "/recovery/fallback", auth, { etag: s.etag, path: "cohost.name", value: "Evil" });
  assert.equal(res.status, 200);
  assert.match(r.config(), /^ {2}name: "?Mika"?/m);
  assert.doesNotMatch(r.config(), /Evil/);
});

// @spec DASH-RCV-022, DASH-RCV-012, DASH-ACC-004
test("recovery answers the Access dialog's token check: 401 for a missing or wrong token, 404 otherwise, writing nothing", async () => {
  const cases: [Partial<RecoveryHandlerDeps>, Record<string, string>, number][] = [
    [{}, {}, 401],
    [{}, { authorization: "Bearer wrong" }, 401],
    [{}, { host: "127.0.0.1" }, 401],
    [{}, { authorization: `Bearer ${TOKEN}` }, 404],
  ];
  for (const [deps, headers, status] of cases) {
    const r = await recovery(deps);
    const mtimes = [statSync(r.configFile).mtimeMs, statSync(r.secretsFile).mtimeMs];
    const before = { c: r.config(), s: r.secrets() };
    for (const path of ["/secrets/access-check", "/secrets/llm.openai.api_key"]) {
      const res = await call(r.port, "PUT", path, headers, { value: "sk-new" });
      assert.equal(res.status, status, `${JSON.stringify(deps)} ${JSON.stringify(headers)} ${path}`);
      const body = JSON.parse(res.text) as { ok: boolean; detail: string };
      assert.equal(body.ok, false);
      assert.doesNotMatch(res.text, /0123|sk-new/, "no secret in any answer");
      if (status === 401) assert.equal(res.headers["www-authenticate"], "Bearer");
      if (status === 404) assert.equal(body.detail, "unknown secret");
    }
    assert.deepEqual({ c: r.config(), s: r.secrets() }, before);
    assert.deepEqual([statSync(r.configFile).mtimeMs, statSync(r.secretsFile).mtimeMs], mtimes);
  }
});

// @spec DASH-RCV-002, DASH-RCV-003, DASH-UNL-001, DASH-CTRL-007
test("runRecovery on DASHBOARD_HOST=0.0.0.0 with control on: the token gates reset-all, the unlock line goes to the terminal printer only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unlock-run-"));
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const configFile = join(dir, "config.yaml");
  writeFileSync(configFile, STALE.replace(/^ {2}port: 3000/m, `  port: ${port}`));
  const lines: string[] = [];
  const logged: string[] = [];
  const log = { info: (...a: unknown[]) => logged.push(JSON.stringify(a)), error: (...a: unknown[]) => logged.push(JSON.stringify(a)), fatal: (...a: unknown[]) => logged.push(JSON.stringify(a)) };
  const running = runRecovery({
    env: { DASHBOARD_HOST: "0.0.0.0", CONTROL_TOKEN: TOKEN }, log, error: { problems: [] } as never,
    files: { configFile, secretsFile: join(dir, "secrets.yaml") }, uiDir: join(dir, "no-ui"), signals: false, exit: () => {}, print: (l) => lines.push(l),
  });
  for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, new RegExp(`^Unlock this browser: http://127\\.0\\.0\\.1:${port}/unlock\\?n=[A-Za-z0-9_-]{43}$`));
  const nonce = lines[0]!.split("n=")[1]!;
  assert.ok(!logged.some((l) => l.includes(nonce)), "the nonce never goes through the logger");
  const control = JSON.parse((await call(port, "GET", "/services/control")).text) as { enabled: boolean; unlocked: boolean };
  assert.deepEqual(control, { runtime: "compose", advanced: false, unlocked: false });
  const etag = sha(readFileSync(configFile, "utf8"));
  assert.equal((await call(port, "POST", "/recovery/reset-all", {}, { etag })).status, 401, "beyond loopback nothing is exempt");
  assert.equal((await call(port, "POST", "/recovery/fallback", {}, { etag, path: "cohost.name" })).status, 401);
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
