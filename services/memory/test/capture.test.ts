import { test } from "node:test";
import assert from "node:assert/strict";
import { event, recordingLog, testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { ConsolidationScheduler } from "../src/scheduler.js";
import {
  captureImpl, createCaptureHandler, createCaptureHook, normaliseNoteText, validateCapture,
  type CaptureHook, type CaptureInput, type CaptureOutput,
} from "../src/capture.js";
import { mentionsForbiddenTopic } from "../src/notes.js";
import { DAY, T0 } from "./store-contract.js";

function setup(over: { notes?: Record<string, unknown>; kind?: "rules" | "llm" } = {}) {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", notes: over.notes ?? {} } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  const { log, lines } = recordingLog();
  const inputs: CaptureInput[] = [];
  let answer: (i: CaptureInput) => CaptureOutput | Promise<CaptureOutput> = () => ({ note: null });
  const hook: CaptureHook = { kind: over.kind ?? "llm", run: async (i) => { inputs.push(i); return answer(i); } };
  let written = 0;
  const onEvent = createCaptureHandler({ cfg, store, hook, log, onNotesWritten: async () => { written++; } });
  const chat = (extra: Record<string, unknown> = {}) =>
    event("chat.message", { platform: "twitch", user: "Bob", userId: "ID1", text: "just got a Steam Deck!", isMod: false, isSub: false, mentionsCohost: false, ...extra });
  return {
    cfg, store, inputs, lines, chat, onEvent, written: () => written, answer: (f: typeof answer) => { answer = f; },
    advance: (ms: number) => { now += ms; },
  };
}
const general = (text: string, hint?: string): CaptureOutput => ({ note: { category: "general", text, ...(hint ? { hint } : {}) } });

// @spec MEM-CAPTURE-002
test("every non-skipped line runs the capture hook, whether or not it mentions the co-host", async () => {
  const t = setup();
  await t.onEvent(t.chat());
  await t.onEvent(t.chat({ mentionsCohost: true }));
  await t.onEvent(t.chat({ injected: true, remember: true }));
  assert.equal(t.inputs.length, 3);
});

// @spec MEM-CAPTURE-002
test("an injected line not marked remember, and a line shorter than capture_min_chars, never reach the hook", async () => {
  const t = setup();
  await t.onEvent(t.chat({ injected: true }));
  await t.onEvent(t.chat({ injected: true, remember: false }));
  await t.onEvent(t.chat({ text: "gg wp" })); // 5 < 8
  await t.onEvent(t.chat({ text: "   gg wp   " })); // trimmed length counts
  assert.equal(t.inputs.length, 0);
  await t.onEvent(t.chat({ text: "12345678" })); // exactly capture_min_chars
  assert.equal(t.inputs.length, 1);
  const custom = setup({ notes: { capture_min_chars: 20 } });
  await custom.onEvent(custom.chat({ text: "just got a Steam Deck!" })); // 21
  await custom.onEvent(custom.chat({ text: "just got a Deck!" }));
  assert.equal(custom.inputs.length, 1);
});

// @spec MEM-CAPTURE-002
test("only chat.message is captured: speech.heard and other events are ignored", async () => {
  const t = setup();
  await t.onEvent(event("speech.heard", { speaker: "Chris", text: "we are going live in a minute", durationMs: 800 }));
  await t.onEvent(event("brain.say", { id: "1", text: "Hello chat, welcome in!", emotion: "happy" }));
  assert.equal(t.inputs.length, 0);
});

// @spec MEM-CAPTURE-002
test("a hook configured as rules costs nothing: no hook run and no store reads", async () => {
  const t = setup({ kind: "rules" });
  const reads: string[] = [];
  const store = new Proxy(t.store, { get: (o, k) => { reads.push(String(k)); return (o as never)[k]; } });
  const onEvent = createCaptureHandler({ cfg: t.cfg, store, hook: { kind: "rules", run: async () => { throw new Error("must not run"); } }, log: recordingLog().log });
  await onEvent(t.chat());
  assert.deepEqual(reads, []);
});

// @spec MEM-CAPTURE-004
test("the hook sees the viewer's display name, the line, their current note texts and only the reasons of reason-carrying deletions", async () => {
  const t = setup();
  const key = "id1";
  await t.store.ensureViewer(key, "Bob");
  await t.store.insertNote({ userKey: key, category: "general", text: "plays Hades" });
  const gone = await t.store.insertNote({ userKey: key, category: "general", text: "streams at night" });
  const soft = await t.store.insertNote({ userKey: key, category: "general", text: "owns a dog" });
  await t.store.deleteNote(gone.id, "  too personal ");
  await t.store.deleteNote(soft.id);
  await t.onEvent(t.chat({ text: "I just beat Celeste" }));
  assert.deepEqual(t.inputs, [{ viewer: "Bob", line: "I just beat Celeste", notes: ["plays Hades"], suppressionReasons: ["too personal"] }]);
});

// @spec MEM-CAPTURE-004, MEM-NOTE-009
test("only well-formed notes are accepted: category, text and hint bounds; anything else, including politics or money, is no note", () => {
  const ok = (note: unknown) => validateCapture({ note });
  assert.deepEqual(ok(null), { note: null });
  assert.deepEqual(ok({ category: "general", text: " plays Hades " }), { note: { category: "general", text: "plays Hades" } });
  assert.deepEqual(ok({ category: "health", text: "has migraines", hint: " ask gently " }), { note: { category: "health", text: "has migraines", hint: "ask gently" } });
  assert.deepEqual(ok({ category: "family", text: "lost a parent", hint: "" }), { note: { category: "family", text: "lost a parent" } });
  assert.equal(ok({ category: "general", text: "x".repeat(120) })?.note?.text.length, 120);
  assert.equal(ok({ category: "general", text: "fine", hint: "y".repeat(80) })?.note?.hint?.length, 80);
  for (const bad of [
    { category: "politics", text: "has views" }, { category: "money", text: "rich" }, { category: "", text: "a note" }, { text: "no category" },
    { category: "general", text: "" }, { category: "general", text: "   " }, { category: "general", text: "x".repeat(121) },
    { category: "general", text: 5 }, { category: "general", text: "fine", hint: "x".repeat(81) }, { category: "general", text: "fine", hint: 3 },
    "just a string", [], 7,
  ]) assert.equal(ok(bad), undefined, JSON.stringify(bad));
  assert.equal(validateCapture(undefined), undefined);
  assert.equal(validateCapture("note"), undefined);
  assert.equal(validateCapture({}), undefined, "no `note` key is unusable, so the hook falls back");
  assert.equal(captureImpl.llm!.validate({ note: null }, {} as never)?.note, null);
  assert.deepEqual(captureImpl.rules({} as never), { note: null });
});

// @spec MEM-NOTE-009
test("politics, money and subscriber status are never stored, whatever category the model gave", () => {
  for (const text of [
    "voted for Trump", "is a big Democrat", "hates the election results", "supports the left-wing party",
    "makes $200k a year", "earns 90k a year", "is a millionaire", "complains about their salary", "donated 50 dollars", "net worth is huge",
    "is a tier 3 sub", "has been subscribed for two years", "gifted subs last week",
  ]) {
    assert.equal(mentionsForbiddenTopic(text), true, text);
    assert.equal(validateCapture({ note: { category: "general", text } }), undefined, text);
  }
  assert.equal(validateCapture({ note: { category: "general", text: "fine", hint: "never mention their salary" } }), undefined, "the hint is checked too");
  for (const text of ["just got a Steam Deck", "plays Hades every night", "lost their dad last month", "bought a new keyboard", "streams on Tuesdays", "has two cats"]) {
    assert.equal(mentionsForbiddenTopic(text), false, text);
  }
});

// @spec MEM-NOTE-009, MEM-CAPTURE-004
test("the shipped prompt tells the model never to note politics, money or subscriber status, and carries the hook input", () => {
  const sys = captureImpl.llm!.system.toLowerCase();
  for (const word of ["politic", "money", "subscriber", "null"]) assert.ok(sys.includes(word), word);
  const user = captureImpl.llm!.user({ viewer: "Bob", line: "hi there friend", notes: ["likes owls"], suppressionReasons: ["too personal"] });
  for (const part of ["Bob", "hi there friend", "likes owls", "too personal"]) assert.ok(user.includes(part), part);
});

// @spec MEM-CAPTURE-003
test("the capture hook is a region-hooks Module on its own slot whose rules implementation returns no note", async () => {
  const hook = createCaptureHook(testConfig(), recordingLog().log);
  assert.equal(hook.kind, "rules");
  assert.deepEqual(await hook.run({ viewer: "Bob", line: "just got a Steam Deck", notes: [], suppressionReasons: [] }), { note: null });
  const llm = createCaptureHook(testConfig({ llm: { provider: "mock", model: "m" }, brain: { memory: { notes: { capture: { kind: "llm" } } } } }), recordingLog().log);
  assert.equal(llm.kind, "llm");
});

// @spec MEM-NOTE-011, MEM-CAPTURE-003
test("the capture hook builds an ollama provider under a hosted cortex, mock is inherited, and a hook-named provider wins", () => {
  const cfg = (provider: string, hook: Record<string, unknown> = {}) =>
    testConfig({ llm: { provider, model: "m" }, brain: { memory: { notes: { capture: { kind: "llm", ...hook } } } } });
  const providerOf = (c: ReturnType<typeof cfg>) => (createCaptureHook(c, recordingLog().log) as unknown as { provider: { name: string } }).provider.name;
  assert.equal(providerOf(cfg("ollama")), "ollama");
  assert.equal(providerOf(cfg("mock")), "mock");
  assert.equal(providerOf(cfg("anthropic")), "ollama", "a hosted cortex model does not see chat lines or health notes");
  assert.equal(providerOf(cfg("openai")), "ollama");
  assert.equal(providerOf(cfg("anthropic", { llm: { provider: "openai", model: "gpt-x" } })), "openai");
});

// @spec MEM-NOTE-012
test("under llm.provider mock the capture hook is built on mock even when the hook names ollama", () => {
  const c = testConfig({ llm: { provider: "mock", model: "m" }, brain: { memory: { notes: { capture: { kind: "llm", llm: { provider: "ollama", model: "gemma3:4b" } } } } } });
  assert.equal((createCaptureHook(c, recordingLog().log) as unknown as { provider: { name: string } }).provider.name, "mock");
});

// @spec MEM-CAPTURE-005, MEM-CAPTURE-009, MEM-CAPTURE-011, MEM-CONSOL-001
test("a new note is stored recent at strength 1 with one mention, dirty, on a viewer row created without counting a message, and the scheduler is told", async () => {
  const t = setup();
  t.answer(() => general("just got a Steam Deck"));
  await t.onEvent(t.chat());
  const viewer = (await t.store.getViewer("id1"))!;
  assert.deepEqual([viewer.display, viewer.msgCount], ["Bob", 0]);
  const [n] = await t.store.listNotes("id1");
  assert.deepEqual([n!.layer, n!.category, n!.text, n!.strength, n!.mentions, n!.dirty, n!.version], ["recent", "general", "just got a Steam Deck", 1, 1, true, 1]);
  assert.deepEqual(n!.embedding, await t.store.embedText("just got a Steam Deck"), "embedded with the store's embedder");
  assert.equal(t.written(), 1);
  const touch = await t.store.touchViewer("id1", "Bob"); // the memory group handles the same line afterwards
  assert.deepEqual([touch.msgCount, touch.isNew], [1, true]);
});

// @spec MEM-CAPTURE-011
test("the line is keyed by userId, or by the user name when there is no id, lowercased", async () => {
  const t = setup();
  t.answer(() => general("plays Hades"));
  await t.onEvent(t.chat({ userId: "AbC9" }));
  await t.onEvent(t.chat({ userId: undefined, user: "Zed" }));
  assert.equal((await t.store.listNotes("abc9")).length, 1);
  assert.equal((await t.store.listNotes("zed")).length, 1);
});

// @spec MEM-CAPTURE-011, MEM-REG-004
test("a note for a viewer the owner flagged before they chatted claims the placeholder and keeps the flag", async () => {
  const t = setup();
  await t.store.setRegular("Bob", true);
  t.answer(() => general("plays Hades"));
  await t.onEvent(t.chat());
  const v = (await t.store.getViewer("id1"))!;
  assert.deepEqual([v.regularManual, v.placeholder, v.msgCount], [true, false, 0]);
  assert.equal(await t.store.getViewer("bob"), undefined);
});

// @spec MEM-CAPTURE-008
test("a note whose normalised text equals an existing note reinforces it instead of adding one", async () => {
  const t = setup();
  t.answer(() => general("Plays  Hades."));
  await t.onEvent(t.chat());
  t.advance(7 * DAY);
  t.answer(() => general("plays hades!!"));
  await t.onEvent(t.chat());
  const notes = await t.store.listNotes("id1");
  assert.equal(notes.length, 1);
  assert.ok(Math.abs(notes[0]!.strength - 0.8) < 1e-9, "0.5 + 0.5 * 0.6");
  assert.deepEqual([notes[0]!.mentions, notes[0]!.dirty, notes[0]!.version], [2, true, 2]);
  assert.equal(t.written(), 2);
  assert.equal(normaliseNoteText("  Plays   HADES?! "), "plays hades");
});

// @spec MEM-CAPTURE-006
test("a note similar to a viewer's reason-carrying deletion is discarded; another viewer's deletion does not suppress it", async () => {
  const t = setup();
  await t.store.ensureViewer("id1", "Bob");
  await t.store.ensureViewer("id2", "Amy");
  const mine = await t.store.insertNote({ userKey: "id1", category: "general", text: "has a gambling problem" });
  const theirs = await t.store.insertNote({ userKey: "id2", category: "general", text: "plays Hades" });
  await t.store.deleteNote(mine.id, "do not remember gambling");
  await t.store.deleteNote(theirs.id, "private");
  t.answer(() => general("has a gambling problem"));
  await t.onEvent(t.chat());
  assert.deepEqual(await t.store.listNotes("id1"), []);
  assert.equal(t.written(), 0, "nothing was written, so the scheduler is not told");
  t.answer(() => general("plays Hades"));
  await t.onEvent(t.chat());
  assert.equal((await t.store.listNotes("id1")).length, 1);
});

// @spec MEM-CAPTURE-007
test("a note similar to a deletion without a reason comes back weak: a new recent note at returning_strength", async () => {
  const t = setup();
  await t.store.ensureViewer("id1", "Bob");
  const old = await t.store.insertNote({ userKey: "id1", category: "general", text: "plays Hades" });
  await t.store.deleteNote(old.id);
  t.answer(() => general("plays Hades"));
  await t.onEvent(t.chat());
  const [n] = await t.store.listNotes("id1");
  assert.deepEqual([n!.layer, n!.strength, n!.mentions, n!.dirty], ["recent", 0.3, 1, true]);
  const custom = setup({ notes: { returning_strength: 0.5 } });
  await custom.store.ensureViewer("id1", "Bob");
  const o2 = await custom.store.insertNote({ userKey: "id1", category: "general", text: "plays Hades" });
  await custom.store.deleteNote(o2.id);
  custom.answer(() => general("plays Hades"));
  await custom.onEvent(custom.chat());
  assert.equal((await custom.store.listNotes("id1"))[0]!.strength, 0.5);
});

// @spec MEM-CAPTURE-006, MEM-CAPTURE-007, MEM-CAPTURE-008
test("suppression is checked before duplication, which is checked before a soft return", async () => {
  const t = setup();
  await t.store.ensureViewer("id1", "Bob");
  const live = await t.store.insertNote({ userKey: "id1", category: "general", text: "plays Hades" });
  const dupe = await t.store.insertNote({ userKey: "id1", category: "general", text: "plays Hades" });
  await t.store.deleteNote(dupe.id); // a soft memory of the same text
  t.answer(() => general("plays Hades"));
  await t.onEvent(t.chat());
  const notes = await t.store.listNotes("id1");
  assert.deepEqual(notes.map((n) => [n.id, n.mentions]), [[live.id, 2]], "reinforced, not returned weak");
});

// @spec MEM-CAPTURE-010
test("a failing hook, embedding or store write logs a warning, stores nothing for that line and does not stop later lines", async () => {
  const t = setup();
  t.answer(() => { throw new Error("hook boom"); });
  await t.onEvent(t.chat());
  t.answer(() => general("plays Hades"));
  const embed = t.store.embedText.bind(t.store);
  t.store.embedText = async () => { throw new Error("embed boom"); };
  await t.onEvent(t.chat());
  t.store.embedText = embed;
  const insert = t.store.insertNote.bind(t.store);
  t.store.insertNote = async () => { throw new Error("db boom"); };
  await t.onEvent(t.chat());
  t.store.insertNote = insert;
  const ensure = t.store.ensureViewer.bind(t.store);
  t.store.ensureViewer = async () => { throw new Error("row boom"); };
  await t.onEvent(t.chat());
  t.store.ensureViewer = ensure;
  assert.equal(t.lines.filter((l) => l.level === "warn").length, 4);
  assert.equal(t.written(), 0);
  assert.deepEqual(await t.store.listNotes("id1"), []);
  await t.onEvent(t.chat()); // the next line is handled normally
  assert.equal((await t.store.listNotes("id1")).length, 1);
});

// @spec MEM-CAPTURE-010
test("a rules fallback answer is no note: nothing is stored", async () => {
  const t = setup();
  t.answer(() => ({ note: null }));
  await t.onEvent(t.chat());
  assert.equal(await t.store.getViewer("id1"), undefined, "not even a viewer row");
  assert.equal(t.written(), 0);
});

// @spec MEM-CAPTURE-010
test("a failure in the scheduler notification is logged and does not fail the line", async () => {
  const t = setup();
  const { log, lines } = recordingLog();
  const onEvent = createCaptureHandler({
    cfg: t.cfg, store: t.store, hook: { kind: "llm", run: async () => general("plays Hades") }, log,
    onNotesWritten: async () => { throw new Error("count boom"); },
  });
  await onEvent(t.chat());
  assert.equal((await t.store.listNotes("id1")).length, 1);
  assert.equal(lines.filter((l) => l.level === "warn").length, 1);
});

// @spec MEM-NOTE-010
test("a health or family note without a hint gets the category's default hint", async () => {
  const t = setup();
  t.answer(() => ({ note: { category: "family", text: "lost their mother" } }));
  await t.onEvent(t.chat());
  assert.equal((await t.store.listNotes("id1"))[0]!.hint, "check in warmly and gently; never name or quote it");
});

// @spec MEM-CONSOL-001
test("captured notes reach dirty_threshold and the scheduler starts one pass", async () => {
  const t = setup({ notes: { dirty_threshold: 2 } });
  let passes = 0;
  let release!: () => void;
  const started = new Promise<void>((r) => { release = r; });
  const scheduler = new ConsolidationScheduler({
    store: t.store, cfg: t.cfg.notes, log: recordingLog().log,
    runPass: async () => { passes++; release(); return { status: "completed", viewers: 0, notes: 0 }; },
  });
  const onEvent = createCaptureHandler({
    cfg: t.cfg, store: t.store, hook: { kind: "llm", run: async (i) => general(`note about ${i.line}`) }, log: recordingLog().log,
    onNotesWritten: () => scheduler.notifyDirty(),
  });
  await onEvent(t.chat({ text: "playing Hades now" }));
  assert.equal(passes, 0, "one dirty note is below the threshold");
  await onEvent(t.chat({ text: "playing Celeste now" }));
  await started;
  assert.equal(passes, 1);
  await scheduler.shutdown();
});
