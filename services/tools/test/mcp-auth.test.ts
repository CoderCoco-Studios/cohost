import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeMcp, deadUrl, toolJson } from "./mcp-server.js";
import { Backoff, approved, catalogServer, entry, everythingOut, lastHealth, startMcp, waitFor, waitServer } from "./mcp-helpers.js";
import { resultOf } from "./helpers.js";

const web = toolJson("web");
const allow = { search__web: approved(web) };
const warns = (s: { log: { lines: { level: string }[] } }) => s.log.lines.filter((l) => l.level === "warn").map((l) => JSON.stringify(l));

// ---- TOOL-MCP-005: the secret header

const HEADER_CASES: { header: string; token: string; sent: Record<string, string | undefined> }[] = [
  { header: "", token: "tok-a", sent: { authorization: "Bearer tok-a" } },
  { header: "Authorization", token: "tok-b", sent: { authorization: "Bearer tok-b" } },
  { header: "AUTHORIZATION", token: "tok-c", sent: { authorization: "Bearer tok-c" } },
  { header: "authorization", token: "tok-d", sent: { authorization: "Bearer tok-d" } },
  { header: "X-Api-Key", token: "tok-e", sent: { "x-api-key": "tok-e", authorization: undefined } },
  { header: "", token: "", sent: { authorization: undefined, "x-api-key": undefined } },
  { header: "X-Api-Key", token: "", sent: { "x-api-key": undefined, authorization: undefined } },
];

for (const c of HEADER_CASES) {
  test(`header ${JSON.stringify(c.header)} with token ${JSON.stringify(c.token)} sends ${JSON.stringify(c.sent)} on every request`, async () => { // @spec TOOL-MCP-005
    const srv = await FakeMcp.start({ tools: [web] });
    const s = await startMcp({ servers: { search: entry(srv, { header: c.header, token: c.token }) }, allow });
    await waitServer(s, "search", "ok");
    await srv.waitUntil(() => srv.streams.length === 1, "the notification stream open");
    await resultOf(s, await s.request());
    assert.ok(srv.seen.length >= 5, "initialize, initialized, list, the stream and the call");
    for (const seen of srv.seen) {
      for (const [name, value] of Object.entries(c.sent)) {
        assert.equal(seen.headers[name], value, `${seen.httpMethod} ${seen.rpc?.method ?? ""}: ${name}`);
      }
    }
    await s.stop();
  });
}

// ---- TOOL-MCP-006: auth

for (const status of [401, 403]) {
  test(`a server that answers ${status} to initialize is auth, a down dependency, and leaves auth when a later reconnect succeeds`, async () => { // @spec TOOL-MCP-006
    const srv = await FakeMcp.start({ tools: [web] });
    let refuse: number | undefined = status;
    srv.auth = () => refuse;
    const bo = new Backoff();
    const s = await startMcp({ servers: { search: entry(srv, { token: "tok" }) }, allow }, { mcp: { retry: bo.retry } });
    await waitServer(s, "search", "auth");
    await waitFor(() => lastHealth(s).deps["mcp.search"] === "down", "the dependency down");
    assert.equal(lastHealth(s).state, "degraded");
    assert.match(catalogServer(s, "search")!.detail, /refused its credential/);
    assert.match(lastHealth(s).detail ?? "", /search refused its credential/);
    const r = await resultOf(s, await s.request());
    assert.deepEqual([r.status, r.reason], ["refused", "unknown_tool"]); // never listed: no catalog entry (TOOL-CALL-002)
    // still auth after another failed attempt
    await bo.next(); bo.release();
    await bo.next();
    assert.equal(catalogServer(s, "search")?.state, "auth");
    refuse = undefined;
    await waitFor(() => { bo.release(); return catalogServer(s, "search")?.state === "ok"; }, "ok after a later reconnect");
    await waitFor(() => lastHealth(s).deps["mcp.search"] === "ok", "the dependency ok");
    assert.equal((await resultOf(s, await s.request())).status, "ok");
    await s.stop();
  });

  test(`a ${status} on a later request of a connected session makes the server auth`, async () => { // @spec TOOL-MCP-006
    const srv = await FakeMcp.start({ tools: [web] });
    const s = await startMcp({ servers: { search: entry(srv, { token: "tok" }) }, allow }, { catalogMs: 40 });
    await waitServer(s, "search", "ok");
    srv.auth = () => status;
    await waitServer(s, "search", "auth");
    await s.stop();
  });
}

test("a call answered 401 or 403 is an error unavailable result and the server becomes auth", async () => { // @spec TOOL-MCP-006, TOOL-CALL-012
  const srv = await FakeMcp.start({ tools: [web] });
  srv.byMethod["tools/call"] = () => ({ status: 403, body: "forbidden" });
  const s = await startMcp({ servers: { search: entry(srv, { token: "tok" }) }, allow }, { mcp: { retry: new Backoff().retry } });
  await waitServer(s, "search", "ok");
  const r = await resultOf(s, await s.request());
  assert.deepEqual([r.status, r.reason], ["error", "unavailable"]);
  await waitServer(s, "search", "auth");
  await s.stop();
});

// ---- TOOL-MCP-007: no secret, userinfo or query string anywhere

test("neither the token, the URL's query string nor a redirect's userinfo appears in any event, heartbeat or log line, whatever the server does or echoes back", async () => { // @spec TOOL-MCP-007
  const TOKEN = "TOKEN-SECRET-xyz";
  const QUERY = "key=URLSECRET-abc&x=1";
  const srv = await FakeMcp.start({ tools: [web] });
  let phase: "500" | "401" | "ok" = "500";
  // The server reflects what it was sent: its token, its URL and a userinfo URL, in every body it can write.
  const echo = (seen: { headers: Record<string, unknown>; target: string }) => `you sent ${String(seen.headers.authorization)} to ${seen.target} see http://user:PASSWORD-s@${srv.host}:1/?key=URLSECRET-abc`;
  srv.before = (seen) => {
    if (phase === "500") return { status: 500, body: echo(seen) };
    if (phase === "401") return { status: 401, headers: { "www-authenticate": `Bearer error="${TOKEN}"` }, body: echo(seen) };
    return undefined;
  };
  let call = 0;
  srv.byMethod["tools/call"] = (seen, ctx) => {
    call++;
    if (call === 1) return { status: 302, headers: { location: `http://user:PASSWORD-s@${srv.host}:1/x?${QUERY}` } };
    if (call === 2) return { destroy: true };
    if (call === 3) return { status: 500, body: echo(seen) };
    if (call === 4) return { hang: true };
    return ctx.result({ content: [{ type: "text", text: "fine" }] });
  };
  const gone = await deadUrl("/mcp");
  const keyed = await FakeMcp.start({ tools: [web] });
  const s = await startMcp({
    servers: {
      search: entry(srv, { url: `${srv.url}?${QUERY}`, token: TOKEN }),
      gone: { url: `${gone}?${QUERY}`, token: TOKEN },
      keyed: entry(keyed, { url: `${keyed.url}?${QUERY}`, header: "X-Api-Key", token: TOKEN }),
    },
    allow,
    timeout_ms: 150,
  });
  await waitServer(s, "search", "down");
  phase = "401";
  await waitServer(s, "search", "auth");
  phase = "ok";
  await waitServer(s, "search", "ok");
  for (let i = 0; i < 4; i++) {
    await resultOf(s, await s.request());
    await waitFor(() => catalogServer(s, "search")?.state === "ok", "ok between calls");
  }
  await waitServer(s, "keyed", "ok");
  await s.stop();
  const out = everythingOut(s);
  for (const secret of [TOKEN, "URLSECRET", "PASSWORD"]) assert.equal(out.includes(secret), false, `${secret} leaked`);
});

test("a token with a line break is not sent as a second header and does not appear in any event or log line", async () => { // @spec TOOL-MCP-007, TOOL-MCP-005
  const srv = await FakeMcp.start({ tools: [web] });
  const s = await startMcp({ servers: { search: entry(srv, { token: "TOKEN-SECRET\r\nX-Evil: 1" }) }, allow });
  await waitFor(() => s.catalogs().length > 0, "catalog");
  // An absence test: give a client that does connect a bounded time to do so.
  await Promise.race([srv.waitUntil(() => srv.seen.length > 1, "traffic"), new Promise((r) => setTimeout(r, 400))]).catch(() => undefined);
  await s.stop();
  assert.equal(srv.seen.some((x) => x.headers["x-evil"] !== undefined), false);
  assert.equal(everythingOut(s).includes("TOKEN-SECRET"), false);
  assert.deepEqual(s.exits, []);
});

// ---- TOOL-MCP-008, TOOL-MCP-009: TLS note and external

test("a plain http server off the LAN with a secret says 'credential sent without TLS' in its detail; no other combination does", async () => { // @spec TOOL-MCP-008
  const lanOk = await FakeMcp.start({ tools: [web] });
  const s = await startMcp({
    servers: {
      "plain-off": { url: "http://203.0.113.7/mcp", token: "SECRET-1" },
      "tls-off": { url: "https://203.0.113.8/mcp", token: "SECRET-2" },
      nosecret: { url: "http://203.0.113.9/mcp" },
      "lan-cfg": { url: "http://203.0.113.10/mcp", token: "SECRET-3" },
      "lan-ok": entry(lanOk, { token: "SECRET-4" }),
    },
    allow: {},
  }, { extra: { network: { lan: ["203.0.113.10"] } } });
  await waitFor(() => catalogServer(s, "plain-off")?.detail.includes("credential sent without TLS") === true, "the note on plain-off");
  for (const name of ["tls-off", "nosecret", "lan-cfg", "lan-ok"]) assert.doesNotMatch(catalogServer(s, name)!.detail, /without TLS/, name);
  await waitServer(s, "lan-ok", "ok");
  assert.equal(lanOk.rpcs("initialize")[0]!.headers.authorization, "Bearer SECRET-4", "a server on the LAN is connected with its secret");
  assert.equal(everythingOut(s).includes("SECRET-"), false);
  await s.stop(); // unreachable servers must not hold the stop
});

test("a server is external when its host is off the LAN by the LAN rule or when external is true", async () => { // @spec TOOL-MCP-009
  const lan = await FakeMcp.start({ tools: [web] });
  const forced = await FakeMcp.start({ tools: [web] });
  const s = await startMcp({
    servers: {
      "far-ip": { url: "https://203.0.113.8/mcp" },
      "far-name": { url: "https://search.example.com/mcp" },
      "lan-ip": entry(lan),
      forced: entry(forced, { external: true }),
      "lan-cfg": { url: "https://203.0.113.10/mcp" },
    },
    allow: {},
  }, { extra: { network: { lan: ["203.0.113.10"] } } });
  await waitServer(s, "lan-ip", "ok");
  await waitServer(s, "forced", "ok");
  const ext = Object.fromEntries(s.catalogs().at(-1)!.servers.map((x) => [x.name, x.external]));
  assert.deepEqual(ext, { "far-ip": true, "far-name": true, "lan-ip": false, forced: true, "lan-cfg": false });
  assert.match(lastHealth(s).detail ?? "", /off LAN: [^;]*far-ip/);
  await s.stop();
});

// ---- TOOL-MCP-011: one start warning per off-LAN egress entry

test("it logs one warning for each off-LAN server at start, naming the server and the host, and none for a LAN server or in mock mode", async () => { // @spec TOOL-MCP-011
  const homelan = await FakeMcp.start({ tools: [web], host: "127.0.0.2" });
  const forced = await FakeMcp.start({ tools: [web] });
  const servers = {
    homelan: entry(homelan),
    forced: entry(forced, { url: `${forced.url}?key=URLSECRET`, external: true }),
    far: { url: "http://203.0.113.7:8080/mcp?key=URLSECRET" },
  };
  const s = await startMcp({ servers, allow: {} });
  await waitServer(s, "forced", "ok");
  await waitServer(s, "homelan", "ok");
  const w = warns(s);
  assert.equal(w.filter((l) => l.includes("127.0.0.2") || l.includes("homelan")).length, 0, "no warning for the LAN server");
  const forcedWarn = w.filter((l) => l.includes("127.0.0.1"));
  assert.equal(forcedWarn.length, 1, "one warning for the forced server");
  assert.ok(forcedWarn[0]!.includes("forced"), "it names the server");
  const farWarn = w.filter((l) => l.includes("203.0.113.7"));
  assert.ok(farWarn.length >= 1 && farWarn.some((l) => l.includes("far")), "a warning names the far server and its host");
  assert.equal(w.some((l) => l.includes("URLSECRET")), false);
  await s.stop();
  assert.equal(warns(s).filter((l) => l.includes("127.0.0.1")).length, 1, "once, not on every refresh");

  const m = await startMcp({ mode: "mock", servers, allow: {} });
  await waitFor(() => m.catalogs().length > 0, "catalog");
  assert.equal(warns(m).filter((l) => l.includes("127.0.0.1") || l.includes("203.0.113.7")).length, 0, "no egress in mock mode");
  await m.stop();
});
