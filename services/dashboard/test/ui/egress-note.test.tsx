// The egress note (DASH-UI-037 on the Services screen, DASH-SET-034 on the Settings screen): one shared renderer over GET /egress.
import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { act, makeApp, screen, userEvent, within } from "./helpers/render";
import { UNITS, mountServices, svc } from "./services-fixtures";
import { boot, settle } from "./settings-helpers";

interface Entry { service: string; data: string; engine: string; host?: string; hosted?: string; offLan: boolean }
const entry = (service: string, data: string, engine: string, over: Partial<Entry> = {}): Entry => ({ service, data, engine, offLan: true, ...over });

const table = () => screen.getByRole("table", { name: "Services" });
const rowOf = (name: string): HTMLElement => {
  const row = within(table()).getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name }) !== null);
  assert.ok(row !== undefined, `no row for ${name}`);
  return row;
};
const text = (el: Element | null | undefined) => el?.textContent ?? "";

const SERVICES = ["voice", "ears", "eyes", "cortex", "tools"];
const tools = { ...UNITS[0]!, id: "tools" };

async function servicesWith(destinations: Entry[] | "fail") {
  const app = makeApp();
  if (destinations === "fail") app.fetch.on("GET /egress", { status: 500, json: { ok: false, detail: "bad config" } });
  else app.fetch.on("GET /egress", { json: { destinations } });
  const m = await mountServices({ app, manifest: [...UNITS, tools], services: SERVICES.map((s) => svc(s)) });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return m;
}

// @spec DASH-UI-037
test("the Services screen reads GET /egress and marks each service's row with the sentence for what leaves and where", async () => {
  await servicesWith([
    entry("voice", "text", "openai", { host: "tts.example.com" }),
    entry("cortex", "text", "openai", { host: "llm.example.com" }),
    entry("ears", "audio", "openai", { host: "stt.example.com" }),
    entry("eyes", "frames", "openai", { host: "vision.example.com" }),
    entry("tools", "text", "mcp", { host: "tools.example.com" }),
  ]);
  assert.match(text(rowOf("voice")), /spoken text goes to tts\.example\.com/);
  assert.match(text(rowOf("cortex")), /the conversation goes to llm\.example\.com/);
  assert.match(text(rowOf("ears")), /audio goes to stt\.example\.com/);
  assert.match(text(rowOf("eyes")), /screen frames go to vision\.example\.com/);
  assert.match(text(rowOf("tools")), /tool requests go to tools\.example\.com/);
});

// @spec DASH-UI-037
test("an entry with no host names the hosted provider instead; an entry that stays on the LAN marks no row", async () => {
  await servicesWith([
    entry("eyes", "frames", "anthropic", { hosted: "anthropic" }),
    entry("voice", "text", "pocket", { host: "tts-pocket", offLan: false }),
    entry("cortex", "text", "ollama", { host: "ollama", offLan: false }),
  ]);
  const eyes = text(rowOf("eyes"));
  assert.match(eyes, /screen frames go to .*anthropic/);
  assert.doesNotMatch(eyes, /go to undefined/);
  for (const quiet of ["voice", "cortex", "ears"]) assert.doesNotMatch(text(rowOf(quiet)), /goes to|go to/, `${quiet} row is unmarked`);
});

// @spec DASH-UI-037
test("a service with several off-LAN entries (two ears destinations, several tool servers) shows one sentence per entry", async () => {
  await servicesWith([
    entry("ears", "audio", "nemotron", { host: "a.example.com" }),
    entry("ears", "audio", "openai", { host: "b.example.com" }),
    entry("tools", "text", "mcp", { host: "t1.example.com" }),
    entry("tools", "text", "mcp", { host: "t2.example.com" }),
  ]);
  assert.match(text(rowOf("ears")), /audio goes to a\.example\.com/);
  assert.match(text(rowOf("ears")), /audio goes to b\.example\.com/);
  assert.match(text(rowOf("tools")), /t1\.example\.com/);
  assert.match(text(rowOf("tools")), /t2\.example\.com/);
});

// @spec DASH-UI-037
test("each note of a row is its own block element, so several notes do not run together", async () => {
  await servicesWith([
    entry("tools", "text", "mcp", { host: "t1.example.com" }),
    entry("tools", "text", "mcp", { host: "t2.example.com" }),
  ]);
  const notes = [...rowOf("tools").querySelectorAll<HTMLElement>(".egress-note")];
  assert.equal(notes.length, 2);
  for (const n of notes) assert.equal(n.tagName, "P", n.textContent ?? "");
  assert.notEqual(notes[0], notes[1]);
});

// @spec DASH-UI-037
test("when GET /egress fails the Services table still renders, with no marks", async () => {
  await servicesWith("fail");
  assert.deepEqual(within(table()).getAllByRole("rowheader").map((h) => h.textContent).sort(), [...SERVICES].sort());
  assert.doesNotMatch(text(table()), /goes to|go to/);
});

// --- Settings screen (DASH-SET-034) -------------------------------------------------------------------------------

const enumKey = (values: string[]) => ({ type: "string", enum: values, default: values[0], description: "An engine." });
const section = (path: string, keys: Record<string, string[]>) => ({
  path, title: path, group: "System", about: path, services: [path],
  schema: { type: "object", properties: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, enumKey(v)])) },
  keys: Object.fromEntries(Object.keys(keys).map((k) => [k, { help: "An engine." }])),
});
const read = (sec: string, values: Record<string, string>) => ({
  section: sec, etag: "e1", unknown: [],
  keys: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { source: "literal", editable: true, value: v, raw: JSON.stringify(v) }])),
});
const SCHEMA = {
  groups: ["System"],
  sections: [
    section("voice", { engine: ["kokoro", "openai", "pocket", "stub"] }),
    section("ears", { stt_engine: ["speaches", "openai", "nemotron", "kyutai", "stub"], stt_fallback_engine: ["speaches", "openai", "none"] }),
    section("vision", { provider: ["ollama", "openai", "anthropic", "bedrock"] }),
    section("llm", { provider: ["ollama", "openai", "anthropic", "bedrock", "mock"] }),
  ],
};
const READS: Record<string, unknown> = {
  voice: read("voice", { engine: "openai" }),
  ears: read("ears", { stt_engine: "openai", stt_fallback_engine: "speaches" }),
  vision: read("vision", { provider: "anthropic" }),
  llm: read("llm", { provider: "openai" }),
};
const row = (key: string): HTMLElement => document.querySelector<HTMLElement>(`[data-key="${key}"]`)!;

async function settings(sec: string, destinations: Entry[]) {
  const b = boot({
    section: sec, schema: SCHEMA,
    routes: { [`GET /config/${sec}`]: { json: READS[sec] }, "GET /egress": { json: { destinations } } },
  });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  return b;
}

// @spec DASH-SET-034
test("voice.engine shows the voice note beside the key", async () => {
  await settings("voice", [entry("voice", "text", "openai", { host: "tts.example.com" }), entry("cortex", "text", "openai", { host: "llm.example.com" })]);
  assert.match(text(row("engine")), /spoken text goes to tts\.example\.com/);
  assert.doesNotMatch(text(row("engine")), /conversation/, "another service's destination is not shown here");
});

// @spec DASH-SET-034
test("ears.stt_engine and ears.stt_fallback_engine each show the ears audio note", async () => {
  await settings("ears", [entry("ears", "audio", "openai", { host: "stt.example.com" })]);
  assert.match(text(row("stt_engine")), /audio goes to stt\.example\.com/);
  assert.match(text(row("stt_fallback_engine")), /audio goes to stt\.example\.com/);
});

// @spec DASH-SET-034
test("vision.provider shows the frames note, naming the hosted provider where there is no host", async () => {
  await settings("vision", [entry("eyes", "frames", "anthropic", { hosted: "anthropic" })]);
  assert.match(text(row("provider")), /screen frames go to .*anthropic/);
});

// @spec DASH-SET-034
test("llm.provider shows the conversation note", async () => {
  await settings("llm", [entry("cortex", "text", "openai", { host: "llm.example.com" })]);
  assert.match(text(row("provider")), /the conversation goes to llm\.example\.com/);
});

// @spec DASH-SET-034
test("no note beside the keys when the service's destination stays on the LAN or has no entry", async () => {
  await settings("voice", [entry("voice", "text", "pocket", { host: "tts-pocket", offLan: false })]);
  assert.doesNotMatch(text(row("engine")), /goes to|go to/);
});

// @spec DASH-SET-034
test("a section with none of the five keys shows no note", async () => {
  const b = boot({ section: "demo", routes: { "GET /egress": { json: { destinations: [entry("voice", "text", "openai", { host: "tts.example.com" })] } } } });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  assert.doesNotMatch(document.body.textContent ?? "", /goes to/);
  void b;
});

// @spec DASH-SET-034
test("a save reads GET /egress again: the note beside llm.provider follows the saved provider", async () => {
  const b = boot({
    section: "llm", schema: SCHEMA,
    routes: {
      "GET /config/llm": { json: READS.llm },
      "GET /egress": { json: { destinations: [entry("cortex", "text", "openai", { host: "llm.example.com" })] } },
      "PUT /config/llm": { json: { ok: true, etag: "e2", restart: [], warnings: [] } },
    },
  });
  await screen.findByRole("heading", { level: 1 });
  await settle();
  assert.match(text(row("provider")), /the conversation goes to llm\.example\.com/);
  b.app.fetch.on("GET /egress", { json: { destinations: [entry("cortex", "text", "anthropic", { hosted: "anthropic" })] } });
  const user = userEvent.setup();
  await user.selectOptions(within(row("provider")).getByRole("combobox"), "anthropic");
  await user.click(within(screen.getByRole("group", { name: "Save settings" })).getByRole("button", { name: "Save" }));
  await settle();
  assert.match(text(row("provider")), /the conversation goes to anthropic/);
  assert.doesNotMatch(text(row("provider")), /llm\.example\.com/);
});
