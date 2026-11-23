import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeSource, def, on, search, startTools, waitFor } from "./helpers.js";

const last = (s: { bus: { health: any[] } }) => s.bus.health.at(-1)!;
const other = { url: "https://other.example.com/mcp" };

test("it is ready once the group exists, without waiting for any MCP server, then degraded while a dependency is down", async () => { // @spec TOOL-SVC-004
  const down = new FakeSource("search", [def("web")]);
  down.state = "down";
  const s = await startTools({ servers: { search }, allow: { search__web: on("web") } }, [down]);
  await waitFor(() => s.bus.health.some((h) => h.state === "ready" || h.state === "degraded"), "past starting");
  assert.deepEqual(s.bus.health.map((h) => h.state).slice(0, 1), ["starting"]);
  assert.equal(s.bus.health.some((h) => h.state === "ready"), true, "ready is reported first whatever the servers' state");
  await waitFor(() => last(s).state === "degraded", "degraded with a down server");
  assert.equal(last(s).deps["mcp.search"], "down");
  down.state = "ok";
  down.change();
  await waitFor(() => last(s).state === "ready", "ready again", 4000);
  assert.equal(last(s).deps["mcp.search"], "ok");
  await s.stop();
});

test("a server with no enabled tool is connected but is no dependency and does not degrade the service", async () => { // @spec TOOL-SVC-004
  const down = new FakeSource("search", [def("web")]);
  down.state = "down";
  const s = await startTools({ servers: { search }, allow: {} }, [down]);
  await waitFor(() => s.bus.health.some((h) => h.state === "ready"), "ready");
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(last(s).state, "ready");
  assert.deepEqual(last(s).deps, {});
  await s.stop();
});

test("the heartbeat mode is mock while tools.mode is mock and live otherwise", async () => { // @spec TOOL-SVC-005
  const m = await startTools({ mode: "mock", servers: { search }, allow: {} });
  await waitFor(() => m.bus.health.some((h) => h.state === "ready"), "ready");
  assert.equal(last(m).mode, "mock");
  const l = await startTools({ servers: { search }, allow: {} }, [new FakeSource("search", [])]);
  await waitFor(() => l.bus.health.some((h) => h.state === "ready"), "ready");
  assert.equal(last(l).mode, "live");
  await Promise.all([m.stop(), l.stop()]);
});

test("the detail is the parts 'n tools offered', 'no tools enabled', down servers and off-LAN servers joined by '; ' in that order", async () => { // @spec TOOL-SVC-006
  const a = new FakeSource("search", [def("web"), def("two")]);
  const b = new FakeSource("other", [def("x")]);
  b.state = "down";
  const c = new FakeSource("locked", [def("y")]);
  c.state = "auth";
  const s = await startTools({
    servers: { search, other, locked: { url: "http://192.168.1.9:9/mcp" } },
    allow: { search__web: on("web"), search__two: on("two"), other__x: on("x"), locked__y: on("y") },
  }, [a, b, c]);
  await waitFor(() => last(s).state === "degraded", "degraded");
  assert.equal(last(s).detail, "2 tools offered; other down; locked refused its credential; off LAN: search, other");
  await s.stop();
});

test("with no tool enabled the detail says so, and a LAN-only service names no off-LAN server", async () => { // @spec TOOL-SVC-006
  const s = await startTools({ servers: { lan: { url: "http://192.168.1.9:9/mcp" } }, allow: {} }, [new FakeSource("lan", [def("x")])]);
  await waitFor(() => s.bus.health.some((h) => h.state === "ready"), "ready");
  assert.equal(last(s).detail, "0 tools offered; no tools enabled");
  await s.stop();
});

test("the heartbeat detail names no URL, userinfo or query string", async () => {  // @spec TOOL-SVC-006
  const down = new FakeSource("other", [def("x")]);
  down.state = "down";
  const s = await startTools({
    servers: { other: { url: "https://other.example.com:8443/mcp?key=URLSECRET", token: "TOKEN-SECRET" } },
    allow: { other__x: on("x") },
  }, [down]);
  await waitFor(() => last(s).state === "degraded", "degraded");
  const text = JSON.stringify(s.bus.health);
  for (const bad of ["URLSECRET", "TOKEN-SECRET", "https://", "http://", "8443", "other.example.com"]) assert.equal(text.includes(bad), false, bad);
  await s.stop();
});
