import { test } from "node:test";
import assert from "node:assert/strict";
import { event, recordingLog, testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { createCaptureHandler } from "../src/capture.js";
import { buildNotesReply } from "../src/surface.js";
import { viewerKey } from "@cohost/shared/untrusted";
import { DAY, T0 } from "./store-contract.js";

function setup(notesCfg: Record<string, unknown> = {}) {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", regular_messages: 3, notes: notesCfg } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  const ask = (users: string[]) => buildNotesReply(store, cfg, users.map((user) => ({ user })), now);
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
  await viewer(store, "twitch:name:u1", "Alice", 5);
  await viewer(store, "twitch:name:u2", "Bob");
  await note(store, "twitch:name:u1", "plays celeste");
  const out = await ask(["bob", "Ghost", "ALICE"]);
  assert.deepEqual(out.map((v) => [v.user, v.regular, v.msgCount, v.notes.length]), [["Bob", false, 1, 0], ["Alice", true, 5, 1]]);
  assert.deepEqual(out[1]!.notes[0], { layer: "recent", category: "general", text: "plays celeste", strength: 1 });
  assert.deepEqual(await ask(["Ghost"]), [], "an empty list is a valid answer");
  assert.deepEqual(await ask([]), []);
});

// @spec MEM-SURF-001
test("the same viewer named twice is listed once; the reply carries no subscriber status", async () => {
  const { store, ask } = setup();
  await store.touchViewer("twitch:name:u1", "Alice", { isSub: true });
  const out = await ask(["Alice", "alice"]);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["msgCount", "notes", "regular", "user"]);
});

// @spec MEM-SURF-001
test("a general note keeps its hint when it has one; one without has no hint field", async () => {
  const { store, ask } = setup();
  await viewer(store, "twitch:name:u1", "Alice");
  await note(store, "twitch:name:u1", "likes tea", { hint: "bring it up lightly" });
  await note(store, "twitch:name:u1", "likes cats");
  const [v] = await ask(["Alice"]);
  const byText = new Map(v!.notes.map((n) => [n.text, n]));
  assert.equal(byText.get("likes tea")!.hint, "bring it up lightly");
  assert.equal("hint" in byText.get("likes cats")!, false);
});

// @spec MEM-SURF-003
test("notes fade by effective strength: strongest first, below drop_below left out", async () => {
  const { store, ask, advance } = setup();
  await viewer(store, "twitch:name:u1", "Alice");
  await note(store, "twitch:name:u1", "old fact", { strength: 0.5 });
  advance(3 * DAY);
  await note(store, "twitch:name:u1", "fresh fact", { strength: 0.9 });
  const out = (await ask(["Alice"]))[0]!.notes;
  assert.deepEqual(out.map((n) => n.text), ["fresh fact", "old fact"]);
  assert.ok(out[1]!.strength < 0.5 && out[1]!.strength > 0.3, "the reply carries the effective strength");
  advance(40 * DAY);
  assert.deepEqual((await ask(["Alice"]))[0]!.notes, [], "both are below 0.1 now, though no pass has deleted them");
});

// @spec MEM-SURF-003
test("a note exactly at the drop_below boundary is still sent", async () => {
  const { store, ask } = setup();
  await viewer(store, "twitch:name:u1", "Alice");
  await note(store, "twitch:name:u1", "borderline", { strength: 0.1 });
  assert.equal((await ask(["Alice"]))[0]!.notes.length, 1);
});

// @spec MEM-SURF-003
test("at most max_notes_per_viewer each and max_notes_total overall, filling viewers in request order", async () => {
  const { store, ask } = setup({ max_notes_per_viewer: 2, max_notes_total: 3 });
  for (const [k, n] of [["twitch:name:u1", "A"], ["twitch:name:u2", "B"], ["twitch:name:u3", "C"]] as const) {
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
  await viewer(store, "twitch:name:u1", "Alice");
  await viewer(store, "twitch:name:u2", "Bob");
  await store.insertNote({ userKey: "twitch:name:u1", category: "health", text: "has chronic fatigue" });
  await store.insertNote({ userKey: "twitch:name:u1", category: "family", text: "mother passed away", hint: "check in softly" });
  await store.insertNote({ userKey: "twitch:name:u2", category: "health", text: "recovering from surgery" });
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
  await viewer(store, "twitch:name:u1", "Alice");
  await viewer(store, "twitch:name:u2", "Bob");
  await store.insertNote({ userKey: "twitch:name:u1", category: "health", text: "x flu" });
  assert.deepEqual((await ask(["Bob", "Alice"]))[1]!.notes, []);
  assert.equal((await ask(["Alice", "Bob"]))[0]!.notes.length, 1);
});

// @spec MEM-SURF-004
test("a sensitive note is included at most once per sensitive_cooldown_hours and the time is recorded", async () => {
  const { store, ask, advance, now } = setup({ sensitive_cooldown_hours: 24 });
  await viewer(store, "twitch:name:u1", "Alice");
  const general = await note(store, "twitch:name:u1", "plays celeste");
  const sensitive = await store.insertNote({ userKey: "twitch:name:u1", category: "family", text: "dad is ill" });
  assert.equal((await ask(["Alice"]))[0]!.notes.length, 2);
  const after = new Map((await store.listNotes("twitch:name:u1")).map((n) => [n.id, n]));
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
  await viewer(store, "twitch:name:u1", "Alice");
  await note(store, "twitch:name:u1", "strong fact", { strength: 1 });
  const s = await store.insertNote({ userKey: "twitch:name:u1", category: "health", text: "weak sensitive", strength: 0.5 });
  assert.deepEqual((await ask(["Alice"]))[0]!.notes.map((n) => n.category), ["general"]);
  assert.equal((await store.listNotes("twitch:name:u1")).find((n) => n.id === s.id)!.lastSurfacedAt, null);
});

// @spec MEM-SURF-005
test("a failing store makes buildNotesReply throw so the region handler can answer an empty list", async () => {
  const { cfg } = setup();
  const broken = { findNameKeyedViewerByDisplay: async () => { throw new Error("db down"); }, listNotes: async () => [], markSurfaced: async () => {} };
  await assert.rejects(buildNotesReply(broken as never, cfg, ["Alice"], T0), /db down/);
});

// @spec MEM-REG-002
test("a viewer on their first message gets a note captured and surfaced: regular status gates neither", async () => {
  const { store, cfg, ask } = setup();
  const onEvent = createCaptureHandler({
    cfg, full: testConfig(), store, log: recordingLog().log,
    hook: { kind: "llm", run: async () => ({ note: { category: "general", text: "just got a Steam Deck" } }) },
  });
  await onEvent(event("chat.message", { platform: "twitch", user: "Newbie", userId: "n1", text: "just got a Steam Deck!", isMod: false, isSub: false, mentionsCohost: false }));
  const [v] = await buildNotesReply(store, cfg, [{ user: "Newbie", platform: "twitch", userId: "n1" }] as never, T0);
  assert.equal(v!.regular, false);
  assert.deepEqual(v!.notes.map((n) => n.text), ["just got a Steam Deck"]);
});

// @spec MEM-VOICE-008
test("a linked voice viewer's health note reaches the cortex as a hint only, once per cooldown, on the chat viewer that carries it", async () => {
  const { store, cfg, advance, now } = setup();
  const chat = viewerKey({ platform: "twitch", userId: "ID1", user: "Chris" });
  await store.touchViewer(chat, "Chris");
  await store.linkDiscord("D1", chat);
  await store.touchSpeaker("D1", "Chris");
  await store.insertNote({ userKey: chat, category: "health", text: "has the flu", hint: "check in gently" });
  await store.insertNote({ userKey: chat, category: "general", text: "plays chess" });
  const ask = () => buildNotesReply(store, cfg, [{ user: "Chris", platform: "twitch", userId: "ID1" }] as never, now());
  const [first] = await ask();
  assert.equal(first!.user, "Chris");
  const health = first!.notes.find((n) => n.category === "health")!;
  assert.deepEqual(health, { layer: "recent", category: "health", hint: "check in gently", strength: 1 });
  assert.ok(!("text" in health), "health text never leaves memory");
  assert.equal(first!.notes.find((n) => n.category === "general")!.text, "plays chess");
  const [second] = await ask();
  assert.ok(!second!.notes.some((n) => n.category === "health"), "the sensitive cooldown applies");
  advance(25 * 3_600_000);
  assert.ok((await ask())[0]!.notes.some((n) => n.category === "health"));
});

// @spec MEM-VOICE-007, MEM-SURF-006
test("a linked speaker's Discord display name finds nothing: not the chat viewer the link names, not the voice row", async () => {
  const { store, ask } = setup();
  const chat = viewerKey({ platform: "twitch", userId: "ID1", user: "BobChat" });
  await store.touchViewer(chat, "BobChat");
  await store.linkDiscord("D1", chat);
  await store.touchSpeaker("D1", "bob_voice");
  await store.insertNote({ userKey: chat, category: "general", text: "plays chess" });
  assert.deepEqual(await ask(["Bob_Voice"]), [], "no alias through discord_display");
  assert.deepEqual(await ask(["BobChat"]), [], "an id-keyed row is not reached by name either");
  const nameKeyed = viewerKey({ platform: "twitch", user: "Nia" });
  await store.touchViewer(nameKeyed, "Nia");
  await store.linkDiscord("D2", nameKeyed);
  await store.touchSpeaker("D2", "nia_voice");
  await store.insertNote({ userKey: nameKeyed, category: "general", text: "likes tea" });
  assert.deepEqual(await ask(["nia_voice"]), [], "a link to a name-keyed viewer is no alias either");
  assert.deepEqual((await ask(["Nia"])).map((v) => v.notes.map((n) => n.text)), [["likes tea"]], "the viewer's own display still resolves");
});

// @spec MEM-SURF-006
test("an unlinked voice viewer is never reached by an entry with no platform, whatever its display", async () => {
  const { store, ask } = setup();
  await store.touchSpeaker("D9", "Chris");
  await store.insertNote({ userKey: "discord:d9", category: "general", text: "plays chess" });
  assert.deepEqual(await ask(["Chris"]), []);
});

// ---- Issue #180: viewers resolved by platform and id (entries are `{user, platform?, userId?}`) ----
type Entry = { user: string; platform?: "twitch" | "youtube" | "discord"; userId?: string };
const askEntries = (s: ReturnType<typeof setup>, entries: Entry[]) => buildNotesReply(s.store, s.cfg, entries as never, s.now());

// @spec MEM-SURF-002, MEM-VIEWER-010
test("an entry with platform and userId resolves only to the row of that key; a same-named viewer on another platform never answers", async () => {
  const s = setup();
  const tw = viewerKey({ platform: "twitch", userId: "111", user: "Sam" });
  const yt = viewerKey({ platform: "youtube", userId: "UCsam", user: "Sam" });
  await viewer(s.store, tw, "Sam");
  await viewer(s.store, yt, "Sam");
  await note(s.store, tw, "twitch sam plays celeste");
  await note(s.store, yt, "youtube sam likes tea");
  const out = await askEntries(s, [{ user: "Sam", platform: "youtube", userId: "UCsam" }]);
  assert.deepEqual(out.map((v) => v.notes.map((n) => n.text)), [["youtube sam likes tea"]]);
  assert.deepEqual(await askEntries(s, [{ user: "Sam", platform: "twitch", userId: "999" }]), [], "no row for that key: omitted, though a display name matches");
  assert.deepEqual(await askEntries(s, [{ user: "Sam", platform: "youtube", userId: "ucsam" }]), [], "an id is never case-folded");
});

// @spec MEM-SURF-001
test("each reply entry echoes the platform and userId of the request entry it answers", async () => {
  const s = setup();
  await viewer(s.store, viewerKey({ platform: "twitch", userId: "111", user: "Sam" }), "Sam");
  await viewer(s.store, viewerKey({ platform: "discord", user: "Kit" }), "Kit");
  const out = await askEntries(s, [{ user: "Sam", platform: "twitch", userId: "111" }, { user: "Kit", platform: "discord" }]);
  assert.deepEqual(
    out.map((v) => [v.user, (v as { platform?: string }).platform, (v as { userId?: string }).userId]),
    [["Sam", "twitch", "111"], ["Kit", "discord", undefined]],
  );
});

// @spec MEM-SURF-007
test("an entry with a platform and no userId resolves by the name key of that platform and never by display name", async () => {
  const s = setup();
  await viewer(s.store, viewerKey({ platform: "twitch", user: "Kit" }), "Kit");
  await viewer(s.store, viewerKey({ platform: "youtube", userId: "UCkit", user: "Kit" }), "Kit", 3);
  const out = await askEntries(s, [{ user: "KIT", platform: "twitch" }]);
  assert.deepEqual(out.map((v) => [v.user, v.msgCount]), [["Kit", 1]], "the twitch name-key row, not the id-keyed youtube row");
  assert.deepEqual(await askEntries(s, [{ user: "Kit", platform: "discord" }]), [], "no name-key row on that platform");
});

// @spec MEM-SURF-006
test("an entry with no platform resolves by display name among name-keyed rows only, case-insensitively, to the latest last_seen", async () => {
  const s = setup();
  const a = viewerKey({ platform: "twitch", user: "Sam" });
  const b = viewerKey({ platform: "youtube", user: "Sam" });
  await viewer(s.store, a, "Sam");
  s.advance(1000);
  await viewer(s.store, b, "sam");
  await note(s.store, a, "older sam");
  await note(s.store, b, "newer sam");
  const out = await askEntries(s, [{ user: "SAM" }]);
  assert.deepEqual(out.map((v) => v.notes.map((n) => n.text)), [["newer sam"]]);
});

// @spec MEM-SURF-006
test("an id-keyed row is never picked by a no-platform entry, even when it is the latest seen or the only row with that display", async () => {
  const s = setup();
  const named = viewerKey({ platform: "twitch", user: "Sam" });
  const byId = viewerKey({ platform: "youtube", userId: "UCsam", user: "Sam" });
  await viewer(s.store, named, "Sam");
  s.advance(1000);
  await viewer(s.store, byId, "Sam", 9);
  await note(s.store, named, "name-keyed sam");
  await note(s.store, byId, "id-keyed sam");
  assert.deepEqual((await askEntries(s, [{ user: "sam" }])).map((v) => v.notes.map((n) => n.text)), [["name-keyed sam"]], "the later id-keyed row does not mask the name-keyed one");
  const solo = viewerKey({ platform: "twitch", userId: "42", user: "Solo" });
  await viewer(s.store, solo, "Solo");
  await note(s.store, solo, "solo note");
  assert.deepEqual(await askEntries(s, [{ user: "Solo" }]), [], "only an id-keyed row has that display: omitted");
});

// @spec MEM-SURF-006, MEM-VIEWER-010
test("hostile names and ids cannot address another viewer's row: an entry reaches only the key it builds", async () => {
  const s = setup();
  const victim = viewerKey({ platform: "twitch", userId: "123", user: "Victim" });
  const bob = viewerKey({ platform: "twitch", user: "bob" });
  await viewer(s.store, victim, "Victim");
  await viewer(s.store, bob, "Bob");
  await note(s.store, victim, "victim secret");
  await note(s.store, bob, "bob note");
  const reached = async (e: Entry) => JSON.stringify(await askEntries(s, [e]));
  for (const e of [
    { user: "id:123" }, { user: "twitch:id:123" }, { user: "name:bob" }, { user: "discord:name:x" },
    { user: "id:123", platform: "twitch" as const }, { user: "123", platform: "twitch" as const }, { user: "twitch:id:123", platform: "twitch" as const },
  ]) assert.doesNotMatch(await reached(e), /victim secret/, JSON.stringify(e));
  assert.doesNotMatch(await reached({ user: "x", platform: "twitch", userId: "name:bob" }), /bob note/, "an id that reads name:bob is not the viewer named bob");
  assert.doesNotMatch(await reached({ user: "name:bob", platform: "twitch" }), /bob note/, "a name that reads name:bob is not the viewer named bob");
  // A chatter whose display name reads like a key resolves only to their own row.
  const mallory = viewerKey({ platform: "twitch", user: "id:123" });
  await viewer(s.store, mallory, "id:123");
  await note(s.store, mallory, "mallory note");
  const out = JSON.stringify(await askEntries(s, [{ user: "id:123" }]));
  assert.match(out, /mallory note/);
  assert.doesNotMatch(out, /victim secret/);
  // A chatter whose display is the victim's name never inherits the victim's notes, and the victim keeps theirs by id.
  const imposter = viewerKey({ platform: "youtube", user: "Victim" });
  await viewer(s.store, imposter, "Victim");
  assert.doesNotMatch(await reached({ user: "Victim" }), /victim secret/);
  assert.match(await reached({ user: "Victim", platform: "twitch", userId: "123" }), /victim secret/);
});

// @spec MEM-VIEWER-011
test("a row keyed in any other format is never read: a display-name entry does not find it", async () => {
  const s = setup();
  await viewer(s.store, "legacy-key", "Old");
  assert.deepEqual(await askEntries(s, [{ user: "Old" }]), []);
});

// @spec MEM-VOICE-007
test("an entry with no platform and no display match does not resolve through the linked Discord id's discord_display", async () => {
  const s = setup();
  const chatKey = viewerKey({ platform: "twitch", userId: "42", user: "Dana" });
  await viewer(s.store, chatKey, "Dana");
  await s.store.linkDiscord("555", chatKey);
  await s.store.touchSpeaker("555", "DanaOnVoice");
  await note(s.store, chatKey, "streams late");
  assert.deepEqual(await askEntries(s, [{ user: "danaonvoice" }]), []);
  assert.deepEqual(await askEntries(s, [{ user: "danaonvoice", platform: "twitch" }]), []);
  assert.deepEqual((await askEntries(s, [{ user: "Dana", platform: "twitch", userId: "42" }])).map((v) => v.notes.map((n) => n.text)), [["streams late"]], "the linked chat viewer answers by its own key");
});

// @spec MEM-SURF-004
test("sensitive notes stay hint-only and for the first entry only when entries carry platform and id", async () => {
  const s = setup();
  const a = viewerKey({ platform: "twitch", userId: "1", user: "Alice" });
  const b = viewerKey({ platform: "twitch", userId: "2", user: "Bob" });
  await viewer(s.store, a, "Alice");
  await viewer(s.store, b, "Bob");
  await s.store.insertNote({ userKey: a, category: "health", text: "has flu" });
  await s.store.insertNote({ userKey: b, category: "health", text: "has cough" });
  const out = await askEntries(s, [{ user: "Alice", platform: "twitch", userId: "1" }, { user: "Bob", platform: "twitch", userId: "2" }]);
  assert.deepEqual(out.map((v) => v.notes.map((n) => "text" in n)), [[false], []]);
  assert.doesNotMatch(JSON.stringify(out), /flu|cough/);
});
