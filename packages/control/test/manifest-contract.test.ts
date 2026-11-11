import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES } from "@cohost/bus";
import { schemaAt } from "@cohost/config";
import { SERVICE_MANIFEST, findService } from "../src/index.js";

const units = SERVICE_MANIFEST.filter((s) => s.pnpmFilter);
const SERVICE_LEVEL = ["text", "image", "audio"];

// @spec MOD-MAN-001
test("every unit carries config, uses, pause and test (inputs and observe)", () => {
  assert.equal(units.length, 10);
  for (const s of units) {
    assert.ok(Array.isArray(s.config) && s.config.length > 0, `${s.id} config`);
    assert.ok(Array.isArray(s.uses), `${s.id} uses`);
    assert.equal(typeof s.pause, "boolean", `${s.id} pause`);
    assert.ok(Array.isArray(s.test.inputs) && s.test.inputs.length > 0, `${s.id} test.inputs`);
    assert.ok(Array.isArray(s.test.observe) && s.test.observe.length > 0, `${s.id} test.observe`);
  }
  for (const s of SERVICE_MANIFEST.filter((x) => !x.pnpmFilter)) {
    assert.deepEqual([s.config, s.uses, s.pause, s.test], [[], [], false, { inputs: [], observe: [] }], `${s.id} carries empty declarations`);
  }
});

// @spec MOD-MAN-002
test("config sections are the declared ones and each is a path of ConfigSchema", () => {
  const want: Record<string, string[]> = {
    chat: ["chat"], eyes: ["vision"], ears: ["ears"],
    salience: ["brain.salience", "brain.working_memory_events", "cohost", "llm"],
    affect: ["brain.affect", "cohost", "llm"],
    memory: ["brain.memory", "cohost", "llm"],
    cortex: ["brain.cortex", "brain.working_memory_events", "cohost", "llm"],
    voice: ["voice"], mouth: ["mouth"], avatar: ["avatar"],
  };
  for (const [id, config] of Object.entries(want)) assert.deepEqual(findService(id)!.config, config, id);
  for (const s of units) for (const sec of s.config) assert.ok(schemaAt(sec), `${s.id}: ${sec} is not a config path`);
});

// @spec MOD-MAN-003
test("uses are the declared ones and requires is a subset of uses", () => {
  const want: Record<string, string[]> = { salience: ["affect", "cortex"], cortex: ["salience", "affect", "memory"], mouth: ["voice"], avatar: ["voice"] };
  for (const s of units) assert.deepEqual(s.uses, want[s.id] ?? [], s.id);
  for (const s of SERVICE_MANIFEST) for (const r of s.requires ?? []) assert.ok(s.uses.includes(r), `${s.id} requires ${r} without using it`);
});

// @spec MOD-MAN-004
test("pause is true for salience, cortex and affect only", () => {
  assert.deepEqual(SERVICE_MANIFEST.filter((s) => s.pause).map((s) => s.id).sort(), ["affect", "cortex", "salience"]);
});

// @spec MOD-MAN-005
test("test inputs and observed types are the declared ones and name registered bus events", () => {
  const inputs: Record<string, string[]> = {
    chat: ["text"], eyes: ["image"], ears: ["audio"],
    salience: ["chat.message", "speech.heard", "vision.summary"],
    affect: ["chat.message", "speech.heard", "vision.summary", "brain.say"],
    memory: ["chat.message", "memory.recall.request"],
    cortex: ["attention.focus"], voice: ["brain.say"], mouth: ["brain.say"], avatar: ["brain.say", "affect.state"],
  };
  const observe: Record<string, string[]> = {
    chat: ["chat.message", "inject.result"], eyes: ["vision.summary", "inject.result"], ears: ["speech.heard", "inject.result"],
    salience: ["attention.focus", "brain.say"], affect: ["affect.state"], memory: ["memory.recall.reply", "memory.viewer"],
    cortex: ["brain.status", "brain.say"], voice: ["voice.utterance", "voice.playing", "voice.done"],
    mouth: ["voice.playing", "voice.done", "voice.failed"], avatar: ["avatar.state"],
  };
  const registered = new Set<string>(EVENT_TYPES);
  const barred = (t: string) => t === "service.heartbeat" || t === "service.lifecycle" || /^memory\.(notes|viewers)\./.test(t);
  for (const s of units) {
    assert.deepEqual(s.test.inputs, inputs[s.id], `${s.id} inputs`);
    assert.deepEqual(s.test.observe, observe[s.id], `${s.id} observe`);
    for (const t of [...s.test.inputs.filter((i) => !SERVICE_LEVEL.includes(i)), ...s.test.observe]) {
      assert.ok(registered.has(t) && !barred(t), `${s.id}: ${t} is not an allowed bus event type`);
    }
  }
});
