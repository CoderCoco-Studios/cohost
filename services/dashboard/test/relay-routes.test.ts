import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { relay, tmpUi, connect } from "./relay-rig.js";
import { send } from "./models-rig.js";

// GET /avatar and its Content-Security-Policy, the avatar share of the LAN listener's route list and of the
// control-mode ungated list (DASH-AVP-001, DASH-AVP-002, DASH-HOST-002, DASH-CTRL-005).

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const PAGE = "<!doctype html><title>Avatar</title><script type=\"module\" src=\"/assets/avatar-abc.js\"></script>";

function builtUi(): string {
  const ui = tmpUi();
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>__COHOST_NAME__</title>");
  writeFileSync(join(ui, "avatar.html"), PAGE);
  return ui;
}

// @spec DASH-AVP-001, DASH-AVP-002
test("GET and HEAD /avatar answer the built avatar.html on both listeners, read per request, GET with the fixed policy", async (t) => {
  const ui = builtUi();
  const r = await relay(t, { uiDir: ui });
  for (const port of [r.port, r.lanPort]) {
    const g = await send(port, "GET", "/avatar");
    assert.equal(g.status, 200);
    assert.equal(g.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(g.headers["cache-control"], "no-cache");
    assert.equal(g.headers["content-security-policy"], CSP);
    assert.equal(g.text, PAGE);
    const h = await send(port, "HEAD", "/avatar");
    assert.equal(h.status, 200);
    assert.equal(h.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(h.headers["cache-control"], "no-cache");
    assert.equal(h.body.length, 0);
  }
  writeFileSync(join(ui, "avatar.html"), "<p>v2</p>");
  assert.equal((await r.get("/avatar")).text, "<p>v2</p>");
  assert.match((await r.get("/")).text, /<title>/, "every other route is unaffected");
});

// @spec DASH-AVP-001
test("with no avatar.html (or one that is not a regular file) /avatar is a 503 'not built' page that loads nothing and names pnpm build", async (t) => {
  const ui = tmpUi();
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>x</title>");
  mkdirSync(join(ui, "avatar.html")); // a directory is not a regular file
  const r = await relay(t, { uiDir: ui });
  for (const port of [r.port, r.lanPort]) {
    for (const method of ["GET", "HEAD"]) {
      const x = await send(port, method, "/avatar");
      assert.equal(x.status, 503, `${method} ${port}`);
      assert.equal(x.headers["content-type"], "text/html; charset=utf-8");
      assert.equal(x.headers["cache-control"], "no-store");
      if (method === "GET") {
        assert.match(x.text, /<title>Avatar renderer not built<\/title>/);
        assert.match(x.text, /pnpm build/);
        assert.doesNotMatch(x.text, /<script|<link|<img|<iframe|<object|\bsrc=|\bhref=|@import|url\(/i, "the page loads nothing");
      }
    }
  }
  assert.equal((await r.get("/")).status, 200, "every other route is unaffected");
});

// @spec DASH-HOST-002
test("the LAN listener serves GET /avatar, HEAD /avatar and /avatar/model of the avatar routes and answers every other /avatar route 404", async (t) => {
  const r = await relay(t, { uiDir: builtUi() });
  assert.equal((await r.lan("GET", "/avatar")).status, 200);
  assert.equal((await r.lan("HEAD", "/avatar")).status, 200);
  assert.notEqual((await r.lan("GET", "/avatar/model")).headers["content-type"], "text/plain; charset=utf-8", "the route is the LAN's (DASH-MDL-008)");
  for (const [method, path] of [
    ["GET", "/avatar/renderer"], ["GET", "/avatar/models"], ["GET", "/avatar/models/Aiko.vrm"], ["GET", "/avatar/ws"],
    ["POST", "/avatar"], ["POST", "/avatar/models"], ["DELETE", "/avatar/models/Aiko.vrm"], ["PUT", "/avatar/model"], ["GET", "/avatar/"], ["GET", "/avatar/x"], ["GET", "/Avatar"],
  ] as const) {
    assert.equal((await r.lan(method, path)).status, 404, `${method} ${path}`);
  }
});

// @spec DASH-HOST-002
test("a /avatar/ws upgrade is accepted on the LAN listener while an upgrade to any other avatar path is refused", async (t) => {
  const r = await relay(t);
  assert.equal((await connect(r.lanPort)).result, "open");
  for (const path of ["/avatar/renderer", "/avatar/model", "/avatar/models", "/avatar"]) {
    const res = await new Promise<number | "open">((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${r.lanPort}${path}`);
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("unexpected-response", (_q, x) => { x.resume(); resolve(x.statusCode ?? 0); });
      ws.on("error", () => undefined);
    });
    assert.notEqual(res, "open", `${path} must not upgrade`);
  }
});

// @spec DASH-CTRL-005
test("with control on, GET /avatar, /avatar/renderer, /avatar/model and the /avatar/ws relay need no token", async (t) => {
  const r = await relay(t, { control: true, uiDir: builtUi() });
  assert.equal((await send(r.port, "GET", "/avatar")).status, 200);
  assert.equal((await send(r.port, "GET", "/avatar/renderer")).status, 200);
  assert.notEqual((await send(r.port, "GET", "/avatar/model")).status, 401);
  assert.notEqual((await send(r.port, "GET", "/avatar/models")).status, 401);
  assert.equal((await connect(r.port)).result, "open", "the relay is ungated");
  assert.equal((await connect(r.port, { preview: true })).result, "open");
});
