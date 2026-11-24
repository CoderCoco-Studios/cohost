import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, SECTION_PATHS, sectionJsonSchema, sectionPresentation, sectionSecrets, readSection } from "@cohost/config";
import { act, screen, userEvent, waitFor, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";
import type { TestApp } from "./helpers/render";

// The Tools settings page: the `mcp-servers` widget of tools.servers and the `tool-list` widget of tools.allow, driven by
// the real schema and presentation of the config package and by the tool.catalog the page hears on the feed. Everything a
// server or its tools say about themselves is untrusted text: shown as text, never as markup.
//
// Contract these tests set for the markup: a server row is `[data-server="<name>"]`, a tool row `[data-tool="<name>"]`, the
// add form has the fields Name, URL, Header name, Token and External and the button `Add server`, a server row has the button
// `Remove <name>`, a tool row has the switches Allowed, May act, Usable for viewer chat and (for acting tools) Ask me before it
// runs, and an allow entry no listed tool matches has the button `Remove <name>` in a row marked `[data-tool="<name>"]`.
// Edits are either staged for the Save bar or written by the control itself: the tests press Save when it is there.

const real = {
  groups: GROUPS,
  sections: SECTION_PATHS.map((path) => ({ path, ...sectionPresentation(path), services: ["voice"], schema: sectionJsonSchema(path), secrets: sectionSecrets(path) })),
};

const BASE_YAML = `tools:
  servers:
    weather:
      url: https://user:pw@api.example.com:8443/mcp?token=SECRETVAL&mode=fast
      header: X-Api-Key
      external: true
    lan:
      url: http://192.168.1.20:9000/mcp
  allow:
    weather__forecast:
      enabled: true
      hash: h1
    weather__post:
      enabled: true
      acts: true
      hash: p1
    gone__thing:
      enabled: true
`;

interface CatTool { name: string; description?: string; label?: "read" | "acts" | "unlabelled"; effect?: "read" | "acts"; enabled?: boolean; acts?: boolean; chat?: boolean; confirm?: boolean; offered?: boolean; server?: string; hash?: string; reason?: string }
const catTool = (o: CatTool) => ({ description: `${o.name} does a thing`, parameters: {}, label: "read", effect: "read", enabled: false, acts: false, chat: false, confirm: true, offered: false, ...o });
const catalog = (tools: CatTool[], servers: { name: string; state?: string; external?: boolean; left_out?: number; detail?: string }[] = [{ name: "weather" }, { name: "lan" }], intervalMs = 30000) => ({
  intervalMs, mode: "live",
  servers: servers.map((s) => ({ state: "ok", external: false, left_out: 0, ...s })),
  tools: tools.map(catTool),
});

const WEATHER_TOOLS: CatTool[] = [
  { name: "stream_info", label: "read", enabled: false },
  { name: "timer", label: "acts", effect: "acts", description: "Sets a timer." },
  { name: "weather__forecast", label: "read", enabled: true, offered: true, server: "weather", hash: "h1", description: "Gives the forecast for a city." },
  { name: "weather__post", label: "acts", effect: "acts", enabled: true, acts: true, offered: true, server: "weather", hash: "p1", description: "Posts a message." },
];

async function open(opts: { yaml?: string; cat?: ReturnType<typeof catalog> | null; secretsSet?: string[]; putStatus?: number; secretStatus?: number } = {}) {
  const yaml = opts.yaml ?? BASE_YAML;
  const routes: Record<string, Parameters<TestApp["fetch"]["on"]>[1]> = {
    "GET /config/tools": { json: { section: "tools", etag: "e1", ...readSection(yaml, "tools", opts.secretsSet ?? []) } },
    "PUT /config/tools": opts.putStatus && opts.putStatus !== 200
      ? { status: opts.putStatus, json: { ok: false, etag: "e9" } }
      : { json: { ok: true, etag: "e2", restart: ["tools", "cortex", "salience"], warnings: [] } },
    "PUT /secrets": { json: { ok: true, set: {}, restart: ["tools", "cortex", "salience"] } },
  };
  const b = boot({ section: "tools", schema: real, routes });
  b.app.rt.access.setToken("control", "tok", "tab");
  act(() => { b.app.socket().open(); });
  await screen.findByRole("heading", { level: 1 });
  await settle(3);
  const put = (path: string, status = opts.secretStatus ?? 200) => b.app.fetch.on(`PUT ${path}`, status === 200 ? { json: { ok: true, set: true, restart: ["tools", "cortex", "salience"] } } : { status, json: { ok: false, detail: "nope" } });
  void put;
  if (opts.cat !== null) pushCatalog(b.app, opts.cat ?? catalog(WEATHER_TOOLS));
  await settle(2);
  return b;
}
let seq = 0;
const pushCatalog = (app: TestApp, data: ReturnType<typeof catalog>) => act(() => { app.socket().message({ id: `cat-${++seq}`, type: "tool.catalog", ts: app.clock.now, source: "tools", data }); });
const server = (name: string) => document.querySelector<HTMLElement>(`[data-server="${name}"]`)!;
const toolRow = (name: string) => document.querySelector<HTMLElement>(`[data-tool="${name}"]`)!;
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const sw = (row: HTMLElement, name: string) => within(row).getByRole("switch", { name }) as HTMLInputElement;
const puts = (app: TestApp) => app.fetch.callsTo("PUT /config/tools");
const body = (c: { body?: string }) => JSON.parse(c.body ?? "null") as { etag: string; values: Record<string, Record<string, Record<string, unknown>>> };
const lastValues = (app: TestApp) => body(puts(app).at(-1)!).values;
const secretCalls = (app: TestApp) => app.fetch.calls.filter((c) => c.method === "PUT" && c.path.startsWith("/secrets"));

async function save() {
  const user = userEvent.setup();
  const btn = within(screen.getByRole("group", { name: "Save settings" })).queryByRole("button", { name: "Save" }) as HTMLButtonElement | null;
  if (btn && !btn.disabled) await user.click(btn);
  await settle(4);
}

// ---- servers -------------------------------------------------------------------------------------------------------

// @spec DASH-TOOL-006
test("tools.servers is one row per server with its name and URL without userinfo or query string, and the state and detail of the latest catalog", async () => {
  await open({ cat: catalog(WEATHER_TOOLS, [{ name: "weather", state: "down", detail: "connection refused; 3 tools listed" }, { name: "lan", state: "auth", detail: "the server answered 401" }]) });
  const w = server("weather"), l = server("lan");
  assert.ok(w && l);
  assert.deepEqual([...document.querySelectorAll("[data-server]")].map((e) => e.getAttribute("data-server")), ["weather", "lan"]);
  assert.match(text(w), /weather/);
  assert.match(text(w), /api\.example\.com:8443\/mcp/, "host, port and path stay");
  for (const hidden of ["user:pw", "pw@", "SECRETVAL", "token=", "mode=fast"]) assert.equal(text(w).includes(hidden), false, `the row does not show ${hidden}`);
  assert.equal(document.body.innerHTML.includes("SECRETVAL"), false, "the credential in the query is in no attribute either");
  assert.equal(document.body.innerHTML.includes("user:pw"), false);
  assert.match(text(w), /down/i);
  assert.match(text(w), /connection refused/);
  assert.match(text(l), /auth/i);
  assert.match(text(l), /answered 401/);
  assert.match(text(l), /192\.168\.1\.20:9000\/mcp/);
});

// @spec DASH-TOOL-006
test("a server name, URL and detail that hold markup are shown as text: no element is made from them", async () => {
  const evil = '<img src=x onerror="alert(1)"><b>b</b>';
  const yaml = `tools:\n  servers:\n    "${"x"}":\n      url: "http://h.example/${encodeURIComponent(evil)}"\n`;
  await open({ yaml, cat: catalog([], [{ name: "x", state: "down", detail: `${evil}<script>alert(2)</script> [l](http://e.example)` }]) });
  const row = server("x");
  assert.ok(row);
  assert.equal(row.querySelector("img, b, script, a[href^='javascript'], iframe, svg"), null);
  assert.equal(row.querySelectorAll("[onerror]").length, 0);
  assert.ok(text(row).includes("<script>alert(2)</script>"));
});

// @spec DASH-TOOL-006
test("a URL that cannot be parsed still makes a row, and the page does not throw", async () => {
  await open({ yaml: "tools:\n  servers:\n    odd:\n      url: not a url at all\n", cat: null });
  assert.ok(server("odd"));
});

// @spec DASH-TOOL-006, DASH-TOOL-023
test("with no catalog yet every saved server is still listed, from the file, with no state", async () => {
  await open({ cat: null });
  assert.ok(server("weather") && server("lan"));
  assert.doesNotMatch(text(server("weather")), /\b(ok|down|auth|mock)\b/i);
});

// @spec DASH-TOOL-007, DASH-SECRET-013
test("Add server takes a name, URL, header name, token and External, writes the map and then the secret, with the control token, and offers the restart of tools, cortex and salience", async () => {
  const b = await open();
  b.app.fetch.on("PUT /secrets/tools.servers.search.token", { json: { ok: true, set: true, restart: ["tools", "cortex", "salience"] } });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "search");
  await user.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.example.org/v1");
  await user.type(screen.getByRole("textbox", { name: "Header name" }), "X-Key");
  await user.type(screen.getByLabelText("Token"), "mcp-SECRET-77");
  await user.click(screen.getByRole("switch", { name: "External" }));
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await save();
  await waitFor(() => assert.equal(secretCalls(b.app).length >= 1, true));
  const servers = lastValues(b.app).servers as unknown as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(servers).sort(), ["lan", "search", "weather"], "the map keeps the servers it had");
  assert.equal(servers.search!.url, "https://mcp.example.org/v1");
  assert.equal(servers.search!.header, "X-Key");
  assert.equal(servers.search!.external, true);
  assert.equal("token" in servers.search!, false, "the secret is not in the map");
  assert.equal(puts(b.app).at(-1)!.headers.authorization, "Bearer tok");
  const secret = secretCalls(b.app).find((c) => c.path === "/secrets/tools.servers.search.token" || (c.path === "/secrets" && (c.body ?? "").includes("tools.servers.search.token")))!;
  assert.ok(secret, "the token goes to the secret route");
  assert.equal(secret.headers.authorization, "Bearer tok");
  assert.ok((secret.body ?? "").includes("mcp-SECRET-77"));
  assert.ok(b.app.fetch.calls.indexOf(puts(b.app).at(-1)!) < b.app.fetch.calls.indexOf(secret), "the saved map comes first: the secret route refuses a server the file does not hold");
  assert.equal(JSON.stringify(puts(b.app).map((c) => c.body)).includes("mcp-SECRET-77"), false, "the token is in no config write");
  assert.equal(document.body.innerHTML.includes("mcp-SECRET-77"), false, "and in no DOM after saving");
  const banner = screen.getByRole("region", { name: "Restart needed" });
  for (const u of ["tools", "cortex", "salience"]) assert.match(text(banner), new RegExp(u));
});

// @spec DASH-TOOL-007
test("a server added with no token sends no secret, and a blank header and External off are not made up", async () => {
  const b = await open();
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "plain");
  await user.type(screen.getByRole("textbox", { name: "URL" }), "http://192.168.1.9:7000/mcp");
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await save();
  await waitFor(() => assert.ok(puts(b.app).length >= 1));
  const entry = (lastValues(b.app).servers as unknown as Record<string, Record<string, unknown>>).plain!;
  assert.equal(entry.url, "http://192.168.1.9:7000/mcp");
  assert.notEqual(entry.external, true);
  assert.equal(secretCalls(b.app).length, 0);
});

// @spec DASH-TOOL-007
test("a map write that fails (409 changed file, 400 invalid) sends no secret: a token is never stored for a server the file does not hold", async () => {
  for (const putStatus of [409, 400]) {
    const b = await open({ putStatus });
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "search");
    await user.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.example.org/v1");
    await user.type(screen.getByLabelText("Token"), "mcp-SECRET-78");
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await save();
    assert.equal(secretCalls(b.app).length, 0, String(putStatus));
    assert.equal(document.body.innerHTML.includes("mcp-SECRET-78"), false, "and the typed token is not echoed into the page");
    b.unmount();
    document.body.innerHTML = "";
  }
});

// @spec DASH-TOOL-007
test("a name that breaks the grammar of config, a name already in use and a URL with userinfo are refused on the page with no write; an existing server's URL and token are never overwritten by an add", async () => {
  const b = await open();
  const user = userEvent.setup();
  const add = async (name: string, url: string, token = "") => {
    const n = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    const u = screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement;
    await user.clear(n); await user.clear(u);
    if (name) await user.type(n, name);
    if (url) await user.type(u, url);
    if (token) await user.type(screen.getByLabelText("Token"), token);
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await save();
  };
  await add("Bad_Name", "https://ok.example/mcp");
  await add("has space", "https://ok.example/mcp");
  await add("UPPER", "https://ok.example/mcp");
  await add("a".repeat(33), "https://ok.example/mcp");
  await add("fine", "ftp://ok.example/mcp");
  await add("fine", "https://user:pw@ok.example/mcp");
  await add("fine", "");
  await add("weather", "https://evil.example/mcp", "stolen-SECRET");
  assert.equal(puts(b.app).length, 0, "nothing was written");
  assert.equal(secretCalls(b.app).length, 0);
  assert.ok(screen.queryAllByRole("alert").length > 0, "the refusal is told");
});

// @spec DASH-TOOL-008
test("no request is made to probe a URL that is not saved: typing a URL and a token into the add form causes no request at all", async () => {
  const b = await open();
  const before = b.app.fetch.calls.length;
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "search");
  await user.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.example.org/v1");
  await user.type(screen.getByLabelText("Token"), "mcp-SECRET-79");
  await settle(3);
  assert.equal(b.app.fetch.calls.length, before);
  assert.equal(b.app.fetch.calls.some((c) => /probe|options|mcp\.example\.org/.test(c.path)), false);
});

// @spec DASH-TOOL-007
test("the form says the server's tools appear only after tools has restarted and connected", async () => {
  await open();
  assert.match(text(document.body), /appear.*(after|once).*(restart|connect)/i);
});

// @spec DASH-TOOL-009, DASH-SECRET-014
test("Remove clears the server's secret first, with a null and the control token, and then removes its entry from the map, in the same save", async () => {
  const b = await open({ secretsSet: ["tools.servers.weather.token"] });
  b.app.fetch.on("PUT /secrets/tools.servers.weather.token", { json: { ok: true, set: false, restart: ["tools", "cortex", "salience"] } });
  await userEvent.setup().click(within(server("weather")).getByRole("button", { name: "Remove weather" }));
  await save();
  await waitFor(() => assert.ok(secretCalls(b.app).length >= 1 && puts(b.app).length >= 1));
  const clear = secretCalls(b.app).find((c) => c.path === "/secrets/tools.servers.weather.token" || (c.path === "/secrets" && (c.body ?? "").includes("tools.servers.weather.token")))!;
  assert.ok(clear);
  const sent = JSON.parse(clear.body!) as { value?: null; values?: Record<string, null> };
  assert.ok(sent.value === null || sent.values?.["tools.servers.weather.token"] === null, "a null clears");
  assert.equal(clear.headers.authorization, "Bearer tok");
  assert.deepEqual(Object.keys(lastValues(b.app).servers as object), ["lan"]);
  assert.ok(b.app.fetch.calls.indexOf(clear) < b.app.fetch.calls.indexOf(puts(b.app).at(-1)!), "the secret goes first, then the entry (DASH-TOOL-009)");
});

// @spec DASH-TOOL-009
test("a server whose secret cannot be cleared stays listed, nothing is written to the map, and the failure is shown as an alert", async () => {
  const b = await open({ secretsSet: ["tools.servers.weather.token"] });
  b.app.fetch.on("PUT /secrets/tools.servers.weather.token", { status: 500, json: { ok: false, detail: "disk full" } });
  await userEvent.setup().click(within(server("weather")).getByRole("button", { name: "Remove weather" }));
  await save();
  await waitFor(() => assert.ok(screen.queryAllByRole("alert").some((a) => /disk full/.test(text(a)))));
  assert.equal(puts(b.app).length, 0);
  assert.ok(server("weather"), "still listed");
});

// @spec DASH-TOOL-009
test("a server whose map write fails after its secret was cleared leaves the server listed and shows the failure as an alert", async () => {
  const b = await open({ secretsSet: ["tools.servers.weather.token"], putStatus: 409 });
  b.app.fetch.on("PUT /secrets/tools.servers.weather.token", { json: { ok: true, set: false, restart: ["tools"] } });
  await userEvent.setup().click(within(server("weather")).getByRole("button", { name: "Remove weather" }));
  await save();
  await waitFor(() => assert.ok(screen.queryAllByRole("alert").length > 0));
  assert.equal(secretCalls(b.app).length, 1, "the secret was cleared first");
  assert.ok(server("weather"), "the entry was not removed");
});

// @spec DASH-TOOL-006
test("each server's real token state is read from its own secret key: a server with a token shows token set and one without shows no token", async () => {
  await open({ secretsSet: ["tools.servers.weather.token"] });
  assert.match(text(server("weather")), /token set/);
  assert.doesNotMatch(text(server("weather")), /no token/);
  assert.match(text(server("lan")), /no token/);
  assert.doesNotMatch(text(server("lan")), /token set/);
  assert.equal(document.querySelectorAll("[data-key^='servers.']").length, 0, "no row of its own for a server's token key");
});

// @spec DASH-TOOL-007
test("a map write that succeeds followed by a secret write that fails shows the alert `server added without a token`, and the server stays listed", async () => {
  const b = await open();
  b.app.fetch.on("PUT /secrets/tools.servers.search.token", { status: 500, json: { ok: false, detail: "nope" } });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "search");
  await user.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.example.org/v1");
  await user.type(screen.getByLabelText("Token"), "mcp-SECRET-81");
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await save();
  await waitFor(() => assert.ok(screen.queryAllByRole("alert").some((a) => /server added without a token/.test(text(a)))));
  assert.ok(server("search"), "the server was added");
  assert.equal(document.body.innerHTML.includes("mcp-SECRET-81"), false);
});

// @spec DASH-TOOL-010
test("an external server shows `tool requests go to <host>` beside its URL, host only, and the without-TLS detail when the catalog reports it; a server that is not external shows neither note", async () => {
  await open({ cat: catalog(WEATHER_TOOLS, [{ name: "weather", external: true, detail: "connected; credential sent without TLS" }, { name: "lan", external: false, detail: "connected" }]) });
  const w = text(server("weather"));
  assert.match(w, /tool requests go to api\.example\.com/);
  assert.doesNotMatch(w, /tool requests go to [^.]*(user|pw|SECRETVAL|\/mcp)/);
  assert.match(w, /credential sent without TLS/);
  assert.doesNotMatch(text(server("lan")), /tool requests go to/);
});

// @spec DASH-TOOL-010
test("the external note follows the catalog's external flag too, so a server external by its host (not by the switch) shows it", async () => {
  await open({ cat: catalog(WEATHER_TOOLS, [{ name: "weather", external: false }, { name: "lan", external: true }]) });
  assert.match(text(server("lan")), /tool requests go to 192\.168\.1\.20/);
});

// @spec DASH-TOOL-011
test("the page states beside tools.servers that cohost cannot see what a server on the LAN itself sends on", async () => {
  await open();
  assert.match(text(document.body), /cohost cannot see what a server on the LAN itself sends on/i);
});

// @spec DASH-TOOL-012
test("a URL query parameter named like a credential gets an advisory that a secret belongs in the header, naming the parameter and never its value; an ordinary parameter gets none", async () => {
  const yaml = `tools:\n  servers:\n    a:\n      url: https://h.example/mcp?api_key=KEYVALUE&mode=x\n    b:\n      url: https://h.example/mcp?mode=x&page=2\n    c:\n      url: https://h.example/mcp?token=T1&secret=S2\n`;
  await open({ yaml, cat: null });
  assert.match(text(server("a")), /api_key/);
  assert.match(text(server("a")), /header/i);
  assert.equal(text(server("a")).includes("KEYVALUE"), false);
  assert.doesNotMatch(text(server("b")), /belongs in the header|advis/i);
  assert.match(text(server("c")), /token/);
  assert.match(text(server("c")), /secret/);
  assert.equal(/T1|S2/.test(text(server("c"))), false);
  assert.equal(document.body.innerHTML.includes("KEYVALUE"), false);
});

// @spec DASH-TOOL-013
test("the count of tools a server's limits left out is read from the catalog's left_out member and shown on its row, and a server that left none out shows none", async () => {
  await open({ cat: catalog(WEATHER_TOOLS, [{ name: "weather", left_out: 5, detail: "connected; 32 tools listed" }, { name: "lan", left_out: 0, detail: "connected; 2 tools listed" }]) });
  assert.match(text(server("weather")), /5 left out/);
  assert.doesNotMatch(text(server("lan")), /left out/);
});

// ---- tools ---------------------------------------------------------------------------------------------------------

// @spec DASH-TOOL-014
test("the catalog's tools are listed under their server or Built in, each with its name, its description as plain text, a badge for its label shown as the server's claim, and the three switches", async () => {
  await open({
    cat: catalog([
      ...WEATHER_TOOLS,
      { name: "weather__mystery", label: "unlabelled", effect: "acts", server: "weather", description: '<img src=x onerror="alert(1)"><b>bold</b> **md** [l](http://e.example) <script>alert(2)</script>' },
    ]),
  });
  const groups = [...document.querySelectorAll<HTMLElement>("[data-tool-group]")].map((g) => g.getAttribute("data-tool-group"));
  assert.deepEqual(groups.slice().sort(), ["Built in", "weather"]);
  const builtIn = document.querySelector<HTMLElement>('[data-tool-group="Built in"]')!;
  assert.ok(builtIn.contains(toolRow("stream_info")) && builtIn.contains(toolRow("timer")));
  assert.ok(document.querySelector('[data-tool-group="weather"]')!.contains(toolRow("weather__forecast")));
  assert.match(text(toolRow("weather__forecast")), /weather__forecast/);
  assert.match(text(toolRow("weather__forecast")), /Gives the forecast for a city\./);
  assert.match(text(toolRow("weather__forecast")), /Read only/);
  assert.match(text(toolRow("weather__post")), /Changes things/);
  assert.match(text(toolRow("weather__mystery")), /Not labelled by the server/);
  for (const n of ["weather__forecast", "weather__post", "stream_info"]) {
    for (const s of ["Allowed", "May act", "Usable for viewer chat"]) assert.ok(sw(toolRow(n), s), `${n}: ${s}`);
  }
  const evil = toolRow("weather__mystery");
  assert.equal(evil.querySelector("img, b, script, a, iframe, svg"), null);
  assert.equal(evil.querySelectorAll("[onerror]").length, 0);
  assert.ok(text(evil).includes("<script>alert(2)</script>"));
  assert.ok(text(evil).includes("**md**"));
});

// @spec DASH-TOOL-014
test("a tool name or server name that is markup is text in the group heading and the row", async () => {
  const evil = "<img src=x onerror=alert(1)>";
  await open({ cat: catalog([{ name: `${evil}__t`, server: evil }], [{ name: evil }]) });
  assert.equal(document.querySelector("main img, [role=main] img"), null);
  assert.equal(document.querySelectorAll("[onerror]").length, 0);
  assert.ok(text(document.body).includes(evil));
});

// @spec DASH-TOOL-015
test("the switches write enabled, acts and chat of the tool's tools.allow entry, keeping the entry's other members", async () => {
  const b = await open({ cat: catalog([{ name: "stream_info" }, { name: "weather__forecast", server: "weather", hash: "h1", enabled: true, offered: true }]) });
  const user = userEvent.setup();
  await user.click(sw(toolRow("stream_info"), "Allowed"));
  await user.click(sw(toolRow("stream_info"), "Usable for viewer chat"));
  await user.click(sw(toolRow("weather__forecast"), "May act"));
  await save();
  const allow = lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>;
  assert.equal(allow.stream_info!.enabled, true);
  assert.equal(allow.stream_info!.chat, true);
  assert.notEqual(allow.stream_info!.acts, true);
  assert.equal(allow.weather__forecast!.acts, true);
  assert.equal(allow.weather__forecast!.enabled, true);
  assert.equal(allow.weather__forecast!.hash, "h1", "a switch does not drop the pinned hash");
  assert.ok("weather__post" in allow, "the other entries are written back");
});

// @spec DASH-TOOL-015
test("no switch is on for a tool the owner has not switched on: May act, Usable for viewer chat and Ask me before it runs are off and cannot be turned on, even for an entry that says acts: true while enabled is false", async () => {
  const yaml = `tools:\n  allow:\n    weather__post:\n      enabled: false\n      acts: true\n    stream_info:\n      chat: true\n`;
  await open({ yaml, cat: catalog([{ name: "weather__post", label: "acts", effect: "acts", server: "weather" }, { name: "stream_info" }]) });
  for (const n of ["weather__post", "stream_info"]) {
    for (const s of ["May act", "Usable for viewer chat"]) {
      const el = sw(toolRow(n), s);
      assert.equal(el.checked, false, `${n}: ${s} is off`);
      assert.equal(el.disabled, true, `${n}: ${s} cannot be turned on while Allowed is off`);
    }
  }
  const confirmSw = within(toolRow("weather__post")).queryByRole("switch", { name: "Ask me before it runs" }) as HTMLInputElement | null;
  if (confirmSw) { assert.equal(confirmSw.checked, false); assert.equal(confirmSw.disabled, true); }
});

// @spec DASH-TOOL-015
test("turning Allowed off turns the tool's May act and Usable for viewer chat off in the same write", async () => {
  const b = await open();
  await userEvent.setup().click(sw(toolRow("weather__post"), "Allowed"));
  await save();
  const entry = (lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>).weather__post!;
  assert.equal(entry.enabled, false);
  assert.equal(entry.acts, false);
  assert.notEqual(entry.chat, true);
});

// @spec DASH-TOOL-016
test("approving an MCP tool shows its description in full and writes enabled and the catalog entry's hash together; a built-in tool writes no hash", async () => {
  const long = `Posts a message to the stream chat. ${"It can also pin it, tag users and schedule it for later. ".repeat(6)}END-OF-DESCRIPTION`;
  const b = await open({ yaml: "tools:\n  allow: {}\n", cat: catalog([{ name: "weather__post", label: "acts", effect: "acts", server: "weather", hash: "hash-A", description: long }, { name: "stream_info", description: "Reads the stream title." }]) });
  const row = toolRow("weather__post");
  assert.ok(text(row).includes("END-OF-DESCRIPTION"), "the description is shown in full to the owner who approves it");
  await userEvent.setup().click(sw(row, "Allowed"));
  await userEvent.setup().click(sw(toolRow("stream_info"), "Allowed"));
  await save();
  const allow = lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>;
  assert.equal(allow.weather__post!.enabled, true);
  assert.equal(allow.weather__post!.hash, "hash-A");
  assert.equal(allow.stream_info!.enabled, true);
  assert.ok(allow.stream_info!.hash === undefined || allow.stream_info!.hash === "", "a built-in has no definition to pin");
});

// @spec DASH-TOOL-016
test("a definition that changes between the owner reading it and saving is never approved unseen: the hash written is the one the owner saw, or nothing is written", async () => {
  const b = await open({ yaml: "tools:\n  allow: {}\n", cat: catalog([{ name: "weather__post", label: "acts", effect: "acts", server: "weather", hash: "seen-1", description: "Posts a message." }]) });
  await userEvent.setup().click(sw(toolRow("weather__post"), "Allowed"));
  pushCatalog(b.app, catalog([{ name: "weather__post", label: "acts", effect: "acts", server: "weather", hash: "changed-2", description: "Posts a message and deletes your files." }]));
  await settle(2);
  await save();
  for (const c of puts(b.app)) {
    const entry = (body(c).values.allow as unknown as Record<string, Record<string, unknown>> | undefined)?.weather__post;
    if (entry?.enabled === true) assert.notEqual(entry.hash, "changed-2", "the new definition was not approved");
  }
});

// @spec DASH-TOOL-017
test("a tool whose reason is changed shows `Changed since you approved it`, stays off, and approving it again writes the new hash; not_approved and server_down show that reason", async () => {
  const b = await open({
    cat: catalog([
      { name: "weather__forecast", server: "weather", enabled: true, offered: false, reason: "changed", hash: "h2", description: "New description." },
      { name: "weather__post", server: "weather", label: "acts", effect: "acts", enabled: true, acts: true, offered: false, reason: "not_approved", hash: "p1" },
      { name: "lan__x", server: "lan", enabled: true, offered: false, reason: "server_down", hash: "x1" },
    ], [{ name: "weather" }, { name: "lan", state: "down" }]),
  });
  const ch = toolRow("weather__forecast");
  assert.match(text(ch), /Changed since you approved it/);
  assert.equal(sw(ch, "Allowed").checked, false, "kept off until approved again");
  assert.match(text(toolRow("weather__post")), /not approved/i);
  assert.match(text(toolRow("lan__x")), /server (is )?down|not reachable|down/i);
  await userEvent.setup().click(sw(ch, "Allowed"));
  await save();
  const entry = (lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>).weather__forecast!;
  assert.equal(entry.enabled, true);
  assert.equal(entry.hash, "h2");
});

// @spec DASH-TOOL-018
test("May act and Usable for viewer chat exclude each other: turning one on turns the other off and says why; May act can be turned on for a read-only tool and says it makes the tool count as acting whatever its server claims", async () => {
  await open({ cat: catalog([{ name: "stream_info", enabled: true, chat: true, label: "read" }]), yaml: "tools:\n  allow:\n    stream_info:\n      enabled: true\n      chat: true\n" });
  const row = toolRow("stream_info");
  const user = userEvent.setup();
  assert.equal(sw(row, "Usable for viewer chat").checked, true);
  assert.equal(sw(row, "May act").disabled, false, "offered for a read-only tool");
  await user.click(sw(row, "May act"));
  assert.equal(sw(row, "May act").checked, true);
  assert.equal(sw(row, "Usable for viewer chat").checked, false);
  assert.match(text(row), /viewer chat/i);
  assert.match(text(row), /count as acting/i);
  assert.match(text(row), /server claims/i);
  await user.click(sw(row, "Usable for viewer chat"));
  assert.equal(sw(row, "Usable for viewer chat").checked, true);
  assert.equal(sw(row, "May act").checked, false);
});

// @spec DASH-TOOL-019
test("an acting tool other than the timer has `Ask me before it runs`, on unless confirm is false, writing confirm, with the note on where turning it off applies", async () => {
  const b = await open({ yaml: "tools:\n  allow:\n    weather__post:\n      enabled: true\n      acts: true\n      hash: p1\n    weather__ping:\n      enabled: true\n      acts: true\n      confirm: false\n      hash: q1\n    timer:\n      enabled: true\n", cat: catalog([
    { name: "weather__post", label: "acts", effect: "acts", enabled: true, acts: true, server: "weather", hash: "p1" },
    { name: "weather__ping", label: "acts", effect: "acts", enabled: true, acts: true, confirm: false, server: "weather", hash: "q1" },
    { name: "timer", label: "acts", effect: "acts", enabled: true },
    { name: "stream_info", enabled: false },
  ]) });
  assert.equal(sw(toolRow("weather__post"), "Ask me before it runs").checked, true);
  assert.equal(sw(toolRow("weather__ping"), "Ask me before it runs").checked, false);
  assert.equal(within(toolRow("timer")).queryByRole("switch", { name: "Ask me before it runs" }), null, "the built-in timer has none");
  assert.equal(within(toolRow("stream_info")).queryByRole("switch", { name: "Ask me before it runs" }), null, "a read-only tool has none");
  const note = text(toolRow("weather__post"));
  assert.match(note, /only to the dashboard/i);
  assert.match(note, /tools\.owner_sources/);
  assert.match(note, /first tool round/i);
  await userEvent.setup().click(sw(toolRow("weather__post"), "Ask me before it runs"));
  await save();
  assert.equal((lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>).weather__post!.confirm, false);
});

// @spec DASH-TOOL-025
test("beside the confirm mark the page states that a listed source covers everyone who speaks through it, a listed Discord source including guests in that channel", async () => {
  await open();
  const t = text(document.body);
  assert.match(t, /covers everyone who speaks through it/i);
  assert.match(t, /Discord source including guests in that channel/i);
});

// @spec DASH-TOOL-020
test("an enabled tool that changes things or is not labelled and has no acts mark says it is not offered until the owner allows it to act; a read-only tool or one with the mark says nothing of the kind", async () => {
  await open({
    yaml: "tools:\n  allow:\n    a:\n      enabled: true\n    b:\n      enabled: true\n    c:\n      enabled: true\n      acts: true\n    d:\n      enabled: true\n    e:\n      enabled: false\n",
    cat: catalog([
      { name: "a", label: "acts", effect: "acts", enabled: true, offered: false, reason: "acts_not_allowed" },
      { name: "b", label: "unlabelled", effect: "acts", enabled: true, offered: false, reason: "acts_not_allowed" },
      { name: "c", label: "acts", effect: "acts", enabled: true, acts: true, offered: true },
      { name: "d", label: "read", enabled: true, offered: true },
      { name: "e", label: "acts", effect: "acts", enabled: false },
    ]),
  });
  for (const n of ["a", "b"]) {
    assert.match(text(toolRow(n)), /not offered/i, n);
    assert.match(text(toolRow(n)), /allow it to act/i, n);
  }
  for (const n of ["c", "d", "e"]) assert.doesNotMatch(text(toolRow(n)), /not offered to the co-host until/i, n);
});

// @spec DASH-TOOL-021
test("a saved mark that differs from the catalog's says it applies when tools restarts; marks that agree say nothing", async () => {
  await open({
    yaml: "tools:\n  allow:\n    a:\n      enabled: true\n      acts: true\n    b:\n      enabled: true\n",
    cat: catalog([{ name: "a", label: "read", enabled: true, acts: false, effect: "read" }, { name: "b", label: "read", enabled: true, acts: false }]),
  });
  assert.match(text(toolRow("a")), /applies when tools restarts/i);
  assert.doesNotMatch(text(toolRow("b")), /applies when tools restarts/i);
});

// @spec DASH-TOOL-022
test("an allow entry that names no listed tool is listed last as `Not found on any server` with a control that removes the entry", async () => {
  const b = await open();
  const all = [...document.querySelectorAll<HTMLElement>("[data-tool]")];
  const last = all.at(-1)!;
  assert.equal(last.getAttribute("data-tool"), "gone__thing");
  assert.match(text(last), /Not found on any server/);
  assert.equal(all.filter((r) => /Not found on any server/.test(text(r))).length, 1, "only the unlisted one");
  await userEvent.setup().click(within(last).getByRole("button", { name: "Remove gone__thing" }));
  await save();
  const allow = lastValues(b.app).allow as unknown as Record<string, unknown>;
  assert.equal("gone__thing" in allow, false);
  assert.ok("weather__forecast" in allow && "weather__post" in allow, "the listed entries stay");
});

// @spec DASH-TOOL-023
test("with no catalog yet the page says the tools service is not running, lists the saved servers and allow entries without descriptions or states, and keeps every control editable", async () => {
  const b = await open({ cat: null });
  assert.match(text(document.body), /tools service is not running/i);
  const link = within(document.body).queryByRole("link", { name: /start/i });
  if (link) assert.match(link.getAttribute("href") ?? "", /#services/);
  assert.ok(server("weather") && server("lan"));
  for (const n of ["weather__forecast", "weather__post", "gone__thing"]) assert.ok(toolRow(n), `${n} is listed from the file`);
  assert.doesNotMatch(text(toolRow("weather__forecast")), /Gives the forecast/);
  assert.equal(sw(toolRow("weather__forecast"), "Allowed").disabled, false);
  assert.equal(sw(toolRow("weather__forecast"), "Allowed").checked, true, "the saved value");
  await userEvent.setup().click(sw(toolRow("weather__forecast"), "Allowed"));
  await save();
  assert.equal((lastValues(b.app).allow as unknown as Record<string, Record<string, unknown>>).weather__forecast!.enabled, false, "a setting is saved whether or not the service is up");
  assert.equal((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).disabled, false);
  assert.equal((screen.getByRole("button", { name: "Add server" }) as HTMLButtonElement).disabled, false);
});

// @spec DASH-TOOL-023
test("the service counts as not running once three of the last catalog's intervals pass by the page's own clock without another, and as running again at the next catalog", async () => {
  const b = await open({ cat: catalog(WEATHER_TOOLS, undefined, 30000) });
  assert.doesNotMatch(text(document.body), /tools service is not running/i);
  act(() => b.app.clock.tick(89_000));
  assert.doesNotMatch(text(document.body), /tools service is not running/i, "inside three intervals");
  act(() => b.app.clock.tick(1_001));
  assert.match(text(document.body), /tools service is not running/i);
  pushCatalog(b.app, catalog(WEATHER_TOOLS, undefined, 30000));
  assert.doesNotMatch(text(document.body), /tools service is not running/i);
  act(() => b.app.clock.tick(60_000));
  assert.doesNotMatch(text(document.body), /tools service is not running/i, "the clock restarted at the new catalog");
});

// @spec DASH-TOOL-023
test("the three intervals are those of the last catalog received, so a catalog with a longer interval allows a longer silence", async () => {
  const b = await open({ cat: catalog(WEATHER_TOOLS, undefined, 60000) });
  act(() => b.app.clock.tick(150_000));
  assert.doesNotMatch(text(document.body), /tools service is not running/i);
  act(() => b.app.clock.tick(31_000));
  assert.match(text(document.body), /tools service is not running/i);
});

// @spec DASH-TOOL-006, DASH-SECRET-013
test("the secret field of the add form is write-only: it is a password field, cleared after the add, and the value is in no row, attribute or live region", async () => {
  const b = await open();
  b.app.fetch.on("PUT /secrets/tools.servers.search.token", { json: { ok: true, set: true, restart: ["tools"] } });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: "Name" }), "search");
  await user.type(screen.getByRole("textbox", { name: "URL" }), "https://mcp.example.org/v1");
  const field = screen.getByLabelText("Token") as HTMLInputElement;
  assert.equal(field.type, "password");
  await user.type(field, "mcp-SECRET-80");
  await user.click(screen.getByRole("button", { name: "Add server" }));
  await save();
  await waitFor(() => assert.ok(b.app.fetch.calls.some((c) => c.path.startsWith("/secrets"))));
  assert.equal(document.body.innerHTML.includes("mcp-SECRET-80"), false);
  assert.equal(((screen.queryByLabelText("Token") as HTMLInputElement | null)?.value ?? ""), "");
});
