import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { lanHandler } from "../src/host.js";
import type { StackService } from "../src/stack.js";

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders }

/** A stand-in upstream server that records every request and answers with `answer`. */
async function upstream(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => { hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers }); answer(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.closeAllConnections(); server.close(); });
  return { hits, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

async function boot(o: { tts?: string; ollama?: string; control?: boolean; timeoutMs?: number } = {}) {
  const bus = new FakeBus();
  const rec = recordingLog();
  const handler = createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [],
    stack: {} as unknown as StackService,
    options: { urls: { tts: () => o.tts ?? "http://127.0.0.1:1", ollama: () => o.ollama ?? "http://127.0.0.1:1" }, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) },
    ...(o.control ? { control: { token: "tok", runtime: "compose", advanced: false, controller: {} as never } } : {}),
  });
  const server = http.createServer(handler);
  const lan = http.createServer(lanHandler(handler));
  await Promise.all([server, lan].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  after(() => { server.close(); lan.close(); });
  const at = (s: http.Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  return { base: at(server), get: (p: string, init?: RequestInit) => fetch(at(server) + p, init), lanGet: (p: string) => fetch(at(lan) + p), logs: () => JSON.stringify(rec.lines) };
}

// @spec DASH-OPT-001
test("GET /options/voices fetches <tts>/v1/audio/voices and answers {voices} sorted without duplicates, no-store", async () => {
  const up = await upstream(json(200, { voices: ["bf_emma", "af_bella", "af_bella", "am_adam"] }));
  const t = await boot({ tts: up.url });
  const r = await t.get("/options/voices");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { voices: ["af_bella", "am_adam", "bf_emma"] });
  assert.deepEqual(up.hits.map((h) => `${h.method} ${h.url}`), ["GET /v1/audio/voices"]);
});

// @spec DASH-OPT-002
test("GET /options/models fetches <ollama>/api/tags and answers {models} with the names sorted", async () => {
  const up = await upstream(json(200, { models: [{ name: "qwen3:8b", size: 1 }, { name: "llama3.2:3b" }, { name: "nomic-embed-text:latest" }] }));
  const t = await boot({ ollama: up.url });
  const r = await t.get("/options/models");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), { models: ["llama3.2:3b", "nomic-embed-text:latest", "qwen3:8b"] });
  assert.deepEqual(up.hits.map((h) => `${h.method} ${h.url}`), ["GET /api/tags"]);
});

// @spec DASH-OPT-001, DASH-OPT-002, DASH-CTRL-005
test("both routes are ungated in both control modes", async () => {
  const tts = await upstream(json(200, { voices: ["a"] }));
  const ollama = await upstream(json(200, { models: [{ name: "m" }] }));
  for (const control of [true, false]) {
    const t = await boot({ tts: tts.url, ollama: ollama.url, control });
    assert.equal((await t.get("/options/voices")).status, 200);
    assert.equal((await t.get("/options/models")).status, 200);
  }
});

// @spec DASH-OPT-001, DASH-OPT-002
test("the upstream address is fixed: nothing in the request (query, headers, path) chooses or reaches another host or path, and the request's headers are not forwarded", async () => {
  const evil = await upstream(json(200, { voices: ["evil"], models: [{ name: "evil" }] }));
  const tts = await upstream(json(200, { voices: ["ok"] }));
  const ollama = await upstream(json(200, { models: [{ name: "ok" }] }));
  const t = await boot({ tts: tts.url, ollama: ollama.url });
  const q = encodeURIComponent(evil.url);
  const headers = { host: "evil.example", authorization: "Bearer secret-caller-token", cookie: "a=b", "x-forwarded-host": evil.url, origin: evil.url };
  for (const p of [`/options/voices?url=${q}&host=${q}`, `/options/voices?../../etc`]) {
    const r = await fetch(`${t.base}${p}`, { headers: { authorization: headers.authorization, cookie: headers.cookie, "x-forwarded-host": headers["x-forwarded-host"] } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { voices: ["ok"] });
  }
  assert.equal((await t.get(`/options/models?url=${q}`, { headers: { authorization: headers.authorization, cookie: headers.cookie } })).status, 200);
  assert.deepEqual(evil.hits, [], "the caller's address was never contacted");
  assert.deepEqual(tts.hits.map((h) => h.url), ["/v1/audio/voices", "/v1/audio/voices"], "no caller text reaches the upstream path");
  assert.deepEqual(ollama.hits.map((h) => h.url), ["/api/tags"]);
  for (const h of [...tts.hits, ...ollama.hits]) {
    assert.equal(h.headers.authorization, undefined);
    assert.equal(h.headers.cookie, undefined);
    assert.equal(h.headers["x-forwarded-host"], undefined);
  }
});

// @spec DASH-OPT-003, DASH-OPT-001
test("an unreachable backing server is 502 {ok:false, detail} naming the cause, not cached", async () => {
  // a port nothing listens on
  const gone = http.createServer();
  await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
  const closed = `http://127.0.0.1:${(gone.address() as { port: number }).port}`;
  await new Promise<void>((r) => gone.close(() => r()));
  const t = await boot({ tts: closed, ollama: closed });
  for (const [route, who] of [["/options/voices", /voice/i], ["/options/models", /ollama/i]] as const) {
    const r = await t.get(route);
    assert.equal(r.status, 502, route);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const j = (await r.json()) as { ok: boolean; detail: string };
    assert.equal(j.ok, false);
    assert.match(j.detail, who);
    assert.match(j.detail, /unreachable|not reachable|reach/i);
  }
});

// @spec DASH-OPT-003
test("a non-2xx answer is 502 naming the status and not the upstream's text, and is not retried; a redirect is not followed", async () => {
  const LEAK = "UPSTREAM-STACKTRACE-/srv/kokoro/secret.py";
  const bad = await upstream(json(503, `{"error":"${LEAK}"}`));
  const target = await upstream(json(200, { voices: ["x"] }));
  const redirect = await upstream((_q, res) => { res.writeHead(302, { location: `${target.url}/v1/audio/voices` }); res.end(); });
  const t = await boot({ tts: bad.url, ollama: redirect.url });
  const r = await t.get("/options/voices");
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.ok(!text.includes(LEAK) && !text.includes("kokoro"), text);
  assert.match((JSON.parse(text) as { detail: string }).detail, /503/);
  assert.equal(bad.hits.length, 1, "not retried");
  const r2 = await t.get("/options/models");
  assert.equal(r2.status, 502);
  assert.deepEqual(target.hits, [], "the redirect target was never contacted");
});

// @spec DASH-OPT-003
test("a body of another shape is 502 without echoing it", async () => {
  const LEAK = "ECHO-ME-NOT";
  const bodies: [string, unknown][] = [
    ["not json", `<html>${LEAK}</html>`], ["empty", ""], ["array", [LEAK]], ["null", null], ["no voices", { other: LEAK }], ["voices not an array", { voices: LEAK }],
    ["voice not a string", { voices: ["a", 5] }], ["voice object", { voices: [{ id: LEAK }] }],
  ];
  for (const [name, b] of bodies) {
    const up = await upstream(json(200, typeof b === "string" ? b : JSON.stringify(b)));
    const t = await boot({ tts: up.url });
    const r = await t.get("/options/voices");
    assert.equal(r.status, 502, name);
    const text = await r.text();
    assert.ok(!text.includes(LEAK), `${name}: ${text}`);
    assert.ok(!t.logs().includes(LEAK), `${name}: logged`);
  }
  const models: [string, unknown][] = [
    ["no models", { x: 1 }], ["models not an array", { models: "m" }], ["entry without name", { models: [{ model: "m" }] }], ["name not a string", { models: [{ name: 5 }] }],
    ["entry a string", { models: ["m"] }], ["top-level array", [{ name: "m" }]],
  ];
  for (const [name, b] of models) {
    const up = await upstream(json(200, JSON.stringify(b)));
    const t = await boot({ ollama: up.url });
    assert.equal((await t.get("/options/models")).status, 502, name);
  }
});

// @spec DASH-OPT-004
test("an answer over 1 MiB is 502, whether it is declared or streamed; one just under is served", async () => {
  const big = await upstream((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ voices: ["v".repeat(1024 * 1024 + 10)] })); });
  const streamed = await upstream((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"voices":["'); const chunk = "v".repeat(64 * 1024); let n = 0; const tick = () => { if (res.destroyed) return; if (n++ < 40) { res.write(chunk); setImmediate(tick); } else res.end('"]}'); }; tick(); });
  const t = await boot({ tts: big.url, ollama: streamed.url });
  const a = await t.get("/options/voices");
  assert.equal(a.status, 502);
  assert.match(((await a.json()) as { detail: string }).detail, /1 MiB/);
  const stream = await boot({ tts: streamed.url });
  assert.equal((await stream.get("/options/voices")).status, 502);
  const pad = "v".repeat(1024 * 1024 - 64);
  const fits = await upstream(json(200, { voices: [pad] }));
  assert.equal((await (await boot({ tts: fits.url })).get("/options/voices")).status, 200);
});

// @spec DASH-OPT-003
test("an upstream that does not answer within the timeout is 502 naming the timeout", async () => {
  const hang = await upstream(() => { /* never answers */ });
  const slowBody = await upstream((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"voices":['); /* never ends */ });
  const t = await boot({ tts: hang.url, ollama: slowBody.url, timeoutMs: 150 });
  const started = Date.now();
  const r = await t.get("/options/voices");
  assert.equal(r.status, 502);
  assert.match(((await r.json()) as { detail: string }).detail, /did not answer|timed out|within/i);
  assert.ok(Date.now() - started < 2000);
  const r2 = await (await boot({ tts: slowBody.url, timeoutMs: 150 })).get("/options/voices");
  assert.equal(r2.status, 502, "a body that stalls is cut off too");
});

// @spec DASH-OPT-003
test("the default timeout is 3 s", async () => {
  const mod = await import("../src/options.js");
  assert.equal(mod.OPTIONS_TIMEOUT_MS, 3000);
  assert.equal(mod.OPTIONS_MAX_BYTES, 1024 * 1024);
});

// @spec DASH-OPT-004
test("the pick-list routes are not served on the LAN listener, and only GET is served on the full surface", async () => {
  const up = await upstream(json(200, { voices: ["a"], models: [{ name: "m" }] }));
  const t = await boot({ tts: up.url, ollama: up.url });
  assert.equal((await t.lanGet("/options/voices")).status, 404);
  assert.equal((await t.lanGet("/options/models")).status, 404);
  assert.deepEqual(up.hits, []);
  for (const m of ["POST", "PUT", "DELETE"]) assert.equal((await t.get("/options/voices", { method: m })).status, 404, m);
  assert.equal((await t.get("/options/other")).status, 404);
  assert.equal((await t.get("/options/")).status, 404);
  assert.deepEqual(up.hits, []);
});
