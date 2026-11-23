import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeSource, def, on, search, startTools, waitFor } from "./helpers.js";

const names = (s: { catalogs: () => { tools: { name: string }[] }[] }) => s.catalogs().at(-1)!.tools.map((t) => t.name);

test("MCP tools are named <server>__<tool>; a name outside [A-Za-z0-9_-] is not listed", async () => { // @spec TOOL-CAT-001
  const src = new FakeSource("search", [def("web"), def("bad.name"), def("sp ace")]);
  const s = await startTools({ servers: { search }, allow: { search__web: on("web") } }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["search__web"]);
  assert.equal(s.entry("search__web").server, "search");
  await s.stop();
});

test("a tool is not listed for a long qualified name or a schema over 4000 characters, and the server detail counts them", async () => { // @spec TOOL-CAT-002
  const tooLong = "x".repeat(63); // search__ + 63 = 71 > 64
  const fits = "y".repeat(56); // search__ + 56 = 64
  const bigSchema = { type: "object", properties: { p: { description: "z".repeat(4000) } } };
  const src = new FakeSource("search", [def("web"), def(tooLong), def("fat", { parameters: bigSchema }), def("bad.name"), def(fits)]);
  const s = await startTools({ servers: { search }, allow: {} }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["search__web", `search__${fits}`]);
  const server = s.catalogs().at(-1)!.servers.find((x) => x.name === "search")!;
  assert.match(server.detail ?? "", /\b3\b/, "the detail says how many tools were not listed");
  await s.stop();
});

test("a schema of exactly 4000 serialized characters is listed", async () => { // @spec TOOL-CAT-002
  const pad = 4000 - JSON.stringify({ type: "object", d: "" }).length;
  const exact = { type: "object", d: "a".repeat(pad) };
  assert.equal(JSON.stringify(exact).length, 4000);
  const s = await startTools({ servers: { search }, allow: {} }, [new FakeSource("search", [def("web", { parameters: exact })])]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["search__web"]);
  await s.stop();
});

test("a listed MCP tool's description is cut to 400 characters and its title to 100", async () => { // @spec TOOL-CAT-003
  const src = new FakeSource("search", [def("web", { description: "d".repeat(500), title: "t".repeat(150) }), def("short", { description: "ok", title: "T" })]);
  const s = await startTools({ servers: { search }, allow: {} }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.equal(s.entry("search__web").description, "d".repeat(400));
  assert.equal(s.entry("search__web").title, "t".repeat(100));
  assert.equal(s.entry("search__short").description, "ok");
  await s.stop();
});

test("an MCP tool's label follows readOnlyHint: true is read, false is acts, absent is unlabelled", async () => { // @spec TOOL-CAT-005
  const src = new FakeSource("search", [def("r", {}, true), def("a", {}, false), def("u", {}, undefined)]);
  const s = await startTools({ servers: { search }, allow: {} }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(["r", "a", "u"].map((n) => s.entry(`search__${n}`).label), ["read", "acts", "unlabelled"]);
  await s.stop();
});

test("effect is acts when the label is not read or the acts mark is set, and read otherwise", async () => { // @spec TOOL-CAT-008
  const src = new FakeSource("search", [def("r", {}, true), def("a", {}, false), def("u", {}, undefined), def("marked", {}, true)]);
  const s = await startTools({ servers: { search }, allow: { search__marked: on("marked", { acts: true }) } }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(["r", "a", "u", "marked"].map((n) => s.entry(`search__${n}`).effect), ["read", "acts", "acts", "acts"]);
  await s.stop();
});

test("offered needs enabled, a usable server, a read label or the acts mark, and a matching pin; reason is the first that applies", async () => { // @spec TOOL-CAT-006, TOOL-CAT-007
  const src = new FakeSource("search", [
    def("good"), def("off"), def("acting", {}, false), def("unpinned"), def("moved", { hash: "new" }), def("both", { hash: "new" }, false),
  ]);
  const downSrc = new FakeSource("dead", [def("x"), def("y")]);
  downSrc.state = "down";
  const s = await startTools({
    servers: { search, dead: { url: "https://dead.example.com/mcp" } },
    allow: {
      search__good: on("good"),
      search__off: { enabled: false, hash: "h-off" },
      search__acting: on("acting"), // enabled, label acts, no acts mark
      search__unpinned: { enabled: true }, // no recorded hash
      search__moved: on("moved"), // recorded hash differs from the listed one
      search__both: { enabled: true }, // acts_not_allowed outranks not_approved
      dead__x: on("x"),
    },
  }, [src, downSrc]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const at = (n: string) => { const e = s.entry(n); return [e.offered, e.reason]; };
  assert.deepEqual(at("search__good"), [true, undefined]);
  assert.deepEqual(at("search__off"), [false, "not_enabled"]);
  assert.deepEqual(at("search__acting"), [false, "acts_not_allowed"]);
  assert.deepEqual(at("search__unpinned"), [false, "not_approved"]);
  assert.deepEqual(at("search__moved"), [false, "changed"]);
  assert.deepEqual(at("search__both"), [false, "acts_not_allowed"]);
  assert.deepEqual(at("dead__x"), [false, "server_down"]);
  assert.deepEqual(at("dead__y"), [false, "not_enabled"], "not_enabled outranks server_down");
  await s.stop();
});

test("an acting tool with its acts mark and a matching pin is offered; an auth server's tools are server_down", async () => { // @spec TOOL-CAT-006, TOOL-CAT-007
  const src = new FakeSource("search", [def("post", {}, false)]);
  const authSrc = new FakeSource("locked", [def("x")]);
  authSrc.state = "auth";
  const s = await startTools({
    servers: { search, locked: { url: "https://locked.example.com/mcp" } },
    allow: { search__post: on("post", { acts: true }), locked__x: on("x") },
  }, [src, authSrc]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.equal(s.entry("search__post").offered, true);
  assert.equal(s.entry("locked__x").reason, "server_down");
  assert.equal(s.catalogs().at(-1)!.servers.find((x) => x.name === "locked")!.state, "auth");
  await s.stop();
});

test("the catalog lists each tool with name, server, title, description, parameters, label, effect, marks, hash, offered and reason", async () => { // @spec TOOL-CAT-009
  const params = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  const src = new FakeSource("search", [def("web", { title: "Web search", description: "Searches.", parameters: params, hash: "abc123" })]);
  const s = await startTools({ servers: { search }, allow: { search__web: { enabled: true, chat: true, confirm: false, hash: "abc123" } } }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(s.entry("search__web"), {
    name: "search__web", server: "search", title: "Web search", description: "Searches.", parameters: params,
    label: "read", effect: "read", enabled: true, acts: false, chat: true, confirm: false, hash: "abc123", offered: true,
  });
  await s.stop();
});

test("a tool the server gives no title lists none, and a not-enabled tool carries default marks and a reason", async () => { // @spec TOOL-CAT-009
  const s = await startTools({ servers: { search }, allow: {} }, [new FakeSource("search", [def("web")])]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const e = s.entry("search__web");
  assert.equal("title" in e, false);
  assert.deepEqual([e.enabled, e.acts, e.chat, e.confirm, e.offered, e.reason], [false, false, false, true, false, "not_enabled"]);
  await s.stop();
});

test("the catalog lists every configured server with name, state, external and a detail sentence", async () => { // @spec TOOL-CAT-010
  const down = new FakeSource("dead", []);
  down.state = "down";
  const s = await startTools({
    servers: { search, dead: { url: "https://dead.example.com/mcp", external: true }, lan: { url: "http://192.168.1.20:8080/mcp" } },
    allow: {},
  }, [new FakeSource("search", [def("web")]), down, new FakeSource("lan", [])]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const servers = s.catalogs().at(-1)!.servers;
  assert.deepEqual(servers.map((x) => [x.name, x.state, x.external]), [["search", "ok", true], ["dead", "down", true], ["lan", "ok", false]]);
  for (const x of servers) assert.ok(typeof x.detail === "string" && x.detail.length > 0, `detail sentence for ${x.name}`);
  await s.stop();
});

test("tool.catalog is published when ready, on a change of tools or server state, and every catalog_ms with intervalMs", async () => { // @spec TOOL-CAT-011
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const src = new FakeSource("search", [def("web")]);
    const s = await startTools({ servers: { search }, allow: {}, catalog_ms: 7000 }, [src]);
    await waitFor(() => s.bus.health.some((h) => h.state === "ready"), "ready");
    assert.equal(s.catalogs().length, 1, "one catalog when the service becomes ready");
    assert.equal(s.catalogs()[0]!.intervalMs, 7000);
    assert.equal(s.bus.types().indexOf("tool.catalog") >= 0, true);

    src.defs = [def("web"), def("more")];
    src.change();
    await waitFor(() => s.catalogs().length === 2, "catalog after a tool list change");
    assert.deepEqual(names(s), ["search__web", "search__more"]);

    src.state = "down";
    src.change();
    await waitFor(() => s.catalogs().length === 3, "catalog after a server state change");
    assert.equal(s.catalogs().at(-1)!.servers[0]!.state, "down");

    await new Promise((r) => setImmediate(r));
    assert.equal(s.catalogs().length, 3, "no publication without a change before the interval");
    mock.timers.tick(7000);
    await waitFor(() => s.catalogs().length === 4, "catalog at the interval");
    mock.timers.tick(7000);
    await waitFor(() => s.catalogs().length === 5, "catalog at the next interval");
    assert.equal(s.catalogs().every((c) => c.intervalMs === 7000), true);
    await s.stop();
  } finally { mock.timers.reset(); }
});

test("the catalog describes the marks of the config loaded at start: config is read once", async () => { // @spec TOOL-CAT-012
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const src = new FakeSource("search", [def("web")]);
    const s = await startTools({ servers: { search }, allow: { search__web: on("web") }, catalog_ms: 5000 }, [src]);
    await waitFor(() => s.catalogs().length === 1, "first catalog");
    assert.equal(s.cfgLoads, 1);
    mock.timers.tick(5000);
    await waitFor(() => s.catalogs().length === 2, "second catalog");
    assert.equal(s.cfgLoads, 1, "the config is not read again");
    assert.equal(s.catalogs().at(-1)!.tools[0]!.enabled, true);
    await s.stop();
  } finally { mock.timers.reset(); }
});

test("at most max_tools_per_server tools of one server are listed, and the cut tools are counted in the server's detail", async () => { // @spec TOOL-CAT-013, TOOL-CAT-014
  const src = new FakeSource("search", [def("a"), def("b"), def("c"), def("d")]);
  const s = await startTools({ servers: { search }, allow: {}, max_tools_per_server: 2 }, [src]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["search__a", "search__b"], "the first tools in the server's own order are kept");
  assert.match(s.catalogs().at(-1)!.servers[0]!.detail ?? "", /\b2\b/, "two tools were left out");
  await s.stop();
});

test("at most max_tools are listed in all, servers in tools.servers order, enabled or not", async () => { // @spec TOOL-CAT-013, TOOL-CAT-014
  const zeta = new FakeSource("zeta", [def("a"), def("b")]);
  const alpha = new FakeSource("alpha", [def("a"), def("b")]);
  const s = await startTools({
    servers: { zeta: { url: "https://z.example.com/mcp" }, alpha: { url: "https://a.example.com/mcp" } },
    allow: { alpha__b: on("b") }, max_tools: 3,
  }, [alpha, zeta]); // the order the sources are handed over must not decide
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["zeta__a", "zeta__b", "alpha__a"]);
  assert.equal(s.entry("alpha__b"), undefined, "a tool past the limit cannot be enabled");
  const alphaServer = s.catalogs().at(-1)!.servers.find((x) => x.name === "alpha")!;
  assert.match(alphaServer.detail ?? "", /\b1\b/);
  await s.stop();
});

test("an allow entry naming no listed tool is offered to nothing and does not appear in the catalog", async () => { // @spec TOOL-CAT-015
  const s = await startTools({ servers: { search }, allow: { search__ghost: on("ghost"), gone__x: on("x"), search__web: on("web") } }, [new FakeSource("search", [def("web")])]);
  await waitFor(() => s.catalogs().length > 0, "catalog");
  assert.deepEqual(names(s), ["search__web"]);
  assert.equal(s.catalogs().at(-1)!.tools.some((t) => t.offered && t.name !== "search__web"), false);
  await s.stop();
});
