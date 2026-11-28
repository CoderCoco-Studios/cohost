import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { checkStore } from "@cohost/store";
import { runRecovery } from "../src/recovery.js";
import { brokenStore, dbState, rawSection, storedSection } from "./store-fixture.js";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

const logger = () => {
  const lines: string[] = [];
  const at = (level: string) => (...a: unknown[]) => { lines.push(`${level} ${a.map((x) => (typeof x === "string" ? x : "")).join(" ").trim()}`); };
  return { lines, log: { info: at("info"), warn: at("warn"), error: at("error"), fatal: at("fatal") } };
};

/** One raw request, so the Host header can be anything. */
const request = (port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path, headers: o.headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(o.body);
  });

// @spec DASH-RCV-001, DASH-RCV-002, DASH-RCV-003
test("the recovery listener applies the Host and Origin rules: a foreign Host is a 403, a foreign Origin on a write is a 403 and writes nothing", { timeout: 20_000 }, async () => {
  const port = await freePort();
  let llm: Record<string, unknown> = {};
  const st = await brokenStore("invalid-settings", { edits: { dashboard: { port } }, before: (s) => { llm = storedSection(s, "llm"); } });
  const problems = await checkStore(st.opts);
  const { log, lines } = logger();
  const exits: number[] = [];
  const running = runRecovery({ env: {}, log, problems, store: st.opts, exit: (c) => exits.push(c), signals: false, uiDir: join(st.root, "ui"), print: () => {} });
  try {
    for (let i = 0; i < 50 && !lines.some((l) => l.startsWith("error config recovery mode:")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(lines.some((l) => l === `error config recovery mode: invalid settings, 2 problems; fix them at http://127.0.0.1:${port}`), lines.join("\n"));
    assert.equal(await request(port, { path: "/recovery", headers: { host: `127.0.0.1:${port}` } }), 200);
    assert.equal(await request(port, { path: "/recovery", headers: { host: "evil.example" } }), 403);
    const before = dbState(st.opts.dataDir!);
    const etag = ((await (await fetch(`http://127.0.0.1:${port}/recovery`)).json()) as { etag: string }).etag;
    const body = JSON.stringify({ etag });
    assert.equal(await request(port, { method: "POST", path: "/recovery/reset-all", body, headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example", "content-type": "application/json" } }), 403);
    assert.equal(dbState(st.opts.dataDir!), before, "a refused write writes nothing");
    assert.deepEqual(exits, []);
  } finally {
    rawSection(st.opts.dataDir!, "llm", llm); // fixed outside the page
    await fetch(`http://127.0.0.1:${port}/recovery`);
    assert.equal(await running, true);
  }
});

// @spec DASH-RCV-002
test("a recovery port that is taken is logged at fatal and exits 1", { timeout: 20_000 }, async () => {
  const busy = net.createServer();
  await new Promise<void>((r) => busy.listen(0, "127.0.0.1", r));
  const port = (busy.address() as net.AddressInfo).port;
  try {
    const st = await brokenStore("invalid-settings", { edits: { dashboard: { port } } });
    const { log, lines } = logger();
    const exits: number[] = [];
    const ok = await runRecovery({ env: {}, log, problems: await checkStore(st.opts), store: st.opts, exit: (c) => exits.push(c), signals: false, print: () => {} });
    assert.equal(ok, false);
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => l.startsWith(`fatal dashboard cannot listen on 127.0.0.1:${port} (config recovery)`)), lines.join("\n"));
    assert.ok(!lines.some((l) => l.includes("could not be used")), "the port came from the store");
  } finally { busy.close(); }
});

// @spec DASH-RCV-002
test("a taken default port, used because the stored dashboard section could not be read, is named as such in the fatal line", { timeout: 20_000 }, async (t) => {
  const busy = net.createServer();
  // Port 3000 is the default. When something else holds it, that holder may let go at any moment and the recovery listener
  // would then bind and wait for a usable store, so the case is skipped rather than run against a port it does not own.
  const held = await new Promise<boolean>((r) => { busy.once("error", () => r(false)); busy.listen(3000, "127.0.0.1", () => r(true)); });
  if (!held) { t.skip("port 3000 is in use"); return; }
  try {
    const st = await brokenStore("damaged-store");
    const { log, lines } = logger();
    const exits: number[] = [];
    const ok = await runRecovery({ env: {}, log, problems: await checkStore(st.opts), store: st.opts, exit: (c) => exits.push(c), signals: false, print: () => {} });
    assert.equal(ok, false);
    assert.deepEqual(exits, [1]);
    const fatal = lines.find((l) => l.startsWith("fatal dashboard cannot listen on 127.0.0.1:3000 (config recovery)"));
    assert.ok(fatal, lines.join("\n"));
    assert.match(fatal, /the stored dashboard section could not be used, so the default port 3000 was used: free that port/);
  } finally { busy.close(); }
});
