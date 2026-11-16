import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, act, within, type TestApp } from "./helpers/render";
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

// @spec DASH-UI-004
test("avatar.state draws the face from its parameters and names the driver, with (disconnected) when not connected, and adds no feed row", () => {
  const app = boot();
  frame(app, "avatar.state", state);
  assert.match(card().textContent!, /vmc \(disconnected\)/);
  assert.equal(attr("head", "transform"), "translate(4 -8) rotate(7 100 100)");
  assert.equal(attr("eye-left", "ry"), "0.5", "a closed eye keeps a sliver");
  assert.equal(attr("eye-left", "cx"), "77");
  assert.equal(attr("eye-right", "cx"), "127");
  assert.equal(attr("eye-left", "cy"), "85");
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

// @spec DASH-UI-004, DASH-UI-030
test("malformed numbers draw a neutral face and a markup driver name stays text", () => {
  const app = boot();
  frame(app, "avatar.state", { ...state, headX: "x", blink: null, mouthOpen: NaN, driver: "<b>d</b>", emotion: "<i>e</i>" });
  assert.equal(attr("head", "transform"), "translate(0 -8) rotate(7 100 100)");
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
