import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchema, navGroups, pageOf, deriveLabel, keyGroups, matchIssue, noteFor, sourceLabel } from "../../ui/src/screens/settings/schemaModel";
import { validateKey, toWire, fromLines } from "../../ui/src/screens/settings/validate";
import { schemaPayload, demoRead, plainRead } from "./settings-fixture";

const model = parseSchema(schemaPayload);
const demo = model.sections.find((s) => s.path === "demo")!;
const key = (k: string) => demo.keys.find((x) => x.key === k)!;

// @spec DASH-SET-001
test("the navigation is grouped in the order of the answer's groups, in schema order, and lists no section that has `page`", () => {
  const nav = navGroups(model);
  assert.deepEqual(nav.map((g) => g.group), ["Identity", "Brain", "System"], "empty groups are left out");
  assert.deepEqual(nav.find((g) => g.group === "Brain")!.sections.map((s) => s.path), ["demo"]);
  assert.deepEqual(pageOf(model, "extra")!.primary.path, "demo", "a section with page is shown on that page");
  assert.deepEqual(pageOf(model, "demo")!.members.map((s) => s.path), ["demo", "extra"]);
});

// @spec DASH-SET-003
test("a section or key with no metadata gets its title, label and group from the path, the unit suffix removed, and is still shown", () => {
  const plain = model.sections.find((s) => s.path === "plain")!;
  assert.equal(plain.keys.length, 2);
  assert.equal(plain.keys[0]!.label, "Speak rate ms", "no unit named: the suffix stays");
  assert.equal(plain.keys[1]!.label, "Deep thing");
  assert.equal(plain.keys[1]!.help, undefined);
  assert.equal(deriveLabel("cooldown_ms", "ms"), "Cooldown");
  const bare = parseSchema({ groups: ["Brain"], sections: [{ path: "brain.new_part", schema: { type: "object", properties: { a: { type: "boolean" } } } }] });
  assert.equal(bare.sections[0]!.title, "New part");
  assert.equal(bare.sections[0]!.group, "Brain", "the group comes from the first path segment");
  assert.deepEqual(navGroups(bare).map((g) => g.group), ["Brain"]);
  const odd = parseSchema({ groups: ["Brain"], sections: [{ path: "brain.a", schema: { type: "object", properties: {} } }, { path: "extra.thing", schema: { type: "object", properties: {} } }] });
  assert.deepEqual(navGroups(odd).map((g) => g.group), ["Brain", "Extra"], "a derived group the answer does not list follows the listed groups");
});

// @spec DASH-SET-004, DASH-SET-013, DASH-SET-016, DASH-SET-017, DASH-SET-018, DASH-SET-019, DASH-SET-020, DASH-SET-021, DASH-SET-022, DASH-SET-023, DASH-SET-024, DASH-SET-026, DASH-SET-029
test("each key gets the control its type and widget hint call for", () => {
  const kind = (k: string) => key(k).control.kind;
  assert.equal(kind("enabled"), "switch");
  assert.equal(kind("mode"), "segmented");
  assert.deepEqual((key("mode").control as { options: { value: string; label: string }[] }).options.map((o) => o.label), ["Calm", "Lively", "Wild"]);
  assert.equal(kind("provider"), "select");
  assert.deepEqual((key("provider").control as { options: { label: string }[] }).options.map((o) => o.label), ["ollama", "openai", "claude", "bedrock", "groq", "other"], "the value labels an option the key has no labels for");
  assert.equal(kind("temperature"), "slider");
  assert.equal((key("temperature").control as { step: number }).step, 0.01);
  assert.equal(kind("top_k"), "slider");
  assert.equal((key("top_k").control as { step: number }).step, 1);
  assert.equal(kind("port"), "number", "a span over 100 has no slider");
  assert.equal(kind("timeout_ms"), "number");
  assert.equal(kind("name"), "text");
  assert.equal(kind("prompt"), "textarea");
  assert.equal(kind("ignore"), "lines");
  assert.equal(kind("senses"), "chips");
  assert.equal(kind("sources"), "sources");
  assert.equal(kind("timezone"), "timezone");
  assert.deepEqual(key("model").control, { kind: "model", modelKind: "chat" });
  assert.equal(kind("voice"), "voice");
  assert.equal(kind("mystery"), "text", "an unknown widget is absent");
  assert.equal(kind("api_key"), "secret");
  assert.equal(kind("nested.deep"), "switch");
  assert.equal(kind("extras"), "json", "a shape with no control is raw JSON");
  assert.equal(kind("reflexes"), "objects");
  const reflex = key("reflexes").control as { props: { name: string; control: { kind: string }; help?: string; label: string }[] };
  assert.deepEqual(reflex.props.map((p) => [p.name, p.control.kind]), [["match", "text"], ["on", "chips"], ["say", "lines"], ["emotion", "select"], ["gesture", "text"], ["cooldown_ms", "number"]]);
  assert.equal(reflex.props[1]!.help, "Which senses this reflex listens to.");
  assert.equal(reflex.props[1]!.label, "Listens to");
  const leaf = model.sections.find((s) => s.path === "extra")!.keys[0]!;
  assert.equal(leaf.key, "extra");
  assert.equal(leaf.control.kind, "number", "a leaf section is one key");
  assert.equal(leaf.label, "Extra events");
});

// @spec DASH-SET-013
test("an unknown model kind, a malformed options list or a widget on the wrong type is treated as absent", () => {
  const m = parseSchema({ groups: ["Brain"], sections: [{ path: "s", title: "S", group: "Brain", about: "", services: [], secrets: [], keys: {
    a: { help: "h", widget: { type: "model", kind: "huge" } }, b: { help: "h", widget: { type: "options", options: "nope" } }, c: { help: "h", widget: { type: "timezone" } },
    d: { help: "h", widget: { type: "options", options: [{ value: "x", label: "X" }] } },
  }, schema: { type: "object", properties: { a: { type: "string" }, b: { type: "string", enum: ["p", "q"], default: "p" }, c: { type: "integer" }, d: { type: "string" } } } }] });
  const [a, b, c, d] = m.sections[0]!.keys;
  assert.equal(a!.control.kind, "text");
  assert.equal(b!.control.kind, "segmented");
  assert.deepEqual((b!.control as { options: { label: string }[] }).options.map((o) => o.label), ["p", "q"]);
  assert.equal(c!.control.kind, "number");
  assert.equal(d!.control.kind, "text", "an options widget needs an enum");
});

// @spec DASH-SET-025
test("keys group by path prefix in first-seen order, titled from the prefix words, with prefix-less keys under General", () => {
  const groups = keyGroups(demo);
  assert.deepEqual(groups.map((g) => g.title), ["General", "Nested"]);
  assert.deepEqual(groups[1]!.keys.map((k) => k.key), ["nested.deep", "nested.limit"]);
  const t = parseSchema({ groups: ["Brain"], sections: [{ path: "m", title: "M", group: "Brain", about: "", schema: { type: "object", properties: { notes: { type: "object", properties: { capture: { type: "object", properties: { enabled: { type: "boolean" } } } } } } } }] });
  assert.equal(keyGroups(t.sections[0]!)[0]!.title, "Notes capture");
});

// @spec DASH-SET-004
test("a note gives the range and the default, the source column names secret, default or config.yaml", () => {
  assert.equal(noteFor(key("temperature"), demoRead.keys.temperature!), "Range 0 to 2. Default 0.7.");
  assert.equal(noteFor(key("timeout_ms"), demoRead.keys.timeout_ms!), "At least 0. Default 5000. Not in config.yaml yet. Saving a change adds it.");
  assert.equal(noteFor(key("enabled"), demoRead.keys.enabled!), "Default On.");
  assert.equal(noteFor(key("name"), demoRead.keys.name!), "Default \"Coco\".");
  assert.equal(sourceLabel(demoRead.keys.api_key!), "secret");
  assert.equal(sourceLabel(demoRead.keys.provider!), "default");
  assert.equal(sourceLabel(demoRead.keys.mode!), "config.yaml");
  assert.equal(sourceLabel(plainRead.keys.speak_rate_ms!), "default");
});

// @spec DASH-SET-028
test("a key whose presentation says sensitive is marked", () => {
  assert.equal(key("url").sensitive, true);
  assert.equal(key("name").sensitive, false);
});

// @spec DASH-SET-005
test("validation checks type, integer, minimum, maximum, a required text and list size, per field and per card property", () => {
  const v = (k: string, value: unknown) => validateKey(key(k), value);
  assert.deepEqual(v("temperature", 1), {});
  assert.match(v("temperature", 3)[""]!, /at most 2/i);
  assert.match(v("temperature", -1)[""]!, /at least 0/i);
  assert.match(v("temperature", Number.NaN)[""]!, /number/i);
  assert.match(v("top_k", 2.5)[""]!, /whole number/i);
  assert.match(v("name", "")[""]!, /required/i);
  assert.deepEqual(v("name", "x"), {});
  assert.deepEqual(v("reflexes", []), {});
  const errs = v("reflexes", [{ match: "", on: ["chat"], say: [], emotion: "happy", gesture: "", cooldown_ms: -5 }]);
  assert.match(errs["0.match"]!, /required/i);
  assert.match(errs["0.say"]!, /at least 1/i);
  assert.match(errs["0.cooldown_ms"]!, /at least 0/i);
});

// @spec DASH-SET-019, DASH-SET-026
test("a list of lines splits on line breaks, trimming and dropping blanks; wire values keep their type", () => {
  assert.deepEqual(fromLines(" a \n\nb\n"), ["a", "b"]);
  assert.deepEqual(toWire(key("ignore"), ["a"]), ["a"]);
  assert.deepEqual(toWire(key("extras"), { a: "b" }), { a: "b" });
});

// @spec DASH-SET-005
test("an issue path from the server attaches to the key it names, whether it carries the section path, a relative key or an array index", () => {
  const keys = demo.keys.map((k) => k.key);
  assert.deepEqual(matchIssue("demo", keys, "temperature"), { key: "temperature", rest: "" });
  assert.deepEqual(matchIssue("demo", keys, "demo.temperature"), { key: "temperature", rest: "" });
  assert.deepEqual(matchIssue("demo", keys, "demo.nested.limit"), { key: "nested.limit", rest: "" });
  assert.deepEqual(matchIssue("demo", keys, "demo.reflexes[0].match"), { key: "reflexes", rest: "0.match" });
  assert.deepEqual(matchIssue("demo", keys, "demo.reflexes.2.say"), { key: "reflexes", rest: "2.say" });
  assert.equal(matchIssue("demo", keys, ""), undefined);
  assert.equal(matchIssue("demo", keys, "other.thing"), undefined);
  assert.deepEqual(matchIssue("extra", ["extra"], "extra"), { key: "extra", rest: "" }, "a leaf section names itself");
});
