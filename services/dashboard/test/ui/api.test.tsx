import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccess } from "../../ui/src/state/access";
import { createApi } from "../../ui/src/state/api";
import { FakeFetch, FakeStorage } from "./helpers/fakes";

function setup() {
  const f = new FakeFetch();
  const access = createAccess({ local: new FakeStorage(), session: new FakeStorage(), events: new EventTarget() });
  const api = createApi({ fetch: f.fetch, access });
  return { f, access, api };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a JSON answer is parsed, a plain-text answer is text, a 204 has no data", async () => {
  const { f, api } = setup();
  f.on("GET /stack", { json: { state: "up" } }).on("GET /personality", { text: "# Coco" }).on("POST /sink", { status: 204 });
  assert.deepEqual(await api.get("/stack"), { ok: true, status: 200, data: { state: "up" } });
  assert.deepEqual(await api.get("/personality"), { ok: true, status: 200, data: "# Coco" });
  assert.deepEqual(await api.post("/sink", { event: "done", id: "x" }), { ok: true, status: 204, data: undefined });
  assert.equal(f.callsTo("POST /sink")[0]!.body, JSON.stringify({ event: "done", id: "x" }));
  assert.equal(f.callsTo("POST /sink")[0]!.headers["content-type"], "application/json");
});

// @spec DASH-UI-015
test("an error answer yields one shape whether the server sent JSON {detail} or plain text, with the HTTP status", async () => {
  const { f, api } = setup();
  f.on("POST /stack/launch", { status: 409, json: { ok: false, detail: "busy: launch held by dashboard (pid 1)" } })
    .on("PUT /personality", { status: 500, text: "Error: disk full" })
    .on("POST /control", { status: 413, text: "body too large" })
    .on("PUT /config/llm", { status: 400, json: { ok: false, detail: "invalid", issues: [{ path: "llm.x", message: "bad" }] } });
  assert.deepEqual(await api.post("/stack/launch"), { ok: false, status: 409, detail: "busy: launch held by dashboard (pid 1)", data: { ok: false, detail: "busy: launch held by dashboard (pid 1)" } });
  const r2 = await api.put("/personality", "x");
  assert.equal(!r2.ok && r2.detail, "Error: disk full");
  assert.equal(r2.ok ? 0 : r2.status, 500);
  const r3 = await api.post("/control", {});
  assert.equal(!r3.ok && r3.detail, "body too large");
  const r4 = await api.put("/config/llm", {});
  assert.deepEqual(!r4.ok && (r4.data as { issues: unknown[] }).issues, [{ path: "llm.x", message: "bad" }]);
  const r5 = await api.get("/nothing");
  assert.equal(!r5.ok && r5.detail, "not found");
});

// @spec DASH-UI-015
test("a network error is a failed result with status 0 and the error text; it never throws", async () => {
  const { f, api } = setup();
  f.fail("POST /control");
  const r = await api.post("/control", {});
  assert.deepEqual({ ...r }, { ok: false, status: 0, detail: "network error", network: true });
});

// @spec DASH-ACC-012
test("the token is sent only as Authorization: Bearer, on the routes that ask for it, and never in the URL or body", async () => {
  const { f, api, access } = setup();
  access.setToken("control", "tok-1", "tab");
  f.on("POST /control", { status: 204 }).on("GET /stack", { json: {} });
  await api.post("/control", { cmd: "mute" }, { auth: "control" });
  await api.get("/stack");
  const [withAuth, without] = f.calls;
  assert.equal(withAuth!.headers.authorization, "Bearer tok-1");
  assert.ok(!withAuth!.path.includes("tok-1") && !withAuth!.body!.includes("tok-1"));
  assert.equal(without!.headers.authorization, undefined);
});

// @spec DASH-UI-006
test("a gated request with no token is sent without one (control mode may be off); a 401 opens the prompt and retries once after unlock", async () => {
  const { f, api, access } = setup();
  let n = 0;
  f.on("POST /control", (c) => (c.headers.authorization === "Bearer good" ? { status: 204 } : { status: 401, text: "unauthorized" }));
  const p = api.post("/control", { cmd: "mute" }, { auth: "control", action: "Mute co-host" });
  await tick();
  assert.equal(f.callsTo("POST /control").length, 1);
  assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.equal(access.state.get().prompt?.action, "Mute co-host");
  assert.equal(access.state.get().prompt?.rejected, false);
  access.setToken("control", "good", "tab"); access.resolvePrompt(true); n++;
  assert.deepEqual(await p, { ok: true, status: 204, data: undefined });
  assert.equal(f.callsTo("POST /control").length, 2);
  assert.equal(f.calls[1]!.headers.authorization, "Bearer good");
  assert.equal(n, 1);
});

// @spec DASH-UI-006, DASH-ACC-002
test("cancelling the prompt ends the request as not done: locked, without a second request", async () => {
  const { f, api, access } = setup();
  f.on("POST /control", { status: 401, text: "unauthorized" });
  const p = api.post("/control", {}, { auth: "control", action: "Say" });
  await tick();
  access.resolvePrompt(false);
  const r = await p;
  assert.deepEqual({ ...r }, { ok: false, status: 401, detail: "not done: locked", locked: true });
  assert.equal(f.calls.length, 1);
});

// @spec DASH-ACC-006
test("a stored token the server rejects is cleared and the prompt reopens with the rejection", async () => {
  const { f, api, access } = setup();
  access.setToken("control", "stale", "browser");
  f.on("POST /control", { status: 401, text: "unauthorized" });
  const p = api.post("/control", {}, { auth: "control", action: "Say" });
  await tick();
  assert.equal(access.getToken("control"), undefined);
  assert.equal(access.state.get().control.present, false);
  assert.equal(access.state.get().prompt?.rejected, true);
  access.resolvePrompt(false);
  await p;
});

// @spec DASH-UI-006
test("a second 401 after the retry is the result; the page does not loop", async () => {
  const { f, api, access } = setup();
  f.on("POST /control", { status: 401, text: "unauthorized" });
  const p = api.post("/control", {}, { auth: "control", action: "Say" });
  await tick();
  access.setToken("control", "also-bad", "tab"); access.resolvePrompt(true);
  const r = await p;
  assert.equal(r.status, 401);
  assert.equal(f.calls.length, 2);
  assert.equal(access.state.get().prompt, null);
});

// @spec DASH-UI-006, DASH-SET-028, DASH-CTRL-011
test("a gated request with no token held is sent without one, and the Access dialog does not open unless the server answers 401", async () => {
  const { f, api, access } = setup();
  f.on("PUT /secrets/llm.openai.api_key", { json: { ok: true, set: true, restart: [] } });
  const r = await api.put("/secrets/llm.openai.api_key", { value: "k" }, { auth: "control", action: "Save the API key" });
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.authorization, undefined);
  assert.equal(access.state.get().prompt, null, "an unlocked browser sends its session cookie, so nothing asks before a 401");
});

test("a /viewers request carries the one control token", async () => {
  const { f, api, access } = setup();
  access.setToken("control", "c", "tab");
  f.on("GET /viewers", { json: { viewers: [] } });
  await api.get("/viewers", { auth: "control", action: "Load viewers" });
  assert.equal(f.calls[0]!.headers.authorization, "Bearer c");
});

test("a raw body (an uploaded image or audio) is sent as given with its content type", async () => {
  const { f, api } = setup();
  f.on("POST /inject/image?level=service&remember=1", { status: 202, json: { id: "abc" } });
  const bytes = new Uint8Array([1, 2, 3]);
  const r = await api.post("/inject/image?level=service&remember=1", bytes, { contentType: "image/png" });
  assert.deepEqual(r.ok && r.data, { id: "abc" });
  assert.equal(f.calls[0]!.headers["content-type"], "image/png");
  assert.equal(f.calls[0]!.raw, bytes);
});
