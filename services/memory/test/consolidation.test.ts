import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingLog, testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { runConsolidation, type Consolidator } from "../src/consolidation.js";
import { consolidatorImpl, createConsolidatorHook, notesHookLlm, type ConsolidatorInput, type ConsolidatorOutput } from "../src/consolidator.js";
import { DAY, T0 } from "./store-contract.js";

function setup(over: Record<string, unknown> = {}) {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", ...over } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  const { log, lines } = recordingLog();
  const calls: ConsolidatorInput[] = [];
  let answer: (input: ConsolidatorInput) => ConsolidatorOutput | Promise<ConsolidatorOutput> = () => ({ ops: [] });
  const hook: Consolidator = { run: async (input) => { calls.push(input); return answer(input); } };
  const pass = (extra: Partial<Parameters<typeof runConsolidation>[0]> = {}) =>
    runConsolidation({ store, hook, cfg, log, now: () => now, ...extra });
  const viewer = async (key: string) => { await store.touchViewer(key, key); return key; };
  const note = (userKey: string, text: string, extra: Partial<Parameters<InMemoryStore["insertNote"]>[0]> = {}) =>
    store.insertNote({ userKey, category: "general", text, ...extra });
  return { store, cfg, hook, calls, pass, viewer, note, lines, advance: (ms: number) => { now += ms; }, now: () => now, answer: (f: typeof answer) => { answer = f; } };
}

// @spec MEM-CONSOL-004
test("a pass processes each viewer with a dirty note, one at a time, and leaves the others alone", async () => {
  const t = setup();
  const [a, b, c] = [await t.viewer("amy"), await t.viewer("bob"), await t.viewer("cat")];
  await t.note(a, "plays Elden Ring");
  await t.note(b, "has two cats");
  await t.note(c, "is a nurse", { dirty: false });
  const order: string[] = [];
  t.answer((input) => { order.push(input.viewer); return { ops: [] }; });
  const res = await t.pass();
  assert.deepEqual(order, ["amy", "bob"]);
  assert.deepEqual(res, { status: "completed", viewers: 2, notes: 2 });
  assert.equal(await t.store.dirtyNoteCount(), 0);
});

// @spec MEM-CONSOL-004, MEM-CONSOL-005
test("the consolidator is given the viewer's name, the notes that remain and the suppression reasons", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "plays Elden Ring", { layer: "core", strength: 0.9 });
  await t.note(k, "feeling sick", { category: "health" });
  const d = await t.note(k, "talks politics");
  await t.store.deleteNote(d.id, "never store politics");
  const soft = await t.note(k, "likes spiders");
  await t.store.deleteNote(soft.id);
  await t.pass();
  assert.equal(t.calls.length, 1);
  const input = t.calls[0]!;
  assert.equal(input.viewer, "amy");
  assert.deepEqual(input.suppressionReasons, ["never store politics"]);
  assert.deepEqual(input.notes.map((n) => [n.text, n.layer, n.category]), [["plays Elden Ring", "core", "general"], ["feeling sick", "recent", "health"]]);
  assert.equal(typeof input.notes[0]!.id, "number");
  assert.equal(input.notes[1]!.hint, "only if they bring it up; never quote it");
});

// @spec MEM-NOTE-006
test("a recent note that reached promote_mentions moves to core keeping its strength", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const n = await t.note(k, "speedruns Celeste", { mentions: 3, strength: 0.8 });
  const low = await t.note(k, "plays chess", { mentions: 2 });
  await t.pass();
  const notes = await t.store.listNotes(k);
  const promoted = notes.find((x) => x.id === n.id)!;
  assert.deepEqual([promoted.layer, promoted.strength, promoted.mentions], ["core", 0.8, 3]);
  assert.equal(notes.find((x) => x.id === low.id)!.layer, "recent");
});

// @spec MEM-NOTE-007
test("a core note below demote_below moves to recent at its effective strength, mentions reset, clock restarted", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const n = await t.note(k, "streams on tuesdays", { layer: "core", mentions: 6 });
  const fresh = await t.note(k, "plays Hades", { layer: "core" });
  t.advance(114 * DAY); // 2^(-114/60) = 0.268, below the 0.3 default
  await t.pass();
  const notes = await t.store.listNotes(k);
  const demoted = notes.find((x) => x.id === n.id)!;
  assert.equal(demoted.layer, "recent");
  assert.ok(Math.abs(demoted.strength - Math.pow(0.5, 114 / 60)) < 1e-9);
  assert.deepEqual([demoted.mentions, demoted.strengthAt.getTime()], [0, t.now()]);
  assert.equal(notes.find((x) => x.id === fresh.id)!.layer, "recent", "the second core note also fell below 0.3");
});

// @spec MEM-NOTE-007
test("a core note still above demote_below stays core", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const n = await t.note(k, "streams on tuesdays", { layer: "core" });
  t.advance(60 * DAY); // 0.5
  await t.pass();
  assert.equal((await t.store.listNotes(k)).find((x) => x.id === n.id)!.layer, "core");
});

// @spec MEM-NOTE-008
test("a recent note below drop_below is deleted with no deletion record", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "old news");
  t.advance(25 * DAY); // 2^(-25/7) = 0.084
  await t.note(k, "new news");
  await t.pass();
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.text), ["new news"]);
  assert.deepEqual(await t.store.listDeletions(k), []);
});

// @spec MEM-NOTE-007, MEM-NOTE-008
test("a core note that has faded below drop_below is demoted and then dropped in the same pass", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "ancient fact", { layer: "core" });
  t.advance(400 * DAY); // 2^(-400/60) = 0.01
  await t.note(k, "recent fact");
  await t.pass();
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.text), ["recent fact"]);
});

// @spec MEM-NOTE-006, MEM-NOTE-008
test("thresholds come from config", async () => {
  const t = setup({ notes: { promote_mentions: 2, drop_below: 0.5 } });
  const k = await t.viewer("amy");
  const two = await t.note(k, "mentioned twice", { mentions: 2 });
  await t.note(k, "half faded");
  t.advance(8 * DAY); // 0.45 < 0.5 would drop; 'mentioned twice' too
  await t.note(k, "fresh");
  await t.pass();
  const notes = await t.store.listNotes(k);
  assert.deepEqual(notes.map((n) => n.text), ["fresh"], "both old notes fell below the configured drop_below");
  assert.equal(notes.find((n) => n.id === two.id), undefined);
  const t2 = setup({ notes: { promote_mentions: 2 } });
  const k2 = await t2.viewer("amy");
  const n2 = await t2.note(k2, "mentioned twice", { mentions: 2 });
  await t2.pass();
  assert.equal((await t2.store.listNotes(k2)).find((n) => n.id === n2.id)!.layer, "core");
});

// @spec MEM-CONSOL-009
test("notes similar to a viewer's reason-carrying deletion are dropped without a deletion record; soft deletions never suppress", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const gone = await t.note(k, "is saving for a new car");
  await t.store.deleteNote(gone.id, "money is off limits");
  const soft = await t.note(k, "likes spiders a lot");
  await t.store.deleteNote(soft.id);
  await t.note(k, "is saving for a new car"); // same words as the suppressed note
  await t.note(k, "likes spiders a lot"); // same words as a soft deletion: kept
  await t.note(k, "plays Hades");
  const other = await t.viewer("bob");
  await t.note(other, "is saving for a new car"); // another viewer's rule does not apply
  const before = (await t.store.listDeletions(k)).length;
  await t.pass();
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.text), ["likes spiders a lot", "plays Hades"]);
  assert.equal((await t.store.listDeletions(k)).length, before);
  assert.deepEqual((await t.store.listNotes(other)).map((n) => n.text), ["is saving for a new car"]);
});

// @spec MEM-CONSOL-009
test("suppression uses suppress_similarity from config", async () => {
  const t = setup({ notes: { suppress_similarity: 0.99 } });
  const k = await t.viewer("amy");
  const gone = await t.note(k, "is saving for a new car");
  await t.store.deleteNote(gone.id, "no money");
  await t.note(k, "is saving for a car"); // close, not identical
  await t.pass();
  assert.equal((await t.store.listNotes(k)).length, 1);
});

// @spec MEM-CONSOL-005, MEM-CONSOL-006
test("merge keeps one note: merged text, core if any member was core, strongest reinforced once per extra member, mentions summed", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "plays Elden Ring", { strength: 0.5, mentions: 1 });
  const b = await t.note(k, "loves Elden Ring", { layer: "core", strength: 0.4, mentions: 2 });
  const c = await t.note(k, "streams Elden Ring", { strength: 0.2, mentions: 1 });
  t.answer(() => ({ ops: [{ op: "merge", ids: [a.id, b.id, c.id], text: "plays and loves Elden Ring" }] }));
  const res = await t.pass();
  assert.equal(res.status, "completed");
  const notes = await t.store.listNotes(k);
  assert.equal(notes.length, 1);
  const m = notes[0]!;
  assert.equal(m.id, a.id, "the strongest member survives");
  assert.deepEqual([m.text, m.layer, m.mentions, m.dirty, m.strengthAt.getTime()], ["plays and loves Elden Ring", "core", 4, false, t.now()]);
  // 0.5 -> 0.5 + 0.5 * 0.6 = 0.8 -> 0.8 + 0.2 * 0.6 = 0.92
  assert.ok(Math.abs(m.strength - 0.92) < 1e-9, `got ${m.strength}`);
  assert.deepEqual(await t.store.listDeletions(k), [], "merged members leave no deletion record");
});

// @spec MEM-CONSOL-005
test("rewrite changes text, category or hint of one note; a sensitive category gets the default hint", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "ugh my back");
  const b = await t.note(k, "plays hades", { category: "family", hint: "be gentle" });
  t.answer(() => ({ ops: [
    { op: "rewrite", id: a.id, text: "has back pain", category: "health" },
    { op: "rewrite", id: b.id, text: "plays Hades" },
  ] }));
  await t.pass();
  const notes = await t.store.listNotes(k);
  const na = notes.find((n) => n.id === a.id)!;
  assert.deepEqual([na.text, na.category, na.hint, na.version, na.dirty], ["has back pain", "health", "only if they bring it up; never quote it", 2, false]);
  const nb = notes.find((n) => n.id === b.id)!;
  assert.deepEqual([nb.text, nb.category, nb.hint], ["plays Hades", "family", "be gentle"]);
});

// @spec MEM-CONSOL-005
test("drop deletes one note without a deletion record", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "says hi a lot");
  await t.note(k, "plays Hades");
  t.answer(() => ({ ops: [{ op: "drop", id: a.id }] }));
  await t.pass();
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.text), ["plays Hades"]);
  assert.deepEqual(await t.store.listDeletions(k), []);
});

// @spec MEM-CONSOL-005
test("operations naming unknown, faded or already-consumed ids are discarded without disturbing the rest", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "plays Hades");
  const b = await t.note(k, "plays Celeste");
  t.answer(() => ({ ops: [
    { op: "drop", id: 424242 },
    { op: "rewrite", id: 424242, text: "ghost" },
    { op: "merge", ids: [a.id, 424242], text: "bad merge" },
    { op: "drop", id: a.id },
    { op: "rewrite", id: a.id, text: "after drop" }, // a is already consumed
    { op: "merge", ids: [a.id, b.id], text: "merge with a consumed member" },
    { op: "rewrite", id: b.id, text: "plays Celeste a lot" },
  ] }));
  await t.pass();
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.text), ["plays Celeste a lot"]);
});

// @spec MEM-CONSOL-005
test("the rules fallback proposes no operations", () => {
  assert.deepEqual(consolidatorImpl.rules({ viewer: "amy", notes: [], suppressionReasons: [] }), { ops: [] });
});

const sample: ConsolidatorInput = {
  viewer: "amy",
  suppressionReasons: [],
  notes: [
    { id: 1, layer: "recent", category: "general", text: "plays Hades", hint: null, strength: 1, mentions: 1 },
    { id: 2, layer: "recent", category: "general", text: "likes Hades", hint: null, strength: 1, mentions: 1 },
    { id: 3, layer: "core", category: "health", text: "has asthma", hint: "never quote", strength: 1, mentions: 1 },
  ],
};
const validate = (raw: unknown) => consolidatorImpl.llm!.validate(raw, sample);

// @spec MEM-CONSOL-005
test("the consolidator answer accepts merge, rewrite and drop and discards anything else", () => {
  const out = validate({ ops: [
    { op: "merge", ids: [1, 2], text: "loves Hades" },
    { op: "rewrite", id: 3, hint: "ask gently" },
    { op: "drop", id: 2 },
    { op: "merge", ids: [1], text: "only one member" },
    { op: "merge", ids: [1, 1], text: "same member twice" },
    { op: "merge", ids: [1, 9], text: "unknown member" },
    { op: "merge", ids: [1, 2], text: "" },
    { op: "rewrite", id: 9, text: "unknown" },
    { op: "rewrite", id: 1 }, // nothing to change
    { op: "rewrite", id: 1, text: "x".repeat(121) },
    { op: "rewrite", id: 1, hint: "x".repeat(81) },
    { op: "rewrite", id: 1, category: "politics" },
    { op: "rewrite", id: 1, category: "money", text: "earns a lot" },
    { op: "merge", ids: [1, 2], text: "ok", category: "finance" },
    { op: "drop", id: "1" },
    { op: "explode", id: 1 },
    "nonsense",
    null,
  ] });
  assert.deepEqual(out, { ops: [
    { op: "merge", ids: [1, 2], text: "loves Hades" },
    { op: "rewrite", id: 3, hint: "ask gently" },
    { op: "drop", id: 2 },
  ] });
  assert.deepEqual(validate({ ops: [] }), { ops: [] });
  assert.deepEqual(validate([{ op: "drop", id: 1 }]), { ops: [{ op: "drop", id: 1 }] }, "a bare array of operations is accepted");
  assert.equal(validate({ nothing: true }), undefined);
  assert.equal(validate("text"), undefined);
});

// @spec MEM-CONSOL-005, MEM-NOTE-009
test("the consolidator prompt forbids politics and money and carries the notes and reasons", () => {
  const llm = consolidatorImpl.llm!;
  assert.match(llm.system, /politic/i);
  assert.match(llm.system, /money|wealth|spending/i);
  const user = llm.user({ ...sample, suppressionReasons: ["no spending talk"] });
  assert.match(user, /amy/);
  assert.match(user, /\b1\b.*plays Hades/);
  assert.match(user, /no spending talk/);
});

// @spec MEM-CONSOL-005
test("a consolidator hook configured as rules proposes nothing, and a pass still does the arithmetic", async () => {
  const t = setup();
  const hook = createConsolidatorHook(testConfig(), recordingLog().log);
  assert.equal(hook.kind, "rules");
  assert.deepEqual(await hook.run(sample), { ops: [] });
  const k = await t.viewer("amy");
  await t.note(k, "plays Hades", { mentions: 3 });
  await t.pass({ hook });
  assert.equal((await t.store.listNotes(k))[0]!.layer, "core");
});

// @spec MEM-NOTE-011
test("notes hooks run on local ollama unless the hook names a provider; mock is inherited", () => {
  const llm = (provider: string) => testConfig({ llm: { provider, model: "m" } }).llm;
  const hook = (over: Record<string, unknown> = {}) => testConfig({ brain: { memory: { notes: { consolidator: { kind: "llm", ...over } } } } }).brain.memory.notes.consolidator;
  assert.equal(notesHookLlm(llm("anthropic"), hook()).provider, "ollama", "a hosted cortex model does not carry notes off the LAN");
  assert.equal(notesHookLlm(llm("openai"), hook()).provider, "ollama");
  assert.equal(notesHookLlm(llm("bedrock"), hook()).provider, "ollama");
  assert.equal(notesHookLlm(llm("ollama"), hook()).provider, "ollama");
  assert.equal(notesHookLlm(llm("mock"), hook()).provider, "mock", "the isolation preset still reaches the hooks");
  assert.equal(notesHookLlm(llm("anthropic"), hook({ llm: { provider: "openai", model: "gpt" } })).provider, "anthropic", "the hook's own provider is applied by the Module, not overridden here");
  assert.equal(notesHookLlm(llm("anthropic"), hook()).model, "m", "the model is still inherited");
});

// @spec MEM-NOTE-011
test("the consolidator hook builds an ollama provider under a hosted cortex, and a hook-named provider wins", () => {
  const cfg = (provider: string, hook: Record<string, unknown> = {}) =>
    testConfig({ llm: { provider, model: "m" }, brain: { memory: { notes: { consolidator: { kind: "llm", ...hook } } } } });
  const providerOf = (c: ReturnType<typeof cfg>) => (createConsolidatorHook(c, recordingLog().log) as unknown as { provider: { name: string } }).provider.name;
  assert.equal(providerOf(cfg("ollama")), "ollama");
  assert.equal(providerOf(cfg("mock")), "mock");
  assert.equal(providerOf(cfg("anthropic")), "ollama");
  assert.equal(providerOf(cfg("anthropic", { llm: { provider: "openai", model: "gpt-x" } })), "openai");
});

// @spec MEM-CONSOL-007
test("a note reinforced while the model ran keeps its reinforcement and stays dirty; the rest of the viewer commits", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "plays Hades");
  const b = await t.note(k, "plays Celeste");
  t.answer(async () => { await t.store.reinforceNote(a.id); return { ops: [{ op: "rewrite", id: a.id, text: "rewrite from stale read" }] }; });
  await t.pass();
  const notes = await t.store.listNotes(k);
  const na = notes.find((n) => n.id === a.id)!;
  assert.deepEqual([na.text, na.dirty, na.mentions], ["plays Hades", true, 2]);
  assert.equal(notes.find((n) => n.id === b.id)!.dirty, false);
});

// @spec MEM-CONSOL-007
test("a note the owner deleted while the model ran stays deleted", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const a = await t.note(k, "plays Hades");
  const b = await t.note(k, "plays Celeste");
  t.answer(async () => {
    await t.store.deleteNote(a.id, "owner said no");
    return { ops: [{ op: "rewrite", id: a.id, text: "resurrected?" }, { op: "merge", ids: [a.id, b.id], text: "merged" }] };
  });
  await t.pass();
  // the merge named the deleted note, so it is skipped whole: b is untouched and stays dirty for the next pass
  assert.deepEqual((await t.store.listNotes(k)).map((n) => [n.text, n.dirty]), [["plays Celeste", true]]);
  assert.deepEqual((await t.store.listDeletions(k)).map((d) => d.text), ["plays Hades"]);
});

// @spec MEM-CONSOL-008
test("every processed note is marked clean, including when the hook fell back to rules", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "plays Hades");
  await t.note(k, "plays Celeste", { dirty: false });
  await t.pass(); // the stub answers with no operations, as the rules fallback does
  assert.deepEqual((await t.store.listNotes(k)).map((n) => n.dirty), [false, false]);
  assert.equal(await t.store.dirtyNoteCount(), 0);
});

// @spec MEM-CONSOL-008
test("a hook that throws is treated as proposing nothing", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "plays Hades", { mentions: 3 });
  t.answer(() => { throw new Error("model exploded"); });
  const res = await t.pass();
  assert.equal(res.status, "completed");
  const n = (await t.store.listNotes(k))[0]!;
  assert.deepEqual([n.dirty, n.layer], [false, "core"]);
});

// @spec MEM-CONSOL-010
test("a pass that cannot take the lock is skipped and logged", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "plays Hades");
  const outcome = await t.store.withConsolidationLock(async () => t.pass());
  assert.deepEqual(outcome, { ran: true, value: { status: "skipped", viewers: 0, notes: 0 } });
  assert.equal(t.calls.length, 0);
  assert.equal(await t.store.dirtyNoteCount(), 1);
  assert.ok(t.lines.some((l) => l.level === "info" || l.level === "warn"));
  assert.equal((await t.pass()).status, "completed", "and runs once the lock is free");
});

// @spec MEM-CONSOL-011
test("an error partway keeps the viewers already committed and leaves the rest dirty", async () => {
  const t = setup();
  const [a, b, c] = [await t.viewer("amy"), await t.viewer("bob"), await t.viewer("cat")];
  for (const k of [a, b, c]) await t.note(k, `note of ${k}`);
  t.answer((input) => { if (input.viewer === "bob") throw new Error("never reached: hook errors are swallowed"); return { ops: [] }; });
  const real = t.store.commitViewer.bind(t.store);
  t.store.commitViewer = async (key, ops) => { if (key === "bob") throw new Error("connection lost"); return real(key, ops); };
  await assert.rejects(t.pass(), /connection lost/);
  assert.equal((await t.store.listNotes(a))[0]!.dirty, false, "amy committed");
  assert.equal((await t.store.listNotes(b))[0]!.dirty, true);
  assert.equal((await t.store.listNotes(c))[0]!.dirty, true);
  assert.equal(await t.store.getMeta("notes.last_consolidation"), undefined, "an incomplete pass records nothing");
  t.store.commitViewer = real;
  const next = await t.pass();
  assert.deepEqual([next.status, next.viewers], ["completed", 2], "the next pass catches up");
});

// @spec MEM-CONSOL-011
test("a pass told to stop finishes the viewer in progress and leaves the rest dirty", async () => {
  const t = setup();
  const ctl = new AbortController();
  const [a, b] = [await t.viewer("amy"), await t.viewer("bob")];
  for (const k of [a, b]) await t.note(k, `note of ${k}`);
  t.answer(() => { ctl.abort(); return { ops: [] }; });
  const res = await t.pass({ signal: ctl.signal });
  assert.deepEqual(res, { status: "interrupted", viewers: 1, notes: 1 });
  assert.equal((await t.store.listNotes(a))[0]!.dirty, false);
  assert.equal((await t.store.listNotes(b))[0]!.dirty, true);
  assert.equal(await t.store.getMeta("notes.last_consolidation"), undefined);
});

// @spec MEM-CONSOL-003
test("the gate is awaited before each viewer, so a pass waits between viewers", async () => {
  const t = setup();
  const [a, b] = [await t.viewer("amy"), await t.viewer("bob")];
  for (const k of [a, b]) await t.note(k, `note of ${k}`);
  const events: string[] = [];
  t.answer((input) => { events.push(`hook:${input.viewer}`); return { ops: [] }; });
  await t.pass({ gate: async () => { events.push("gate"); } });
  assert.deepEqual(events, ["gate", "hook:amy", "gate", "hook:bob"]);
});

// @spec MEM-CONSOL-014
test("a completed pass records when it finished and how many viewers and notes it processed", async () => {
  const t = setup();
  const [a, b] = [await t.viewer("amy"), await t.viewer("bob")];
  await t.note(a, "one");
  await t.note(a, "two");
  await t.note(b, "three");
  t.advance(5000);
  await t.pass();
  const rec = JSON.parse((await t.store.getMeta("notes.last_consolidation"))!);
  assert.deepEqual(rec, { at: new Date(t.now()).toISOString(), viewers: 2, notes: 3 });
});

// @spec MEM-CONSOL-014
test("a pass with nothing dirty still completes and records zero", async () => {
  const t = setup();
  const res = await t.pass();
  assert.deepEqual(res, { status: "completed", viewers: 0, notes: 0 });
  assert.equal(JSON.parse((await t.store.getMeta("notes.last_consolidation"))!).viewers, 0);
});

// @spec MEM-CONSOL-016
test("a completed pass purges deletions without a reason older than the retention, and keeps reasons", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  const del = async (text: string, reason?: string) => t.store.deleteNote((await t.note(k, text, { dirty: false })).id, reason);
  await del("old soft");
  await del("old with reason", "keep my rule");
  t.advance(31 * DAY);
  await del("fresh soft");
  await t.pass();
  assert.deepEqual((await t.store.listDeletions(k)).map((d) => d.text), ["old with reason", "fresh soft"]);
});

// @spec MEM-CONSOL-016
test("deleted_retention_days comes from config", async () => {
  const t = setup({ notes: { deleted_retention_days: 2 } });
  const k = await t.viewer("amy");
  await t.store.deleteNote((await t.note(k, "soft", { dirty: false })).id);
  t.advance(3 * DAY);
  await t.pass();
  assert.deepEqual(await t.store.listDeletions(k), []);
});

// @spec MEM-CONSOL-004
test("a viewer whose notes were all cleaned meanwhile is not processed", async () => {
  const t = setup();
  const k = await t.viewer("amy");
  await t.note(k, "plays Hades", { dirty: false });
  await t.note(k, "plays Celeste");
  const real = t.store.dirtyViewerKeys.bind(t.store);
  t.store.dirtyViewerKeys = async () => { const keys = await real(); for (const n of await t.store.listNotes(k)) await t.store.commitViewer(k, [{ kind: "clean", id: n.id, version: n.version }]); return keys; };
  const res = await t.pass();
  assert.equal(res.notes, 0);
  assert.equal(t.calls.length, 0);
});

// @spec MEM-NOTE-009, MEM-CONSOL-005
test("a consolidator operation whose text or hint is about politics, money or subscriber status is discarded", async () => {
  const { validateOp } = await import("../src/consolidator.js");
  const ids = new Set([1, 2]);
  assert.deepEqual(validateOp({ op: "rewrite", id: 1, text: "plays Hades" }, ids), { op: "rewrite", id: 1, text: "plays Hades" });
  assert.equal(validateOp({ op: "rewrite", id: 1, text: "voted for Trump" }, ids), undefined);
  assert.equal(validateOp({ op: "rewrite", id: 1, text: "plays Hades", hint: "mention their salary" }, ids), undefined);
  assert.equal(validateOp({ op: "merge", ids: [1, 2], text: "makes $100k a year" }, ids), undefined);
  assert.equal(validateOp({ op: "merge", ids: [1, 2], text: "is a tier 2 sub" }, ids), undefined);
  assert.deepEqual(validateOp({ op: "drop", id: 2 }, ids), { op: "drop", id: 2 });
});
