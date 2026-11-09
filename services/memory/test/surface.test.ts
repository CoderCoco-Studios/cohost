import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { buildNotesReply } from "../src/surface.js";
import { DAY, T0 } from "./store-contract.js";

function setup(notesCfg: Record<string, unknown> = {}) {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", regular_messages: 3, notes: notesCfg } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  const ask = (users: string[]) => buildNotesReply(store, cfg, users, now);
  return { store, cfg, ask, advance: (ms: number) => { now += ms; }, now: () => now };
}
async function viewer(store: InMemoryStore, key: string, display: string, messages = 1) {
  for (let i = 0; i < messages; i++) await store.touchViewer(key, display);
}
const note = (store: InMemoryStore, userKey: string, text: string, extra: Record<string, unknown> = {}) =>
  store.insertNote({ userKey, category: "general", text, ...extra });

// @spec MEM-SURF-001, MEM-SURF-002
test("one entry per resolved name in request order, with regular and msgCount; unresolved names are omitted", async () => {
  const { store, ask } = setup();
  await viewer(store, "u1", "Alice", 5);
  await viewer(store, "u2", "Bob");
  await note(store, "u1", "plays celeste");
  const out = await ask(["bob", "Ghost", "ALICE"]);
  assert.deepEqual(out.map((v) => [v.user, v.regular, v.msgCount, v.notes.length]), [["Bob", false, 1, 0], ["Alice", true, 5, 1]]);
  assert.deepEqual(out[1]!.notes[0], { layer: "recent", category: "general", text: "plays celeste", strength: 1 });
  assert.deepEqual(await ask(["Ghost"]), [], "an empty list is a valid answer");
  assert.deepEqual(await ask([]), []);
});

// @spec MEM-SURF-001
test("the same viewer named twice is listed once; the reply carries no subscriber status", async () => {
  const { store, ask } = setup();
  await store.touchViewer("u1", "Alice", { isSub: true });
  const out = await ask(["Alice", "alice"]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["msgCount", "notes", "regular", "user"]);
});

// @spec MEM-SURF-001
test("a general note keeps its hint when it has one; one without has no hint field", async () => {
  const { store, ask } = setup();
  await viewer(store, "u1", "Alice");
  await note(store, "u1", "likes tea", { hint: "bring it up lightly" });
  await note(store, "u1", "likes cats");
  const [v] = await ask(["Alice"]);
  const byText = new Map(v!.notes.map((n) => [n.text, n]));
  assert.equal(byText.get("likes tea")!.hint, "bring it up lightly");
  assert.equal("hint" in byText.get("likes cats")!, false);
});

// @spec MEM-SURF-003
test("notes fade by effective strength: strongest first, below drop_below left out", async () => {
  const { store, ask, advance } = setup();
  await viewer(store, "u1", "Alice");
  await note(store, "u1", "old fact", { strength: 0.5 });
  advance(3 * DAY);
  await note(store, "u1", "fresh fact", { strength: 0.9 });
  const out = (await ask(["Alice"]))[0]!.notes;
  assert.deepEqual(out.map((n) => n.text), ["fresh fact", "old fact"]);
  assert.ok(out[1]!.strength < 0.5 && out[1]!.strength > 0.3, "the reply carries the effective strength");
  advance(40 * DAY);
  assert.deepEqual((await ask(["Alice"]))[0]!.notes, [], "both are below 0.1 now, though no pass has deleted them");
});

// @spec MEM-SURF-003
test("a note exactly at the drop_below boundary is still sent", async () => {
  const { store, ask } = setup();
  await viewer(store, "u1", "Alice");
  await note(store, "u1", "borderline", { strength: 0.1 });
  assert.equal((await ask(["Alice"]))[0]!.notes.length, 1);
});

// @spec MEM-SURF-003
test("at most max_notes_per_viewer each and max_notes_total overall, filling viewers in request order", async () => {
  const { store, ask } = setup({ max_notes_per_viewer: 2, max_notes_total: 3 });
  for (const [k, n] of [["u1", "A"], ["u2", "B"], ["u3", "C"]] as const) {
    await viewer(store, k, n);
    for (let i = 1; i <= 3; i++) await note(store, k, `${n} fact ${i}`, { strength: 1 - i / 10 });
  }
  const out = await ask(["A", "B", "C"]);
  assert.deepEqual(out.map((v) => [v.user, v.notes.map((n) => n.text)]), [
    ["A", ["A fact 1", "A fact 2"]],
    ["B", ["B fact 1"]],
    ["C", []],
  ]);
});

// @spec MEM-SURF-004
test("health and family notes: category and hint only, never the text, replied-to viewer only", async () => {
  const { store, ask } = setup();
  await viewer(store, "u1", "Alice");
  await viewer(store, "u2", "Bob");
  await store.insertNote({ userKey: "u1", category: "health", text: "has chronic fatigue" });
  await store.insertNote({ userKey: "u1", category: "family", text: "mother passed away", hint: "check in softly" });
  await store.insertNote({ userKey: "u2", category: "health", text: "recovering from surgery" });
  const out = await ask(["Alice", "Bob"]);
  const alice = out[0]!.notes;
  assert.deepEqual(alice.map((n) => [n.category, "text" in n, n.hint]), [
    ["health", false, "only if they bring it up; never quote it"],
    ["family", false, "check in softly"],
  ]);
  assert.deepEqual(out[1]!.notes, [], "other viewers' sensitive notes are never included");
  assert.doesNotMatch(JSON.stringify(out), /fatigue|passed away|surgery/);
});

// @spec MEM-SURF-004
test("a viewer is the replied-to one only when first in users; as a later name their sensitive notes stay home", async () => {
  const { store, ask } = setup();
  await viewer(store, "u1", "Alice");
  await viewer(store, "u2", "Bob");
  await store.insertNote({ userKey: "u1", category: "health", text: "x flu" });
  assert.deepEqual((await ask(["Bob", "Alice"]))[1]!.notes, []);
  assert.equal((await ask(["Alice", "Bob"]))[0]!.notes.length, 1);
});

// @spec MEM-SURF-004
test("a sensitive note is included at most once per sensitive_cooldown_hours and the time is recorded", async () => {
  const { store, ask, advance, now } = setup({ sensitive_cooldown_hours: 24 });
  await viewer(store, "u1", "Alice");
  const general = await note(store, "u1", "plays celeste");
  const sensitive = await store.insertNote({ userKey: "u1", category: "family", text: "dad is ill" });
  assert.equal((await ask(["Alice"]))[0]!.notes.length, 2);
  const after = new Map((await store.listNotes("u1")).map((n) => [n.id, n]));
  assert.equal(after.get(sensitive.id)!.lastSurfacedAt!.getTime(), now());
  assert.equal(after.get(general.id)!.lastSurfacedAt, null, "only sensitive notes are timed");
  advance(23 * 3_600_000);
  assert.deepEqual((await ask(["Alice"]))[0]!.notes.map((n) => n.category), ["general"], "inside the cooldown");
  advance(3_600_000);
  assert.deepEqual((await ask(["Alice"]))[0]!.notes.map((n) => n.category).sort(), ["family", "general"], "cooldown elapsed");
});

// @spec MEM-SURF-004
test("a sensitive note cut by a cap is not included and not recorded as surfaced", async () => {
  const { store, ask } = setup({ max_notes_per_viewer: 1 });
  await viewer(store, "u1", "Alice");
  await note(store, "u1", "strong fact", { strength: 1 });
  const s = await store.insertNote({ userKey: "u1", category: "health", text: "weak sensitive", strength: 0.5 });
  assert.deepEqual((await ask(["Alice"]))[0]!.notes.map((n) => n.category), ["general"]);
  assert.equal((await store.listNotes("u1")).find((n) => n.id === s.id)!.lastSurfacedAt, null);
});

// @spec MEM-SURF-005
test("a failing store makes buildNotesReply throw so the region handler can answer an empty list", async () => {
  const { cfg } = setup();
  const broken = { findViewerByDisplay: async () => { throw new Error("db down"); }, listNotes: async () => [], markSurfaced: async () => {} };
  await assert.rejects(buildNotesReply(broken as never, cfg, ["Alice"], T0), /db down/);
});
