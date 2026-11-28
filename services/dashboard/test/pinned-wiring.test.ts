/**
 * The pinned unlock line and `--open` as the dashboard drives them, in normal mode and in config recovery mode: what it hands
 * the terminal and the opener, and what ends the pin. The terminal itself is `pinned-line.test.ts`'s.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import { checkStore } from "@cohost/store";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { StackService, StackOps } from "../src/stack.js";
import { dashboardService, storeGate } from "../src/service.js";
import { runRecovery, showUnlockLine } from "../src/recovery.js";
import { SESSION_COOKIE, UnlockLinks, newSession } from "../src/access.js";
import { firstOnly } from "../src/opener.js";
import { PinnedLine, type Renewal, type UnlockTerminal } from "../src/pinned-line.js";
import { fakeTerminal } from "./terminal-fixture.js";
import { brokenStore, testStore } from "./store-fixture.js";
import { AUTH } from "./control-fixture.js";

class DashBus extends FakeBus {
  stop(): void {}
  async recent(): Promise<never[]> { return []; }
  async tail(): Promise<void> {}
  async tailHealth(): Promise<void> {}
}

const idleStack = (s: StackService): void => {
  const ok = async () => ({ ok: true }) as never;
  const ops: StackOps = { status: async () => ({ docker: { ok: true }, services: [] }), launch: ok, rebuild: ok, stopAll: ok, restartAll: ok, consolidate: ok };
  s.attach(ops);
};

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A terminal that records what the dashboard hands it. */
function recordingTerminal() {
  const t = {
    shown: [] as { line: string; renewal: Renewal | undefined }[],
    releases: 0,
    checks: 0,
    pinned: false,
    show(line: string, renewal?: Renewal) { t.shown.push({ line, renewal }); t.pinned = true; },
    release() { t.releases++; t.pinned = false; },
    check() { t.checks++; },
  };
  return t satisfies UnlockTerminal;
}

const urlOf = (line: string): string => line.slice("Unlock this browser: ".length);

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); });
    req.on("error", reject);
    req.end();
  });
}

const text = async (port: number, path: string): Promise<string> => (await fetch(`http://127.0.0.1:${port}${path}`)).text();
const post = async (port: number, path: string, body: unknown): Promise<void> => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.text());
};

async function normal(o: { open?: boolean } = {}) {
  const dashboard = { port: await freePort(), lan_port: await freePort() };
  const bus = new DashBus();
  const rec = recordingLog();
  const st = await testStore();
  after(() => st.close());
  const terminal = recordingTerminal();
  const opened: { url: string; status: number }[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  const svc = dashboardService({
    store: st.store, root: st.root, redeliver: async () => ({ delivered: [], failures: [] }), terminal,
    env: {}, exit: () => {}, lanHost: "127.0.0.1", attachStack: idleStack,
    // The opener stands in for the browser: it opens the link, which shows the listener was bound when it was called.
    ...(o.open ? { open: (url: string) => { void get(dashboard.port, new URL(url).pathname + new URL(url).search).then((r) => opened.push({ url, status: r.status })); } } : {}),
  });
  await runService({
    service: "dashboard", health: svc.health, main: svc.main, loadConfig: () => testConfig({ dashboard }),
    createBus: () => bus as never, log: rec.log, onShutdown: (fn) => { shutdown = fn; }, exit: () => {},
  });
  after(async () => { await shutdown?.(); });
  await waitFor(() => terminal.shown.length > 0, "the unlock line");
  const session = `${SESSION_COOKIE}=${newSession(storeGate(st.store).sessionKey()!)}`;
  return { dashboard, terminal, opened, session };
}

// @spec DASH-UNL-009, DASH-UNL-011
test("normal mode hands the terminal the unlock line and a renewal that makes a working link every 10 minutes", async () => {
  const r = await normal();
  assert.equal(r.terminal.shown.length, 1);
  const { line, renewal } = r.terminal.shown[0]!;
  assert.match(line, /^Unlock this browser: http:\/\/127\.0\.0\.1:\d+\/unlock\?n=[A-Za-z0-9_-]{43}$/);
  assert.equal(renewal!.stale(), false, "a fresh link is not due");
  const fresh = renewal!.next();
  assert.notEqual(fresh, line);
  const u = new URL(urlOf(fresh));
  assert.equal((await get(r.dashboard.port, u.pathname + u.search)).status, 303, "the renewed link unlocks");
});

// @spec DASH-UNL-012
test("normal mode: a successful GET /unlock releases the pinned line", async () => {
  const r = await normal();
  const u = new URL(urlOf(r.terminal.shown[0]!.line));
  assert.equal(r.terminal.releases, 0);
  assert.equal((await get(r.dashboard.port, u.pathname + u.search)).status, 303);
  assert.equal(r.terminal.releases, 1);
});

// @spec DASH-UNL-012
test("normal mode: a request carrying a valid session cookie on the full surface releases the pinned line; on the LAN listener, or with a bad cookie, it does not", async () => {
  const r = await normal();
  await get(r.dashboard.lan_port, "/?sink=1", { cookie: r.session });
  await get(r.dashboard.port, "/services/control", { cookie: `${SESSION_COOKIE}=forged.value` });
  assert.equal(r.terminal.releases, 0);
  await get(r.dashboard.port, "/services/control", { cookie: r.session });
  assert.equal(r.terminal.releases, 1);
  await get(r.dashboard.port, "/services/control", { cookie: r.session });
  assert.equal(r.terminal.releases, 1, "once");
});

// @spec DASH-UNL-014
test("with --open the start link is handed to the opener once, after the listener is bound; without it nothing is opened", async () => {
  const r = await normal({ open: true });
  await waitFor(() => r.opened.length > 0, "the opener's request");
  assert.deepEqual(r.opened, [{ url: urlOf(r.terminal.shown[0]!.line), status: 303 }]);
  assert.equal(r.terminal.releases, 1, "the browser that opened it unlocked, which removes the pin");
});

async function recovery(cause: "invalid-settings" | "missing-key") {
  const port = await freePort();
  let key: Buffer | undefined;
  let recoveryKey = "";
  const st = await brokenStore(cause, { edits: { dashboard: { port } }, before: (s) => { key = s.sessionKey(); recoveryKey = s.recoveryKey(); } });
  const terminal = recordingTerminal();
  const opened: string[] = [];
  const running = runRecovery({
    env: {}, log: recordingLog().log, problems: await checkStore(st.opts), store: st.opts, signals: false, exit: () => {},
    uiDir: join(st.root, "ui"), terminal, open: (url) => { opened.push(url); },
  });
  await waitFor(() => terminal.shown.length > 0 || cause !== "invalid-settings", "the unlock line");
  for (let i = 0; i < 50; i++) { try { if ((await get(port, "/health")).status === 200) break; } catch { /* not yet */ } await new Promise((res) => setTimeout(res, 100)); }
  /** Leaves recovery mode as the owner would (Reset all with the token, or the recovery key back in the key file). */
  const finish = async (): Promise<void> => {
    if (cause === "invalid-settings") {
      const { etag } = JSON.parse(await text(port, "/recovery")) as { etag: string };
      await post(port, "/recovery/reset-all", { etag });
    } else {
      writeFileSync(st.opts.keyFile!, `${recoveryKey}\n`, { mode: 0o600 });
      await text(port, "/recovery");
    }
    assert.equal(await running, true);
  };
  return { port, terminal, opened, finish, session: key ? `${SESSION_COOKIE}=${newSession(key)}` : "" };
}

// @spec DASH-UNL-009, DASH-UNL-012, DASH-UNL-014
test("config recovery with invalid settings pins the line, opens it with --open, and releases it on a session cookie", async () => {
  const r = await recovery("invalid-settings");
  assert.equal(r.terminal.shown.length, 1);
  assert.equal(r.terminal.shown[0]!.renewal!.stale(), false);
  assert.deepEqual(r.opened, [urlOf(r.terminal.shown[0]!.line)]);
  await get(r.port, "/services/control", { cookie: r.session });
  assert.equal(r.terminal.releases, 1);
  await r.finish();
});

// @spec DASH-UNL-012
test("config recovery: a successful GET /unlock releases the pinned line", async () => {
  const r = await recovery("invalid-settings");
  const u = new URL(urlOf(r.terminal.shown[0]!.line));
  assert.equal((await get(r.port, u.pathname + u.search)).status, 303);
  assert.equal(r.terminal.releases, 1);
  await r.finish();
});

// @spec DASH-UNL-014
test("where no unlock line is written (a missing key) --open opens nothing", async () => {
  const r = await recovery("missing-key");
  assert.equal(r.terminal.shown.length, 0);
  assert.deepEqual(r.opened, []);
  await r.finish();
});

// @spec DASH-UNL-012
test("config recovery mode ending and closing its listener releases the pinned line", async () => {
  const r = await recovery("invalid-settings");
  assert.equal(r.terminal.releases, 0);
  await r.finish();
  assert.equal(r.terminal.releases, 1);
});

const BASE = "http://127.0.0.1:3000";

// @spec DASH-UNL-011
test("the pinned link is due by the wall clock the nonces use, 30 s before its 10 minutes end, suspend time included", () => {
  let now = 1_000_000;
  const links = new UnlockLinks(() => now);
  const terminal = recordingTerminal();
  showUnlockLine({ base: BASE, links, terminal, warn: () => {} });
  const renewal = terminal.shown[0]!.renewal!;
  assert.equal(renewal.stale(), false);
  now += 10 * 60_000 - 31_000; // a jump as after a suspend: no timer ran meanwhile
  assert.equal(renewal.stale(), false);
  now += 1_000;
  assert.equal(renewal.stale(), true);
  const fresh = renewal.next();
  assert.notEqual(fresh, terminal.shown[0]!.line);
  assert.equal(renewal.stale(), false, "the fresh nonce has its own 10 minutes");
  const n = new URL(fresh.slice("Unlock this browser: ".length)).searchParams.get("n");
  assert.equal(links.consume(n), true, "the fresh link works");
});

// @spec DASH-UNL-011
test("a pinned nonce dropped by the cap of 16 is due at once: each issue asks the terminal to check", () => {
  const links = new UnlockLinks();
  const terminal = recordingTerminal();
  showUnlockLine({ base: BASE, links, terminal, warn: () => {} });
  const renewal = terminal.shown[0]!.renewal!;
  for (let i = 0; i < 15; i++) links.issue();
  assert.equal(renewal.stale(), false, "16 unused: still held");
  const before = terminal.checks;
  links.issue();
  assert.ok(terminal.checks > before);
  assert.equal(renewal.stale(), true, "dropped");
  renewal.next();
  assert.equal(renewal.stale(), false);
});

// @spec DASH-UNL-014
test("--open opens the first unlock line of the process only: not the line normal mode writes after recovery, not a renewed line", () => {
  const opened: string[] = [];
  const open = firstOnly((url: string) => { opened.push(url); });
  const first = recordingTerminal();
  showUnlockLine({ base: BASE, links: new UnlockLinks(), terminal: first, open, warn: () => {} });
  first.shown[0]!.renewal!.next();
  const second = recordingTerminal();
  showUnlockLine({ base: "http://127.0.0.1:3001", links: new UnlockLinks(), terminal: second, open, warn: () => {} });
  assert.deepEqual(opened, [first.shown[0]!.line.slice("Unlock this browser: ".length)]);
});

// @spec DASH-UNL-011
test("a pinned nonce evicted by the cap is renewed exactly once in the terminal, and the new pinned nonce is held", () => {
  const links = new UnlockLinks();
  const t = fakeTerminal({ rows: 24, cols: 120 });
  const terminal = new PinnedLine(t.io);
  showUnlockLine({ base: BASE, links, terminal, warn: () => {} });
  const first = new URL(t.take().match(/http:\/\/\S+?n=[A-Za-z0-9_-]{43}/)![0]).searchParams.get("n")!;
  for (let i = 0; i < 16; i++) links.issue();
  assert.equal(links.expiresAt(first), undefined, "the first nonce was dropped");
  const painted = t.take().match(/n=[A-Za-z0-9_-]{43}/g) ?? [];
  assert.equal(painted.length, 1, "one fresh link painted");
  assert.notEqual(links.expiresAt(painted[0]!.slice(2)), undefined, "and its nonce is held");
});

// @spec DASH-UNL-011
test("renewing does not re-enter the terminal's check, even with a terminal that has no guard of its own", () => {
  const links = new UnlockLinks();
  let renewal: Renewal | undefined;
  let renewals = 0;
  const terminal: UnlockTerminal = {
    pinned: true,
    show: (_line, r) => { renewal = r; },
    release: () => {},
    check: () => { if (renewal?.stale()) { renewals++; renewal.next(); } },
  };
  showUnlockLine({ base: BASE, links, terminal, warn: () => {} });
  for (let i = 0; i < 16; i++) links.issue();
  assert.equal(renewals, 1);
  assert.equal(renewal!.stale(), false);
});
