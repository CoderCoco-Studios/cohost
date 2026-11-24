// The avatar page's relay-message handling, view/model-version switching, preview status line and postMessage draft
// filter (DASH-BUILD-011). Failing-first step of issue #218: the modules under test do not exist yet.
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { REST_FRAME } from "../../ui/src/avatar/frame";
import { createAvatarState, SOCKET_PATH } from "../../ui/src/avatar/session";
import { acceptDraft, statusLine, type StatusInput } from "../../ui/src/avatar/preview";
import { showStatusLine } from "../../ui/src/avatar/status-dom";

interface Call { op: "request" | "clear"; url?: string; version?: string }
function rig(preview = false) {
  let t = 1000;
  const calls: Call[] = [];
  const state = createAvatarState({
    preview,
    now: () => t,
    loader: {
      request: (x: { url: string; version: string }) => { calls.push({ op: "request", url: x.url, version: x.version }); },
      clear: () => { calls.push({ op: "clear" }); },
    },
  });
  return { state, calls, advance: (ms: number) => { t += ms; }, set: (n: number) => { t = n; } };
}
const view = (model: { version: string; name?: string } | null, framing = { zoom: 1, offsetY: 0, turn: 0 }) => JSON.stringify({ type: "view", model, framing });
const frameMsg = (over: Record<string, unknown> = {}) => JSON.stringify({ type: "frame", frame: { ...REST_FRAME, mouthOpen: 0.5, headX: 20, ...over } });

// @spec DASH-AVP-035
test("the socket path is /avatar/ws, with preview=1 only in preview mode", () => {
  assert.equal(SOCKET_PATH(false), "/avatar/ws");
  assert.equal(SOCKET_PATH(true), "/avatar/ws?preview=1");
});

// @spec DASH-AVP-023, DASH-AVP-024
test("a view with a model version requests that model; the same version again requests nothing more", () => {
  const { state, calls } = rig();
  state.message(view({ version: "v1" }));
  state.message(view({ version: "v1" }, { zoom: 2, offsetY: 0, turn: 0 }));
  assert.deepEqual(calls, [{ op: "request", url: "/avatar/model", version: "v1" }]);
  state.message(view({ version: "v2" }));
  assert.deepEqual(calls.at(-1), { op: "request", url: "/avatar/model", version: "v2" });
});

// @spec DASH-AVP-022
test("a view that changes only the framing applies it on the next read with no load", () => {
  const { state, calls } = rig();
  state.message(view({ version: "v1" }));
  calls.length = 0;
  state.message(view({ version: "v1" }, { zoom: 1.5, offsetY: -0.2, turn: 30 }));
  assert.deepEqual(calls, []);
  assert.deepEqual(state.snapshot().framing, { zoom: 1.5, offsetY: -0.2, turn: 30 });
});

// @spec DASH-AVP-028
test("a view with model null clears the model", () => {
  const { state, calls } = rig();
  state.message(view({ version: "v1" }));
  state.message(view(null));
  assert.deepEqual(calls.at(-1), { op: "clear" });
});

// @spec DASH-AVP-032
test("a message that is not JSON, not an object, of an unknown type or of a known type with a bad shape is ignored", () => {
  const { state, calls } = rig();
  state.message(view({ version: "v1" }));
  const before = state.snapshot();
  calls.length = 0;
  for (const raw of ["{not json", "null", "42", '"view"', "[]", JSON.stringify({ type: "hello" }), JSON.stringify({ type: 5 }), JSON.stringify({}),
    JSON.stringify({ type: "view" }),
    JSON.stringify({ type: "view", model: { version: 7 }, framing: { zoom: 1, offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "view", model: { version: "" }, framing: { zoom: 1, offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "view", model: { version: "v9" }, framing: { zoom: "1", offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "view", model: { version: "v9" }, framing: { zoom: 0, offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "view", model: { version: "v9" }, framing: { zoom: -1, offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "view", model: { version: "v9" }, framing: { zoom: 1, offsetY: null, turn: 0 } }),
    JSON.stringify({ type: "view", model: "v9", framing: { zoom: 1, offsetY: 0, turn: 0 } }),
    JSON.stringify({ type: "status", state: "bogus", driver: null }),
    JSON.stringify({ type: "status", state: "live", driver: 4 }),
    JSON.stringify({ type: "frame" }), JSON.stringify({ type: "frame", frame: null }),
  ]) assert.doesNotThrow(() => state.message(raw), raw);
  assert.deepEqual(calls, [], "none of them reached the loader");
  assert.deepEqual(state.snapshot().framing, before.framing);
  assert.deepEqual(state.snapshot().status, before.status);
});

// @spec DASH-AVP-032
test("a message is also accepted from a non-string payload object only through the string path: binary frames are ignored", () => {
  const { state } = rig();
  assert.doesNotThrow(() => state.message(new ArrayBuffer(8) as unknown as string));
  assert.deepEqual(state.snapshot().pose, REST_FRAME);
});

// @spec DASH-AVP-020, DASH-AVP-032
test("the newest valid frame is the pose as given; a frame that fails validation keeps the previous one", () => {
  const { state, advance } = rig();
  state.message(frameMsg());
  assert.equal(state.snapshot().pose.mouthOpen, 0.5);
  assert.equal(state.snapshot().pose.headX, 20);
  advance(100);
  state.message(frameMsg({ mouthOpen: Number.NaN }));
  state.message(frameMsg({ mouthOpen: 7 }));
  state.message(JSON.stringify({ type: "frame", frame: { ...REST_FRAME, extra: 1, headX: 33 } }));
  assert.equal(state.snapshot().pose.headX, 33, "unknown fields are ignored, the frame still applies");
  state.message(frameMsg({ emotion: "nope" }));
  assert.equal(state.snapshot().pose.headX, 33);
});

// @spec DASH-AVP-030
test("before a frame the rest values; the timer runs from the last valid frame, which a rejected frame does not reset", () => {
  const { state, advance } = rig();
  assert.deepEqual(state.snapshot().pose, REST_FRAME);
  state.message(frameMsg({ headX: 40 }));
  advance(1900);
  state.message(frameMsg({ headX: 40, blink: 5 })); // invalid: must not restart the 2 s hold
  advance(600);
  const p = state.snapshot().pose; // 2.5 s after the valid frame: halfway through the ease
  assert.ok(Math.abs(p.headX - 20) < 1e-9, String(p.headX));
  advance(1000);
  assert.equal(state.snapshot().pose.headX, 0);
  state.message(frameMsg({ headX: -10 }));
  assert.equal(state.snapshot().pose.headX, -10, "applied at once");
});

// @spec DASH-AVP-030
test("a closed socket does not freeze the pose: the hold and ease run on the clock whatever the cause", () => {
  const { state, advance } = rig();
  state.message(frameMsg({ headX: 40 }));
  state.socketOpen(false);
  advance(3000);
  assert.equal(state.snapshot().pose.headX, 0);
});

// @spec DASH-AVP-035
test("status messages are kept for the preview line; the socket flag is tracked", () => {
  const { state } = rig(true);
  state.message(JSON.stringify({ type: "status", state: "off", driver: "vmc" }));
  assert.deepEqual(state.snapshot().status, { state: "off", driver: "vmc" });
  state.socketOpen(true);
  assert.equal(state.snapshot().socketOpen, true);
  state.socketOpen(false);
  assert.equal(state.snapshot().socketOpen, false);
});

// @spec DASH-AVP-035
test("a preview takes the model's name from the view and shows it in the snapshot", () => {
  const { state } = rig(true);
  state.message(view({ version: "v1", name: "Aiko.vrm" }));
  assert.equal(state.snapshot().modelName, "Aiko.vrm");
});

// @spec DASH-AVP-004
test("a model name in a view is never used to build the fetch URL: the applied model is always GET /avatar/model", () => {
  const { state, calls } = rig(true);
  state.message(view({ version: "v1", name: "../../etc/passwd" }));
  assert.deepEqual(calls, [{ op: "request", url: "/avatar/model", version: "v1" }]);
});

// ---- preview drafts ---------------------------------------------------------------------------------------------

// @spec DASH-AVP-036
test("a model draft overrides the view's model until a clear; the empty name draws no model", () => {
  const { state, calls } = rig(true);
  state.message(view({ version: "v1", name: "A.vrm" }));
  calls.length = 0;
  state.draft({ kind: "model", name: "B.vrm" });
  assert.deepEqual(calls, [{ op: "request", url: "/avatar/models/B.vrm", version: "draft:B.vrm" }]);
  state.message(view({ version: "v2", name: "C.vrm" }));
  assert.equal(calls.length, 1, "a view's model does not displace the draft");
  state.draft({ kind: "model", name: "" });
  assert.deepEqual(calls.at(-1), { op: "clear" });
});

// @spec DASH-AVP-036
test("a framing draft overrides the view's framing until a clear, and a clear drops both drafts and shows the view again", () => {
  const { state, calls } = rig(true);
  state.message(view({ version: "v1", name: "A.vrm" }, { zoom: 1, offsetY: 0, turn: 0 }));
  state.draft({ kind: "framing", framing: { zoom: 2, offsetY: 0.1, turn: 20 } });
  state.draft({ kind: "model", name: "B.vrm" });
  state.message(view({ version: "v1", name: "A.vrm" }, { zoom: 3, offsetY: 0, turn: 0 }));
  assert.deepEqual(state.snapshot().framing, { zoom: 2, offsetY: 0.1, turn: 20 });
  calls.length = 0;
  state.draft({ kind: "clear" });
  assert.deepEqual(state.snapshot().framing, { zoom: 3, offsetY: 0, turn: 0 });
  assert.deepEqual(calls, [{ op: "request", url: "/avatar/model", version: "v1" }]);
});

// @spec DASH-AVP-036
test("a clear while the view has no model clears the model; a draft is ignored outside preview mode", () => {
  const { state, calls } = rig(true);
  state.message(view(null));
  state.draft({ kind: "model", name: "B.vrm" });
  calls.length = 0;
  state.draft({ kind: "clear" });
  assert.deepEqual(calls, [{ op: "clear" }]);

  const live = rig(false);
  live.state.message(view({ version: "v1" }));
  live.calls.length = 0;
  live.state.draft({ kind: "model", name: "B.vrm" });
  live.state.draft({ kind: "framing", framing: { zoom: 9, offsetY: 0, turn: 0 } });
  assert.deepEqual(live.calls, []);
  assert.deepEqual(live.state.snapshot().framing, { zoom: 1, offsetY: 0, turn: 0 });
});

// ---- the draft-message filter -----------------------------------------------------------------------------------

const parent = {} as object;
const ctx = { preview: true, origin: "http://localhost:3000", parent };
const from = (data: unknown, over: Partial<{ origin: string; source: object | null }> = {}) => acceptDraft({ data, origin: "http://localhost:3000", source: parent, ...over }, ctx);

// @spec DASH-AVP-036
test("the three draft kinds are accepted from the embedding window on the page's own origin", () => {
  assert.deepEqual(from({ type: "framing", framing: { zoom: 1.5, offsetY: -0.1, turn: 10 } }), { kind: "framing", framing: { zoom: 1.5, offsetY: -0.1, turn: 10 } });
  assert.deepEqual(from({ type: "model", name: "Aiko.vrm" }), { kind: "model", name: "Aiko.vrm" });
  assert.deepEqual(from({ type: "model", name: "" }), { kind: "model", name: "" });
  assert.deepEqual(from({ type: "clear" }), { kind: "clear" });
});

// @spec DASH-AVP-036
test("a message from another origin, another window, a null origin or outside preview mode is ignored", () => {
  const ok = { type: "clear" };
  assert.equal(from(ok, { origin: "http://evil.example" }), null);
  assert.equal(from(ok, { origin: "http://localhost:3001" }), null);
  assert.equal(from(ok, { origin: "https://localhost:3000" }), null);
  assert.equal(from(ok, { origin: "null" }), null);
  assert.equal(from(ok, { origin: "" }), null);
  assert.equal(from(ok, { source: {} }), null, "same origin but not the embedding window (another frame on the page)");
  assert.equal(from(ok, { source: null }), null);
  assert.equal(acceptDraft({ data: ok, origin: "http://localhost:3000", source: parent }, { ...ctx, preview: false }), null);
  assert.equal(acceptDraft({ data: ok, origin: "http://localhost:3000", source: parent }, { ...ctx, parent: null }), null, "a page that is not framed accepts nothing");
});

// @spec DASH-AVP-036
test("a message of any other kind or shape is ignored", () => {
  for (const d of [null, undefined, 1, "clear", [], { type: "other" }, {}, { type: 1 },
    { type: "framing" }, { type: "framing", framing: null }, { type: "framing", framing: { zoom: 1, offsetY: 0 } },
    { type: "framing", framing: { zoom: "1", offsetY: 0, turn: 0 } }, { type: "framing", framing: { zoom: Number.NaN, offsetY: 0, turn: 0 } },
    { type: "framing", framing: { zoom: Infinity, offsetY: 0, turn: 0 } }, { type: "framing", framing: { zoom: 0, offsetY: 0, turn: 0 } },
    { type: "framing", framing: { zoom: -1, offsetY: 0, turn: 0 } }, { type: "framing", framing: { zoom: 1, offsetY: 0, turn: 0, extra: 1 } },
    { type: "framing", framing: { zoom: 1, offsetY: 0, turn: 0 }, extra: 1 },
    { type: "model" }, { type: "model", name: 5 }, { type: "model", name: null }, { type: "model", name: { toString: () => "x" } },
    { type: "model", name: "a.vrm", extra: 1 }, { type: "clear", extra: 1 },
  ]) assert.equal(from(d), null, JSON.stringify(d));
});

// @spec DASH-AVP-036
test("the filter's result is a fresh object: a getter or extra property on the message cannot leak through", () => {
  const msg = { type: "model", get name() { return "a.vrm"; } };
  const r = from(msg);
  assert.deepEqual(r, { kind: "model", name: "a.vrm" });
});

// ---- the preview status line ------------------------------------------------------------------------------------

const base: StatusInput = { socketOpen: true, model: { name: "Aiko.vrm" }, load: { state: "ready", detail: "" }, status: { state: "live", driver: "browser" } };

// @spec DASH-AVP-035
test("the status line is the first of the six that applies, in the spec's order", () => {
  assert.equal(statusLine({ ...base, socketOpen: false, model: null }), "Reconnecting");
  assert.equal(statusLine({ ...base, model: null }), "No model selected");
  assert.equal(statusLine({ ...base, load: { state: "loading", detail: "" } }), "Loading Aiko.vrm");
  assert.equal(statusLine({ ...base, load: { state: "failed", detail: "unsupported extension" } }), "Could not load Aiko.vrm: unsupported extension");
  assert.equal(statusLine({ ...base, status: { state: "off", driver: "vmc" } }), "avatar.driver is vmc; the renderer needs browser");
  assert.equal(statusLine({ ...base, status: { state: "waiting", driver: null } }), "Waiting for the avatar");
  assert.equal(statusLine({ ...base, status: null }), "Waiting for the avatar", "no status seen yet");
});

// @spec DASH-AVP-035
test("an earlier line wins over a later one, and no line shows when nothing applies", () => {
  assert.equal(statusLine({ ...base, socketOpen: false, status: { state: "off", driver: "vmc" } }), "Reconnecting");
  assert.equal(statusLine({ ...base, load: { state: "loading", detail: "" }, status: { state: "off", driver: "vmc" } }), "Loading Aiko.vrm");
  assert.equal(statusLine({ ...base, model: null, load: { state: "failed", detail: "x" } }), "No model selected");
  assert.equal(statusLine(base), null);
});

// @spec DASH-AVP-035
test("the status line keeps the model name and reason as text only, cutting nothing and adding no markup", () => {
  const evil = '<img src=x onerror=alert(1)>';
  assert.equal(statusLine({ ...base, model: { name: evil }, load: { state: "loading", detail: "" } }), `Loading ${evil}`);
  assert.equal(statusLine({ ...base, load: { state: "failed", detail: evil } }), `Could not load Aiko.vrm: ${evil}`);
});

// @spec DASH-AVP-035
test("showStatusLine renders plain text: markup in a name or reason becomes text, never an element", () => {
  const el = document.createElement("div");
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  showStatusLine(el, `Could not load ${evil}: <b>x</b>`);
  assert.equal(el.children.length, 0);
  assert.equal(el.textContent, `Could not load ${evil}: <b>x</b>`);
  assert.equal((globalThis as { __pwned?: number }).__pwned, undefined);
  assert.equal(el.hidden, false);
  showStatusLine(el, null);
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, "");
});
