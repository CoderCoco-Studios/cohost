import { test, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, recordingLog } from "@cohost/testing";
import { HealthTracker } from "@cohost/control";
import { personalityUnits, projectionDir, projectionsDir } from "@cohost/store";
import { createDashboardHandler } from "../src/routes.js";
import { AUTH, testControl } from "./control-fixture.js";
import { testStore } from "./store-fixture.js";
import { StackService } from "../src/stack.js";

// The voice service the dashboard proxies audio from.
const voice = http.createServer((req, res) => {
  if (req.url === "/audio/a1.wav") { res.writeHead(200, { "content-type": "audio/wav" }); res.end("RIFFDATA"); return; }
  // Promises 100 bytes, sends 3, then drops the connection: the body read fails after the status line arrived.
  if (req.url === "/audio/cut.wav") { res.writeHead(200, { "content-type": "audio/wav", "content-length": "100" }); res.write("abc"); setTimeout(() => res.destroy(), 20); return; }
  res.writeHead(404); res.end("gone");
});
await new Promise<void>((r) => voice.listen(0, r));
after(() => voice.close());

// A built UI the handler serves: index.html with the name placeholder, one asset.
const uiDir = mkdtempSync(join(tmpdir(), "dash-routes-ui-"));
mkdirSync(join(uiDir, "assets"));
writeFileSync(join(uiDir, "index.html"), "<title>__COHOST_NAME__ dashboard</title><h1>__COHOST_NAME__</h1>");
writeFileSync(join(uiDir, "assets", "app-1.js"), "x");
after(() => rmSync(uiDir, { recursive: true, force: true }));

const bus = new FakeBus();
const tracker = new HealthTracker();
const rec = recordingLog();
const st = await testStore();
after(() => st.close());
assert.equal(st.store.write({ personality: "# Coco\n" }).ok, true);
const personality = (): string | undefined => st.store.personality();
const server = http.createServer(createDashboardHandler({
  bus, log: rec.log,
  uiDir,
  cohostName: "Coco",
  voiceUrl: `http://127.0.0.1:${(voice.address() as { port: number }).port}`,
  store: st.store,
  root: st.root,
  services: () => tracker.snapshot(),
  stack: new StackService({ log: rec.log, bus: () => "connected" }),
  control: testControl(),
}));
await new Promise<void>((r) => server.listen(0, r));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (path: string, body: unknown, method = "POST") => fetch(`${base}${path}`, { method, headers: AUTH, body: typeof body === "string" ? body : JSON.stringify(body) });

// @spec DASH-HTTP-001
test("GET / serves the page with every occurrence of the co-host's name filled in", async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  assert.equal(await r.text(), "<title>Coco dashboard</title><h1>Coco</h1>");
});

// @spec DASH-BUILD-003, DASH-CTRL-005
test("the UI's files are served by the handler, ungated", async () => {
  const r = await fetch(`${base}/assets/app-1.js`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
});

// @spec DASH-SINK-001
test("GET /audio/* proxies the voice service, passing its status through, uncached", async () => {
  const ok = await fetch(`${base}/audio/a1.wav`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/wav");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(await ok.text(), "RIFFDATA");
  assert.equal((await fetch(`${base}/audio/missing.wav`)).status, 404);
});

// @spec DASH-HTTP-005, DASH-HTTP-006
test("personality: GET reads the store's document; PUT writes it to the store and tells the cortex to reload", async () => {
  assert.equal(await (await fetch(`${base}/personality`)).text(), "# Coco\n");
  bus.clear();
  const r = await post("/personality", "# Coco v2\n", "PUT");
  assert.equal(r.status, 204);
  assert.equal(personality(), "# Coco v2\n");
  assert.deepEqual(bus.published, [{ type: "control", data: { cmd: "reload_personality" } }]);
});

// @spec DASH-HTTP-006, STORE-PROJ-006
test("a personality save rewrites the projection of every unit that declares the personality, before the reload is published", async () => {
  rmSync(projectionsDir(st.root), { recursive: true, force: true });
  bus.clear();
  let projected: string[] = [];
  const publish = bus.publish.bind(bus);
  bus.publish = (async (...args: Parameters<typeof bus.publish>) => {
    projected = existsSync(projectionsDir(st.root)) ? readdirSync(projectionsDir(st.root)).toSorted() : [];
    return publish(...args);
  }) as typeof bus.publish;
  try {
    assert.equal((await post("/personality", "# Coco v3\n", "PUT")).status, 204);
  } finally {
    bus.publish = publish;
  }
  const units = personalityUnits();
  assert.ok(units.length > 0, "some unit declares the personality");
  assert.deepEqual(projected, units.map((u) => u.composeName).toSorted(), "only the personality units, written before the publish");
  for (const u of units) {
    const p = JSON.parse(readFileSync(join(projectionDir(st.root, u.composeName), "settings.json"), "utf8")) as { documents: { personality?: string }; revision: number };
    assert.equal(p.documents.personality, "# Coco v3\n", u.id);
    assert.equal(p.revision, st.store.revision(), u.id);
  }
  assert.deepEqual(bus.published, [{ type: "control", data: { cmd: "reload_personality" } }]);
});

// @spec DASH-HTTP-006
test("a personality PUT without the token is 401: nothing written, nothing projected or published", async () => {
  bus.clear();
  rmSync(projectionsDir(st.root), { recursive: true, force: true });
  const before = personality();
  const r = await fetch(`${base}/personality`, { method: "PUT", body: "# not mine\n" });
  assert.equal(r.status, 401);
  assert.equal(personality(), before);
  assert.equal(existsSync(projectionsDir(st.root)), false);
  assert.equal(bus.published.length, 0);
});

// @spec DASH-RCV-004, DASH-RCV-010, DASH-RCV-029
test("in normal mode GET /recovery is {active: false} plus recoveryKeyUnconfirmed while the store's flag is set; the gated confirm clears it; other recovery writes are 409", async () => {
  if (!st.store.recoveryKeyUnconfirmed()) {
    // A new store's first key sets the flag (settings-store STORE-KEY-002); make sure it is set whatever made this one.
    const { DatabaseSync } = await import("node:sqlite");
    const { storeFile } = await import("@cohost/store");
    const db = new DatabaseSync(storeFile(st.opts.dataDir!));
    db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('recovery_key_unconfirmed', '1')");
    db.close();
  }
  const get = async () => (await (await fetch(`${base}/recovery`)).json()) as Record<string, unknown>;
  assert.deepEqual(await get(), { active: false, recoveryKeyUnconfirmed: true });
  const refused = await fetch(`${base}/recovery/key-confirmed`, { method: "POST" });
  assert.equal(refused.status, 401, "the confirm passes the one gate");
  assert.equal(st.store.recoveryKeyUnconfirmed(), true);
  const ok = await fetch(`${base}/recovery/key-confirmed`, { method: "POST", headers: AUTH });
  assert.equal(ok.status, 204);
  assert.equal(st.store.recoveryKeyUnconfirmed(), false);
  assert.deepEqual(await get(), { active: false });
  for (const op of ["set", "reset", "reset-all", "restore", "import", "key", "discard-credentials", "raw"]) {
    const r = await post(`/recovery/${op}`, {});
    assert.equal(r.status, 409, op);
    assert.match(((await r.json()) as { detail: string }).detail, /not in config recovery mode/, op);
  }
});

// @spec DASH-HTTP-007
test("POST /control forwards operator commands to the bus", async () => {
  bus.clear();
  assert.equal((await post("/control", { cmd: "say", text: "brb" })).status, 204);
  assert.equal((await post("/control", { cmd: "mute" })).status, 204);
  assert.deepEqual(bus.of("control").map((c) => [c.cmd, c.text]), [["say", "brb"], ["mute", undefined]]);
});

// @spec DASH-SINK-002
test("POST /sink reports the browser audio sink's playing / done", async () => {
  bus.clear();
  const a = await post("/sink", { event: "playing", id: "a1", seq: 0 });
  const b = await post("/sink", { event: "done", id: "a1", seq: 2 });
  assert.deepEqual([a.status, b.status], [204, 204]);
  assert.deepEqual(bus.published, [
    { type: "voice.playing", data: { id: "a1", seq: 0, sink: "dashboard" } },
    { type: "voice.done", data: { id: "a1", seq: 2, sink: "dashboard" } },
  ]);
});

// @spec DASH-SINK-005, DASH-HTTP-004
test("POST /sink without a seq, or with one that is not a non-negative integer, is a 400 that publishes nothing, ahead of any 500 path", async () => {
  bus.clear();
  for (const seq of [undefined, -1, 1.5, "1", null, true, [0]]) {
    for (const event of ["playing", "done"]) {
      const r = await post("/sink", { event, id: "a1", ...(seq === undefined ? {} : { seq }) });
      assert.equal(r.status, 400, `${event} seq=${JSON.stringify(seq)}`);
    }
  }
  assert.equal(bus.published.length, 0);
});

// @spec DASH-HTTP-004
test("POST /sink with a body that is not JSON is still a 500 that does not exit", async () => {
  bus.clear();
  assert.equal((await post("/sink", "{nope")).status, 500);
  assert.equal(bus.published.length, 0);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

// @spec DASH-SINK-006
test("POST /sink forwards an interrupted done with its spoken and unsaid texts", async () => {
  bus.clear();
  assert.equal((await post("/sink", { event: "done", id: "a1", seq: 1, interrupted: true, spokenText: "one two", unsaidText: "three" })).status, 204);
  assert.equal((await post("/sink", { event: "done", id: "a2", seq: 0, interrupted: true })).status, 204);
  assert.deepEqual(bus.published, [
    { type: "voice.done", data: { id: "a1", seq: 1, sink: "dashboard", interrupted: true, spokenText: "one two", unsaidText: "three" } },
    { type: "voice.done", data: { id: "a2", seq: 0, sink: "dashboard", interrupted: true } },
  ]);
});

// @spec DASH-SINK-007
test("POST /sink forwards a final done", async () => {
  bus.clear();
  assert.equal((await post("/sink", { event: "done", id: "a1", seq: 3, final: true })).status, 204);
  assert.deepEqual(bus.published, [{ type: "voice.done", data: { id: "a1", seq: 3, sink: "dashboard", final: true } }]);
});

// @spec DASH-SINK-003
test("POST /sink with an event other than playing/done is a 400 and publishes nothing", async () => {
  bus.clear();
  for (const b of [{ event: "paused", id: "a1" }, { event: "", id: "a1" }, { id: "a1" }, { event: 3, id: "a1" }]) {
    assert.equal((await post("/sink", b)).status, 400, JSON.stringify(b));
  }
  assert.equal(bus.published.length, 0);
});

// @spec DASH-HTTP-011
test("bodies over 64 KiB are a 413 on /control, /personality and /sink: nothing published or saved", async () => {
  bus.clear();
  const before = personality();
  const big = "x".repeat(64 * 1024 + 1);
  assert.equal((await post("/control", JSON.stringify({ cmd: "say", text: big }))).status, 413);
  assert.equal((await post("/personality", big, "PUT")).status, 413);
  assert.equal((await post("/sink", JSON.stringify({ event: "playing", id: big }))).status, 413);
  assert.equal(personality(), before);
  assert.equal(bus.published.length, 0);
  // exactly at the cap is still accepted
  assert.equal((await post("/personality", "y".repeat(64 * 1024), "PUT")).status, 204);
  assert.equal(personality()?.length, 64 * 1024);
});

// @spec DASH-HTTP-004
test("a failed upstream body read is a 500 before any header is sent; a request URL that does not parse is a 500; the server keeps serving", async () => {
  rec.lines.length = 0;
  assert.equal((await fetch(`${base}/audio/cut.wav`)).status, 500);
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: "//" }, (r) => { r.resume(); resolve(r.statusCode!); }).on("error", reject);
  });
  assert.equal(status, 500);
  assert.deepEqual(rec.msgs("error"), ["request failed", "request failed"]);
  assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
});

// @spec DASH-HTTP-002, DASH-HTTP-003, DASH-HTTP-004, DASH-HTTP-007
test("bad input is a 500 with the error logged, not a crash; unknown routes 404", async () => {
  bus.clear();
  rec.lines.length = 0;
  assert.equal((await post("/control", "{not json")).status, 500);
  assert.equal((await post("/control", { cmd: "self_destruct" })).status, 500); // rejected by the event schema
  assert.equal(bus.published.length, 0);
  assert.deepEqual(rec.msgs("error"), ["request failed", "request failed"]);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await post("/", "x")).status, 404);
  assert.equal(await (await fetch(`${base}/health`)).text(), "ok");
});

// @spec DASH-FEED-006
test("GET /services lists every known service; unseen ones are unknown, a heartbeating one has its state", async () => {
  tracker.ingest({
    service: "cortex", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready",
    deps: { llm: "ok" }, mode: "live", intervalMs: 5000,
  });
  const r = await fetch(`${base}/services`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /application\/json/);
  const { services } = (await r.json()) as { services: { service: string; state: string }[] };
  assert.equal(services.length, 12);
  assert.equal(services.find((s) => s.service === "cortex")!.state, "up");
  assert.equal(services.filter((s) => s.state === "unknown").length, 11);
});

// @spec DASH-HTTP-017
test("POST /control forwards a say's route unchanged and publishes no route when the body has none", async () => {
  bus.clear();
  assert.equal((await post("/control", { cmd: "say", text: "to the archive", route: ["file", "http"] })).status, 204);
  assert.equal((await post("/control", { cmd: "say", text: "everywhere" })).status, 204);
  const [routed, plain] = bus.of("control");
  assert.deepEqual(routed!.route, ["file", "http"]);
  assert.equal("route" in plain!, false);
});
