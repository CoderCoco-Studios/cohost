import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigSchema, GROUPS, PRESENTATION, SECTION_PATHS, SECRET_PATHS, sectionJsonSchema, sectionKeyPaths, sectionPresentation } from "../src/index.js";
import { SERVICE_MANIFEST } from "../../control/src/manifest.js";

// The presentation table beside the schema (config design, Presentation table): every section and key is named and
// explained, and a setting cannot ship without it.

const oneLine = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && !/[\r\n]/.test(s);
const SECTION_LIST = [...SECTION_PATHS];
const ALL_KEYS = SECTION_LIST.flatMap((s) => sectionKeyPaths(s));
const TOP_LEVEL = Object.keys(ConfigSchema.shape);

/** The JSON Schema node of a dotted key path from the config root. */
function nodeOf(path: string): any {
  const section = SECTION_LIST.filter((s) => path === s || path.startsWith(`${s}.`)).sort((a, b) => b.length - a.length)[0]!;
  let node: any = sectionJsonSchema(section);
  for (const seg of path.slice(section.length).split(".").filter(Boolean)) node = node.properties[seg];
  return node;
}

// @spec CFG-PRES-001
test("PRESENTATION holds sections and keys maps, GROUPS is the ordered five, and the declared sections are the schema's", () => {
  assert.deepEqual([...GROUPS], ["Identity", "Brain", "Senses", "Voice and body", "System"]);
  assert.deepEqual(Object.keys(PRESENTATION.sections).sort(), [...SECTION_LIST].sort());
  assert.deepEqual(
    [...SECTION_LIST].sort(),
    [
      ...TOP_LEVEL.filter((k) => k !== "brain"),
      "brain.working_memory_events", "brain.working_memory_own_lines", "brain.input_limits", "brain.salience", "brain.affect", "brain.memory", "brain.cortex",
    ].sort(),
  );
  assert.ok(TOP_LEVEL.includes("viewer_text"), "viewer_text is a top-level section");
  assert.ok(Object.keys(PRESENTATION.keys).length > 0);
});

// @spec CFG-PRES-002
test("every declared section has a one-line title, group and about", () => {
  for (const s of SECTION_LIST) {
    const e = PRESENTATION.sections[s];
    assert.ok(e, `section ${s} has no presentation`);
    assert.ok(oneLine(e.title), `${s}: title`);
    assert.ok(oneLine(e.about), `${s}: about`);
    assert.ok((GROUPS as readonly string[]).includes(e.group), `${s}: group ${e.group}`);
  }
});

// @spec CFG-PRES-003
test("a section's page names another declared section", () => {
  const pages = Object.entries(PRESENTATION.sections).filter(([, e]) => e.page !== undefined);
  assert.deepEqual(pages.map(([s, e]) => [s, e.page]), [["brain.working_memory_events", "brain.memory"], ["brain.working_memory_own_lines", "brain.memory"], ["renderer", "avatar"]]);
  for (const [s, e] of pages) {
    assert.ok(SECTION_LIST.includes(e.page!), `${s}: page ${e.page} is not a declared section`);
    assert.notEqual(e.page, s);
  }
});

// @spec CFG-PRES-004, CFG-PRES-007
test("every key of every declared section has a one-line help, and an optional label or unit is non-empty and one line", () => {
  for (const k of ALL_KEYS) {
    const e = PRESENTATION.keys[k];
    assert.ok(e, `key ${k} has no presentation`);
    assert.ok(oneLine(e.help), `${k}: help`);
    assert.ok(e.help.length >= 40 && /[.!?)]$/.test(e.help), `${k}: help should be a plain sentence, got "${e.help}"`);
    assert.doesNotMatch(e.help, /see (the )?docs?\b/i, `${k}: help must stand on its own`);
    if (e.label !== undefined) assert.ok(oneLine(e.label), `${k}: label`);
    if (e.unit !== undefined) assert.ok(oneLine(e.unit), `${k}: unit`);
  }
});

// @spec CFG-PRES-007
test("an entry for a section or key that the schema does not define fails, and the secret keys are explained too", () => {
  for (const k of Object.keys(PRESENTATION.keys)) assert.ok(ALL_KEYS.includes(k), `presentation entry ${k} names no schema key`);
  for (const s of Object.keys(PRESENTATION.sections)) assert.ok(SECTION_LIST.includes(s), `presentation section ${s} names no declared section`);
  for (const k of SECRET_PATHS) assert.ok(PRESENTATION.keys[k], `secret key ${k} needs help too`);
  assert.equal(ALL_KEYS.length, new Set(ALL_KEYS).size, "a key belongs to one section");
});

// @spec CFG-PRES-007, CFG-PRES-018
test("the declared sections are the sections the control plane's manifest declares plus dashboard and renderer", () => {
  const declared = new Set<string>(["dashboard", "renderer", ...SERVICE_MANIFEST.flatMap((s) => s.config)]);
  // the manifest's `tools` unit (and its `tools` section) arrives with #208; until then the presentation table alone declares it
  declared.add("tools");
  assert.deepEqual([...declared].sort(), [...SECTION_LIST].sort());
});

// @spec CFG-PRES-012
test("the own-lines, input-limits and viewer-text sections are in group Brain, and own lines are shown on brain.memory", () => {
  const s = PRESENTATION.sections;
  assert.equal(s["brain.working_memory_own_lines"]?.group, "Brain");
  assert.equal(s["brain.working_memory_own_lines"]?.page, "brain.memory");
  assert.equal(s["brain.input_limits"]?.group, "Brain");
  assert.equal(s["brain.input_limits"]?.page, undefined);
  assert.equal(s["viewer_text"]?.group, "Brain");
  assert.equal(s["viewer_text"]?.page, undefined);
  assert.deepEqual(sectionKeyPaths("brain.working_memory_own_lines"), ["brain.working_memory_own_lines"]);
  assert.deepEqual(sectionKeyPaths("brain.input_limits").sort(), ["brain.input_limits.speech_max_chars", "brain.input_limits.vision_max_chars"]);
  assert.deepEqual(sectionKeyPaths("viewer_text").sort(), ["viewer_text.max_chars", "viewer_text.max_name_chars"]);
});

// @spec CFG-PRES-013
test("the four text-limit keys carry the unit chars and brain.affect.count_window_ms the unit ms", () => {
  for (const k of ["viewer_text.max_chars", "viewer_text.max_name_chars", "brain.input_limits.speech_max_chars", "brain.input_limits.vision_max_chars"]) {
    assert.equal(PRESENTATION.keys[k]?.unit, "chars", k);
  }
  assert.equal(PRESENTATION.keys["brain.affect.count_window_ms"]?.unit, "ms");
});

// @spec CFG-PRES-005, MOD-CFG-021
test("a widget is one of the closed set, a model widget is on a string key, options are distinct members of the enum", () => {
  const KINDS = ["chat", "small", "vision", "embed", "stt"];
  for (const [k, e] of Object.entries(PRESENTATION.keys)) {
    const w = e.widget;
    if (!w) continue;
    const node = nodeOf(k);
    switch (w.type) {
      case "timezone": case "voice": case "sources": case "textarea": case "mcp-servers": case "tool-list": case "avatar-model": break;
      case "slider": assert.equal(node.type, "number", `${k}: a slider is on a numeric key`); break;
      case "model":
        assert.ok(KINDS.includes(w.kind), `${k}: model kind ${String(w.kind)}`);
        assert.equal(node.type, "string", `${k}: a model widget is on a string key`);
        break;
      case "options": {
        assert.ok(w.options.length >= 2, `${k}: options`);
        const values = w.options.map((o) => o.value);
        assert.equal(new Set(values).size, values.length, `${k}: distinct values`);
        for (const o of w.options) { assert.ok(node.enum.includes(o.value), `${k}: ${o.value} is not in the enum`); assert.ok(oneLine(o.label), `${k}: option label`); }
        break;
      }
      default: assert.fail(`${k}: unknown widget ${JSON.stringify(w)}`);
    }
  }
});

// @spec CFG-PRES-006, CFG-PRES-020
test("the widget assignments are fixed: timezone, voice, textarea, sources, lang_code options and the model kinds", () => {
  const w = (k: string) => PRESENTATION.keys[k]?.widget;
  assert.deepEqual(w("cohost.timezone"), { type: "timezone" });
  assert.deepEqual(w("voice.voice"), { type: "voice" });
  assert.deepEqual(w("vision.prompt"), { type: "textarea" });
  for (const k of ["ears.sources", "ears.echo_suppress_sources", "brain.salience.barge_in_sources"]) assert.deepEqual(w(k), { type: "sources" });
  const lang = w("voice.lang_code") as { type: string; options: { value: string; label: string }[] };
  assert.equal(lang.type, "options");
  assert.deepEqual(lang.options.map((o) => o.value).sort(), ["a", "b", "e", "f", "h", "i", "j", "p", "z"]);
  // Every model-name key carries a model widget of the right kind.
  const expected = (k: string): string | undefined => {
    if (k === "llm.model" || k === "brain.memory.notes.consolidator.llm.model") return "chat";
    if (k === "llm.embed_model") return "embed";
    if (k === "vision.model") return "vision";
    if (k === "ears.stt_model") return "stt";
    if (k.endsWith(".llm.model")) return "small";
    return undefined;
  };
  // voice.openai.model is a free-text TTS model name (CFG-SCH-059), not a model widget kind, so it is left out here.
  const modelKeys = ALL_KEYS.filter((k) => /(^|\.)(model|embed_model|stt_model)$/.test(k) && k !== "voice.openai.model" && k !== "renderer.model");
  assert.equal(modelKeys.length, 9);
  for (const k of modelKeys) assert.deepEqual(w(k), { type: "model", kind: expected(k) }, k);
  // And nothing else is a model widget.
  assert.deepEqual(Object.entries(PRESENTATION.keys).filter(([, e]) => e.widget?.type === "model").map(([k]) => k).sort(), [...modelKeys].sort());
});

// @spec CFG-PRES-008, CFG-PRES-009
test("each key's help is its JSON Schema description, and so is each property of a structured list's items", () => {
  for (const s of SECTION_LIST) {
    const schema = sectionJsonSchema(s) as any;
    for (const k of sectionKeyPaths(s)) {
      const node = nodeOf(k);
      assert.equal(node.description, PRESENTATION.keys[k]!.help, `${k}: description`);
    }
    assert.ok(schema);
  }
  // No object node (a group of keys) invents a description of its own.
  const walk = (n: any, path: string): void => {
    if (n?.type === "object" && n.properties) { for (const [k, v] of Object.entries<any>(n.properties)) { if (v.type === "object") assert.equal(v.description, undefined, `${path}.${k}`); walk(v, `${path}.${k}`); } }
  };
  for (const s of SECTION_LIST) walk(sectionJsonSchema(s), s);

  const arrays = ALL_KEYS.filter((k) => nodeOf(k).type === "array" && nodeOf(k).items?.type === "object");
  assert.deepEqual(arrays, ["brain.salience.reflexes"]);
  for (const k of arrays) {
    const e = PRESENTATION.keys[k]!;
    const props = Object.keys(nodeOf(k).items.properties);
    assert.deepEqual(Object.keys(e.items ?? {}).sort(), [...props].sort(), `${k}: items cover every property`);
    for (const p of props) {
      const it = e.items![p]!;
      assert.ok(oneLine(it.help), `${k}.${p}: help`);
      assert.equal(nodeOf(k).items.properties[p].description, it.help, `${k}.${p}: description`);
      if (it.label !== undefined) assert.ok(oneLine(it.label));
      if (it.unit !== undefined) assert.ok(oneLine(it.unit));
    }
  }
  for (const k of ALL_KEYS.filter((x) => !arrays.includes(x))) assert.equal(PRESENTATION.keys[k]!.items, undefined, `${k}: only an array of objects has items`);
});

// @spec CFG-PRES-010, CFG-PRES-011
test("sensitive marks exactly the trust-boundary keys of CFG-PRES-011 (tools.servers and tools.allow among them), the schema carries x-sensitive, and an unlisted url, host or base_url fails", () => {
  const SENSITIVE = [
    "dashboard.allowed_hosts", "network.lan", "llm.provider", "llm.openai.base_url", "vision.obs.host", "vision.obs.port", "avatar.vtube_studio.host", "avatar.vtube_studio.port",
    "mouth.outputs.http.url", "brain.salience.module.url", "brain.affect.module.url", "brain.cortex.critic.url", "brain.memory.notes.capture.url", "brain.memory.notes.consolidator.url",
    "vision.provider", "voice.engine", "voice.openai.base_url", "voice.pocket.url", "ears.stt_engine", "ears.stt_fallback_engine", "ears.openai.base_url", "ears.nemotron.url",
    "ears.kyutai.url", "tools.servers", "tools.allow",
  ];
  const marked = Object.entries(PRESENTATION.keys).filter(([, e]) => e.sensitive !== undefined);
  assert.deepEqual(marked.map(([k]) => k).sort(), [...SENSITIVE].sort());
  for (const [, e] of marked) assert.equal(e.sensitive, true);
  for (const k of SENSITIVE) assert.equal(nodeOf(k)["x-sensitive"], true, `${k}: x-sensitive`);
  for (const k of ALL_KEYS.filter((x) => !SENSITIVE.includes(x))) assert.equal(nodeOf(k)["x-sensitive"], undefined, `${k}: not sensitive`);
  const NAMES_NO_DESTINATION = ["ears.http.host", "ears.dir.path", "avatar.vmc.host"];
  for (const k of ALL_KEYS.filter((x) => /(^|\.)(url|host|base_url)$/.test(x))) {
    assert.ok(SENSITIVE.includes(k) || NAMES_NO_DESTINATION.includes(k), `${k} names a destination: mark it sensitive or list it as naming none`);
  }
});

// @spec CFG-PRES-011
test("a url key under tools.servers.<name> is covered by the sensitive tools.servers entry, so the destination guard needs no per-name entry", () => {
  assert.equal(PRESENTATION.keys["tools.servers"]?.sensitive, true);
  assert.equal(PRESENTATION.keys["tools.allow"]?.sensitive, true);
  assert.equal(nodeOf("tools.servers")["x-sensitive"], true);
  assert.equal(nodeOf("tools.allow")["x-sensitive"], true);
});

// @spec CFG-SCH-026
test("the help for sample_rate, port and lan_port says what the editor must show honestly", () => {
  assert.match(PRESENTATION.keys["voice.sample_rate"]!.help, /stub/i);
  assert.match(PRESENTATION.keys["voice.sample_rate"]!.help, /Kokoro.*ignore|ignore.*Kokoro/i);
  assert.match(PRESENTATION.keys["dashboard.port"]!.help, /full|control|page/i);
  assert.match(PRESENTATION.keys["dashboard.port"]!.help, /next start/i);
  assert.match(PRESENTATION.keys["dashboard.lan_port"]!.help, /LAN/);
  assert.match(PRESENTATION.keys["dashboard.lan_port"]!.help, /next start/i);
});

// @spec CFG-PRES-008
test("schema.ts carries no .describe() call: the table is the one source of help", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/schema.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /\.describe\(/);
});

// @spec MOD-CFG-019, MOD-CFG-020, MOD-CFG-021
test("sectionPresentation joins a section's title, group, about, page and per-key presentation by relative key name", () => {
  const voice = sectionPresentation("voice");
  assert.deepEqual(Object.keys(voice).sort(), ["about", "group", "keys", "title"]);
  assert.equal(voice.title, PRESENTATION.sections.voice!.title);
  assert.equal(voice.group, "Voice and body");
  assert.deepEqual(voice.keys["voice"], { help: PRESENTATION.keys["voice.voice"]!.help, widget: { type: "voice" } });
  assert.deepEqual(voice.keys["lang_code"]!.widget, PRESENTATION.keys["voice.lang_code"]!.widget);
  assert.equal(voice.keys["fallback.lines"]!.help, PRESENTATION.keys["voice.fallback.lines"]!.help);
  assert.deepEqual(Object.keys(voice.keys).sort(), sectionKeyPaths("voice").map((p) => p.slice("voice.".length)).sort());

  const wm = sectionPresentation("brain.working_memory_events");
  assert.equal(wm.page, "brain.memory");
  assert.deepEqual(Object.keys(wm.keys), ["working_memory_events"]); // a leaf section is named for itself

  const llm = sectionPresentation("llm");
  assert.equal(llm.keys["openai.base_url"]!.sensitive, true);
  assert.deepEqual(llm.keys["model"]!.widget, { type: "model", kind: "chat" });
  assert.ok(llm.keys["openai.api_key"]!.help); // a secret key is explained too
  assert.equal(llm.keys["temperature"]!.sensitive, undefined);

  const sal = sectionPresentation("brain.salience");
  assert.deepEqual(Object.keys(sal.keys["reflexes"]!.items!).sort(), ["cooldown_ms", "emotion", "gesture", "match", "on", "say"]);
  assert.equal(sal.keys["reflexes"]!.items!["cooldown_ms"]!.unit, "ms");
  assert.throws(() => sectionPresentation("nope"), /no such config section/);
});

// @spec CFG-PRES-006
test("chat.sources gets the sources widget beside ears.sources, and each chat.youtube key has presentation help", () => {
  assert.deepEqual(PRESENTATION.keys["chat.sources"]?.widget, { type: "sources" });
  assert.equal(PRESENTATION.keys["chat.source"], undefined, "the retired key has no entry");
  for (const k of ["video", "api_key", "transport", "poll_floor_ms", "recheck_ms"]) {
    assert.ok(oneLine(PRESENTATION.keys[`chat.youtube.${k}`]?.help), `chat.youtube.${k} has help`);
  }
});

// @spec CFG-PRES-016
test("the tools section is in group Brain with the title Tools, an about sentence and a help for every key of the section", () => {
  const e = PRESENTATION.sections["tools"];
  assert.ok(e, "tools has a section entry");
  assert.equal(e.group, "Brain");
  assert.equal(e.title, "Tools");
  assert.ok(oneLine(e.about));
  assert.equal(e.page, undefined);
  assert.ok(SECTION_LIST.includes("tools"));
  const keys = sectionKeyPaths("tools");
  for (const k of ["mode", "timeout_ms", "confirm_timeout_ms", "max_result_chars", "max_concurrent", "catalog_ms", "max_tools_per_server", "max_tools", "owner_sources", "servers", "allow",
    "timer.max_active", "timer.max_minutes", "stream_info.cache_ms", "reply.max_rounds", "reply.max_calls", "reply.budget_ms", "reply.filler_after_ms", "reply.max_tokens", "reply.filler_lines"]) {
    assert.ok(keys.includes(`tools.${k}`), `tools.${k} is a key of the section`);
    assert.ok(oneLine(PRESENTATION.keys[`tools.${k}`]?.help), `tools.${k} has help`);
  }
  assert.ok(oneLine(PRESENTATION.keys["brain.salience.reminder_expiry_ms"]?.help), "brain.salience.reminder_expiry_ms has help");
  assert.ok(sectionKeyPaths("brain.salience").includes("brain.salience.reminder_expiry_ms"));
});

// @spec CFG-PRES-017
test("tools.servers gets the mcp-servers widget and tools.allow the tool-list widget", () => {
  assert.deepEqual(PRESENTATION.keys["tools.servers"]?.widget, { type: "mcp-servers" });
  assert.deepEqual(PRESENTATION.keys["tools.allow"]?.widget, { type: "tool-list" });
});

// @spec CFG-PRES-014
test("the network section entry stays in group System with a title, an about sentence and a help for network.lan, and the manifest declares it for voice, ears, eyes and tools (and no other unit)", () => {
  const e = PRESENTATION.sections["network"];
  assert.equal(e?.group, "System");
  assert.ok(oneLine(e?.title) && oneLine(e?.about));
  assert.ok(oneLine(PRESENTATION.keys["network.lan"]?.help));
  const declaring = SERVICE_MANIFEST.filter((s) => s.config.includes("network")).map((s) => s.id).sort();
  assert.deepEqual(declaring, ["ears", "eyes", "tools", "voice"]);
});

// @spec CFG-PRES-018
test("the renderer section is in group Voice and body, titled Avatar renderer, shown on avatar, with help for its four keys and the unit deg on turn", () => {
  const e = PRESENTATION.sections["renderer"]!;
  assert.ok(e, "renderer entry");
  assert.equal(e.title, "Avatar renderer");
  assert.equal(e.group, "Voice and body");
  assert.equal(e.page, "avatar");
  assert.equal(e.live, true);
  assert.ok(oneLine(e.about));
  assert.deepEqual(sectionKeyPaths("renderer").sort(), ["renderer.model", "renderer.offset_y", "renderer.turn", "renderer.zoom"]);
  for (const k of sectionKeyPaths("renderer")) assert.ok(oneLine(PRESENTATION.keys[k]?.help), `${k}: help`);
  assert.equal(PRESENTATION.keys["renderer.turn"]!.unit, "deg");
  assert.ok(oneLine(PRESENTATION.keys["dashboard.models.max_bytes"]?.help), "max_bytes help");
  assert.equal(PRESENTATION.keys["dashboard.models.max_bytes"]!.unit, "bytes");
});

// @spec CFG-PRES-019, MOD-CFG-022
test("live is true on the renderer section alone, and sectionPresentation carries it only there", () => {
  const live = Object.entries(PRESENTATION.sections).filter(([, e]) => e.live !== undefined);
  assert.deepEqual(live.map(([s, e]) => [s, e.live]), [["renderer", true]]);
  assert.equal(sectionPresentation("renderer").live, true);
  assert.equal("live" in sectionPresentation("dashboard"), false);
  assert.equal("live" in sectionPresentation("avatar"), false);
});

// @spec CFG-PRES-020
test("renderer.model gets the avatar-model widget, renderer.turn the slider, and none of the renderer keys nor dashboard.models.max_bytes is sensitive", () => {
  assert.deepEqual(PRESENTATION.keys["renderer.model"]!.widget, { type: "avatar-model" });
  assert.deepEqual(PRESENTATION.keys["renderer.turn"]!.widget, { type: "slider", step: 1 });
  assert.deepEqual(PRESENTATION.keys["renderer.zoom"]!.widget, { type: "slider", step: 0.05 });
  assert.deepEqual(PRESENTATION.keys["renderer.offset_y"]!.widget, { type: "slider", step: 0.01 });
  assert.equal(PRESENTATION.keys["renderer.offset_y"]!.label, "Vertical position");
  for (const k of [...sectionKeyPaths("renderer"), "dashboard.models.max_bytes"]) assert.notEqual(PRESENTATION.keys[k]?.sensitive, true, `${k} is not sensitive`);
  assert.equal((sectionJsonSchema("renderer") as any).properties.turn.minimum, -90);
});
