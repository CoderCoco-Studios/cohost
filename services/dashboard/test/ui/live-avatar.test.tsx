import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, act, within, type TestApp } from "./helpers/render";
import { cleanup } from "@testing-library/react";
import { Screen } from "../../ui/src/screens/live";

function boot(open = true) {
  location.hash = "";
  const app = makeApp();
  renderApp(<Screen route={{ view: "live" }} />, app);
  if (open) act(() => { app.socket().open(); });
  return app;
}
let seq = 0;
const frame = (app: TestApp, type: string, data: Record<string, unknown>) => act(() => { app.socket().message({ id: `a${++seq}-0`, type, ts: 1, source: "avatar", data }); });
const card = () => screen.getByRole("region", { name: "Avatar" });
const face = () => within(card()).getByRole("img", { name: /^Avatar preview/ });
const state = { driver: "vmc", connected: false, headX: 5, headY: 10, headZ: 7, blink: 1, eyeX: 0.5, eyeY: -1, mouthOpen: 1, mouthSmile: 0.5, emotion: "happy" };
const attr = (id: string, name: string) => face().querySelector(`[data-part=${id}]`)!.getAttribute(name);

// @spec DASH-UI-004
test("before any avatar.state the card says the driver has not reported, and the face is neutral", () => {
  boot();
  assert.match(card().textContent!, /has not reported/);
  assert.equal(attr("head", "transform"), "translate(0 0) rotate(0 100 100)");
});

// @spec DASH-UI-004
test("before the feed opens the card shows a loading state", () => {
  boot(false);
  assert.ok(within(card()).getByRole("status"));
});

// @spec DASH-UI-004, DASH-UI-054
test("avatar.state draws the face from its parameters and names the driver, with (disconnected) when not connected, and adds no feed row", () => {
  const app = boot();
  frame(app, "avatar.state", state);
  assert.match(card().textContent!, /vmc \(disconnected\)/);
  assert.equal(attr("head", "transform"), "translate(-4 8) rotate(7 100 100)");
  assert.equal(attr("eye-left", "ry"), "0.5", "a closed eye keeps a sliver");
  assert.equal(attr("eye-left", "cx"), "77");
  assert.equal(attr("eye-right", "cx"), "127");
  assert.equal(attr("eye-left", "cy"), "91");
  assert.equal(attr("mouth", "d"), "M80 128 Q100 159 120 128 Q100 125.2 80 128");
  assert.match(card().textContent!, /Emotion\s*happy/);
  assert.equal(face().getAttribute("aria-label"), "Avatar preview: happy");
  frame(app, "avatar.state", { ...state, connected: true, blink: 0, mouthOpen: 0 });
  assert.match(card().textContent!, /vmc/);
  assert.ok(!/disconnected/.test(card().textContent!));
  assert.equal(attr("eye-left", "ry"), "9");
  assert.ok(screen.queryAllByRole("article").length === 0, "no feed row for avatar.state");
});

// @spec DASH-UI-004
test("the card says the emotion mirrors what the avatar driver receives", () => {
  const app = boot();
  frame(app, "avatar.state", state);
  assert.match(card().textContent!, /mirrors what the avatar driver receives/i);
});

// @spec DASH-UI-004, DASH-UI-030, DASH-UI-054
test("malformed numbers draw a neutral face and a markup driver name stays text", () => {
  const app = boot();
  frame(app, "avatar.state", { ...state, headX: "x", blink: null, mouthOpen: NaN, driver: "<b>d</b>", emotion: "<i>e</i>" });
  assert.equal(attr("head", "transform"), "translate(0 8) rotate(7 100 100)");
  assert.ok(card().querySelector("b, i") === null);
  assert.match(card().textContent!, /<b>d<\/b>/);
});

// @spec DASH-UI-001
test("while the socket is closed the avatar card is aria-busy and dimmed", () => {
  const app = boot();
  frame(app, "avatar.state", state);
  act(() => { app.socket().serverClose(); });
  assert.equal(card().getAttribute("aria-busy"), "true");
  assert.ok(card().className.split(" ").includes("stale"));
});

// @spec DASH-UI-054
test("each parameter moves the face in the direction a viewer sees: headX positive to the left, headY positive down, headZ positive tilts the top to the right, eyeX positive right, eyeY positive up", () => {
  const app = boot();
  const neutral = { ...state, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0 };
  const move = (over: Record<string, number>) => {
    frame(app, "avatar.state", { ...neutral, ...over });
    const m = /^translate\((-?[\d.]+) (-?[\d.]+)\) rotate\((-?[\d.]+) /.exec(attr("head", "transform")!)!;
    return { x: Number(m[1]), y: Number(m[2]), roll: Number(m[3]), eyeX: Number(attr("eye-left", "cx")), eyeY: Number(attr("eye-left", "cy")) };
  };
  const base = move({});
  assert.ok(move({ headX: 10 }).x < base.x, "headX > 0 moves the face toward the viewer's left (smaller x)");
  assert.ok(move({ headX: -10 }).x > base.x, "headX < 0 moves it right");
  assert.ok(move({ headY: 10 }).y > base.y, "headY > 0 moves the face down (larger y)");
  assert.ok(move({ headY: -10 }).y < base.y, "headY < 0 moves it up");
  assert.ok(move({ headZ: 10 }).roll > base.roll, "headZ > 0 is a clockwise roll: the top tilts toward the viewer's right");
  assert.ok(move({ eyeX: 1 }).eyeX > base.eyeX, "eyeX > 0 moves the eyes right");
  assert.ok(move({ eyeY: 1 }).eyeY < base.eyeY, "eyeY > 0 moves the eyes up (smaller y)");
  assert.ok(move({ eyeY: -1 }).eyeY > base.eyeY, "eyeY < 0 moves them down");
});

// --- the renderer line (DASH-AVS-010) -------------------------------------------------------------------------------------------

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const rendererRoute = (pages: { sentFps: number }[]) => ({ json: { state: "live", driver: "browser", fps: 30, applied: { model: null, configuredModel: "", zoom: 1, offsetY: 0, turn: 0 }, pages: pages.map((p, i) => ({ ...p, model: null, since: i })), previews: 1, maxPages: 8, maxPreviews: 4 } });
const rline = () => within(card()).queryByText(/^Renderer:/);

function bootWith(route?: Parameters<TestApp["fetch"]["on"]>[1]) {
  location.hash = "";
  const app = makeApp();
  if (route) app.fetch.on("GET /avatar/renderer", route);
  renderApp(<Screen route={{ view: "live" }} />, app);
  act(() => { app.socket().open(); });
  return app;
}

// @spec DASH-AVS-010
test("while avatar.state names the browser driver the card shows 'Renderer: <n> page(s) · <fps> fps', the fps being the highest sentFps", async () => {
  const app = bootWith(rendererRoute([{ sentFps: 30 }, { sentFps: 45 }]));
  frame(app, "avatar.state", { ...state, driver: "browser", connected: true });
  await sleep(50);
  assert.equal(rline()?.textContent, "Renderer: 2 pages · 45 fps");
  app.fetch.on("GET /avatar/renderer", rendererRoute([{ sentFps: 30 }]));
  await sleep(2300);
  assert.equal(rline()?.textContent, "Renderer: 1 page · 30 fps");
});

// @spec DASH-AVS-010
test("with no renderer page the line reads 'Renderer: no page connected'; previews are not counted", async () => {
  const app = bootWith(rendererRoute([]));
  frame(app, "avatar.state", { ...state, driver: "browser", connected: true });
  await sleep(50);
  assert.equal(rline()?.textContent, "Renderer: no page connected");
});

// @spec DASH-AVS-010
test("another driver, or no avatar.state yet, shows no renderer line and reads no route", async () => {
  const app = bootWith(rendererRoute([{ sentFps: 30 }]));
  await sleep(50);
  assert.equal(rline(), null);
  frame(app, "avatar.state", { ...state, driver: "vmc", connected: true });
  await sleep(50);
  assert.equal(rline(), null);
  assert.equal(app.fetch.callsTo("GET /avatar/renderer").length, 0);
});

// @spec DASH-AVS-010
test("the route is read every 2 s while the card is on screen and no longer after it is gone; an unavailable route (LAN, 404) leaves no stale line", async () => {
  const app = bootWith(rendererRoute([{ sentFps: 30 }]));
  frame(app, "avatar.state", { ...state, driver: "browser", connected: true });
  await sleep(50);
  const reads = () => app.fetch.callsTo("GET /avatar/renderer").length;
  assert.equal(reads(), 1);
  app.fetch.on("GET /avatar/renderer", { status: 404, text: "not found" });
  await sleep(2300);
  assert.ok(reads() >= 2);
  assert.doesNotMatch(card().textContent!, /Renderer: 1 page/);
  cleanup();
  const n = reads();
  await sleep(2300);
  assert.equal(reads(), n);
});
