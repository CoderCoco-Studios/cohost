/**
 * Behaviour both memory stores must share for viewers and notes (MEM-BACKEND-005: "the same behaviour as the Postgres store").
 * Run against the in-process store always (notes-store.test.ts) and against a real Postgres with pgvector
 * when COHOST_TEST_DATABASE_URL is set (notes-store.pg.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MemoryBackend } from "../src/store.js";

export const DAY = 86_400_000;
export const T0 = new Date("2026-03-01T12:00:00Z").getTime();

export interface Harness {
  store: MemoryBackend;
  /** Move the store's clock (and the caller's) forward. */
  advance(ms: number): void;
  now(): number;
}

/** Fresh viewer key per test, so a shared database needs no cleanup. */
export const uid = (name = "viewer"): string => `${name}-${randomUUID().slice(0, 8)}`;

export function registerStoreContract(label: string, make: () => Promise<Harness>, opts: { regular_messages: number }): void {
  const t = (name: string, fn: (h: Harness) => Promise<void>) => test(`${label}: ${name}`, async () => fn(await make()));

  // @spec MEM-REG-001, MEM-VIEWER-001
  t("regular is the owner's flag or a lifetime message count above regular_messages; counts never reset", async ({ store }) => {
    const key = uid();
    let last = await store.touchViewer(key, "Bob");
    assert.deepEqual([last.msgCount, last.isNew, last.regular], [1, true, false]);
    for (let i = 2; i <= opts.regular_messages; i++) last = await store.touchViewer(key, "Bob");
    assert.equal(last.regular, false, "exactly regular_messages is not above it");
    last = await store.touchViewer(key, "Bob");
    assert.deepEqual([last.msgCount, last.isNew, last.regular], [opts.regular_messages + 1, false, true]);
    const flagged = uid();
    assert.equal((await store.touchViewer(flagged, "Amy")).regular, false);
    assert.equal((await store.setRegular(flagged, true))?.regular, true);
    assert.equal((await store.touchViewer(flagged, "Amy")).regular, true);
    assert.equal((await store.setRegular(flagged, false))?.regular, false, "clearing returns to the count rule");
    assert.equal((await store.getViewer(flagged))!.msgCount, 2);
  });

  // @spec MEM-REG-005
  t("the subscriber flag follows the latest message and is stored only", async ({ store }) => {
    const key = uid();
    await store.touchViewer(key, "Bob", { isSub: true });
    assert.equal((await store.getViewer(key))!.isSub, true);
    await store.touchViewer(key, "Bob", { isSub: false });
    assert.equal((await store.getViewer(key))!.isSub, false);
    await store.touchViewer(key, "Bob");
    assert.equal((await store.getViewer(key))!.isSub, false);
  });

  // @spec MEM-REG-003
  t("the regular flag on an unknown name creates a placeholder with msg_count 0; on a known name or key it does not", async ({ store }) => {
    const name = `Newcomer${uid("")}`;
    const row = await store.setRegular(name, true);
    assert.deepEqual(
      [row!.key, row!.display, row!.msgCount, row!.regularManual, row!.placeholder, row!.regular],
      [name.toLowerCase(), name, 0, true, true, true],
    );
    assert.equal(await store.setRegular(`Ghost${uid("")}`, false), undefined, "clearing an unknown name makes no row");
    const key = uid();
    await store.touchViewer(key, `Display${key}`);
    const byName = await store.setRegular(`DISPLAY${key}`.toUpperCase(), true);
    assert.equal(byName!.key, key, "found by case-insensitive display name");
    assert.equal(byName!.placeholder, false);
    assert.equal((await store.setRegular(key.toUpperCase(), true))!.key, key, "found by key");
  });

  // @spec MEM-REG-004, MEM-REG-003
  t("the first chat line of a placeholder's name re-keys it, keeping flag and notes, and counts the message", async ({ store }) => {
    const name = `Pat${uid("")}`;
    await store.setRegular(name, true);
    const placeholderKey = name.toLowerCase();
    const note = await store.insertNote({ userKey: placeholderKey, category: "general", text: "streams on tuesdays" });
    const userId = `id-${uid("")}`;
    const touch = await store.touchViewer(userId, name.toUpperCase(), { isSub: true });
    assert.deepEqual([touch.msgCount, touch.isNew, touch.regular], [1, true, true]);
    assert.equal(await store.getViewer(placeholderKey), undefined, "the placeholder key is gone");
    const claimed = (await store.getViewer(userId))!;
    assert.deepEqual([claimed.display, claimed.placeholder, claimed.regularManual, claimed.isSub], [name.toUpperCase(), false, true, true]);
    assert.deepEqual((await store.listNotes(userId)).map((n) => n.id), [note.id], "notes follow the key");
    assert.deepEqual(await store.listNotes(placeholderKey), []);
    // a second viewer with the same name gets a fresh row: the placeholder is already claimed
    const other = await store.touchViewer(`id-${uid("")}`, name);
    assert.equal(other.regular, false);
  });

  // @spec MEM-REG-004
  t("a chat line from a key that already has a row never takes a placeholder", async ({ store }) => {
    const name = `Taylor${uid("")}`;
    await store.setRegular(name, true);
    const key = uid();
    await store.touchViewer(key, "someone else");
    await store.touchViewer(key, name); // display now matches the placeholder, but the key has a row
    assert.equal((await store.getViewer(name.toLowerCase()))!.placeholder, true);
  });

  // @spec MEM-NOTE-001, MEM-NOTE-004, MEM-NOTE-010
  t("a note holds layer, category, hint, strength, mentions, dirty flag and version, and defaults a sensitive hint", async ({ store, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const n = await store.insertNote({ userKey: key, category: "general", text: "  just got a Steam Deck  " });
    assert.deepEqual(
      { layer: n.layer, category: n.category, text: n.text, hint: n.hint, strength: n.strength, mentions: n.mentions, dirty: n.dirty, version: n.version, at: n.strengthAt.getTime() },
      { layer: "recent", category: "general", text: "just got a Steam Deck", hint: null, strength: 1, mentions: 1, dirty: true, version: 1, at: now() },
    );
    const h = await store.insertNote({ userKey: key, category: "health", text: "had surgery" });
    assert.equal(h.hint, "only if they bring it up; never quote it");
    const f = await store.insertNote({ userKey: key, category: "family", text: "lost a parent", hint: " be gentle " });
    assert.equal(f.hint, "be gentle");
    const clamped = await store.insertNote({ userKey: key, category: "general", text: "over", strength: 7 });
    assert.equal(clamped.strength, 1);
    assert.equal((await store.insertNote({ userKey: key, category: "general", text: "under", strength: -3 })).strength, 0);
    assert.equal((await store.listNotes(key)).length, 5);
  });

  // @spec MEM-NOTE-005, MEM-NOTE-004
  t("reinforcement lifts the effective strength by `reinforce` of the gap, restarts the clock, counts the mention and marks dirty", async ({ store, advance, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const n = await store.insertNote({ userKey: key, category: "general", text: "plays Elden Ring", dirty: false });
    advance(7 * DAY); // recent half-life: effective 0.5
    const r = (await store.reinforceNote(n.id))!;
    assert.ok(Math.abs(r.strength - 0.8) < 1e-9, `0.5 + 0.5 * 0.6, got ${r.strength}`);
    assert.deepEqual([r.mentions, r.dirty, r.version, r.strengthAt.getTime()], [2, true, 2, now()]);
    assert.equal(await store.reinforceNote(999_999_999), undefined);
  });

  // @spec MEM-NOTE-001
  t("deleting a note records it with its effective strength and the trimmed reason, none when blank", async ({ store, advance }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const a = await store.insertNote({ userKey: key, category: "general", text: "likes cats" });
    const b = await store.insertNote({ userKey: key, category: "general", text: "likes dogs" });
    advance(7 * DAY);
    assert.equal(await store.deleteNote(a.id, "  too personal "), true);
    assert.equal(await store.deleteNote(b.id, "   "), true);
    assert.equal(await store.deleteNote(a.id), false);
    const dels = await store.listDeletions(key);
    assert.deepEqual(dels.map((d) => [d.text, d.reason, d.category, d.layer]), [["likes cats", "too personal", "general", "recent"], ["likes dogs", null, "general", "recent"]]);
    assert.ok(Math.abs(dels[0]!.strength - 0.5) < 1e-9);
    assert.equal(dels[0]!.embedding.length > 0, true);
    assert.deepEqual(await store.listNotes(key), []);
  });

  // @spec MEM-CONSOL-007, MEM-CONSOL-008, MEM-NOTE-004
  t("commitViewer applies each change only while the note's version is the one read; others stay as they are", async ({ store, advance, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const [a, b, c, d, e] = [
      await store.insertNote({ userKey: key, category: "general", text: "alpha note" }),
      await store.insertNote({ userKey: key, category: "general", text: "bravo note" }),
      await store.insertNote({ userKey: key, category: "general", text: "charlie note" }),
      await store.insertNote({ userKey: key, category: "general", text: "delta note" }),
      await store.insertNote({ userKey: key, category: "general", text: "echo note" }),
    ] as const;
    await store.reinforceNote(b.id); // b moves on after the pass read it
    advance(DAY);
    await store.commitViewer(key, [
      { kind: "update", id: a.id, version: a.version, set: { layer: "core", text: "alpha rewritten", mentions: 5, strength: 0.7, strengthAt: new Date(now()) } },
      { kind: "update", id: b.id, version: b.version, set: { text: "bravo rewritten" } }, // stale
      { kind: "clean", id: c.id, version: c.version },
      { kind: "delete", id: d.id, version: d.version },
      { kind: "delete", id: 999_999, version: 1 }, // already gone
      { kind: "clean", id: e.id, version: e.version + 1 }, // stale
    ]);
    const notes = new Map((await store.listNotes(key)).map((n) => [n.id, n]));
    const na = notes.get(a.id)!;
    assert.deepEqual([na.layer, na.text, na.mentions, na.strength, na.dirty, na.version], ["core", "alpha rewritten", 5, 0.7, false, 2]);
    assert.ok(na.embedding.length > 0);
    const nb = notes.get(b.id)!;
    assert.deepEqual([nb.text, nb.dirty, nb.version], ["bravo note", true, 2], "left as reinforced, still dirty");
    assert.equal(notes.get(c.id)!.dirty, false);
    assert.equal(notes.get(c.id)!.version, 1, "a clean is not a note write");
    assert.equal(notes.has(d.id), false);
    assert.equal(notes.get(e.id)!.dirty, true);
    assert.deepEqual(await store.listDeletions(key), [], "a pass deletion writes no deletion record");
  });

  // @spec MEM-CONSOL-006
  t("an update that absorbs merged members deletes them only when every member is unchanged", async ({ store }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const [a, b, c, d] = [
      await store.insertNote({ userKey: key, category: "general", text: "one" }),
      await store.insertNote({ userKey: key, category: "general", text: "two" }),
      await store.insertNote({ userKey: key, category: "general", text: "three" }),
      await store.insertNote({ userKey: key, category: "general", text: "four" }),
    ] as const;
    await store.reinforceNote(d.id);
    await store.commitViewer(key, [
      { kind: "update", id: a.id, version: a.version, set: { text: "one and two" }, absorb: [{ id: b.id, version: b.version }] },
      { kind: "update", id: c.id, version: c.version, set: { text: "three and four" }, absorb: [{ id: d.id, version: d.version }] }, // d is stale
    ]);
    const texts = (await store.listNotes(key)).map((n) => n.text);
    assert.deepEqual(texts, ["one and two", "three", "four"]);
  });

  // @spec MEM-NOTE-010
  t("a rewrite into health or family gets the category's default hint", async ({ store }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const n = await store.insertNote({ userKey: key, category: "general", text: "has a cold" });
    await store.commitViewer(key, [{ kind: "update", id: n.id, version: n.version, set: { category: "health" } }]);
    assert.equal((await store.listNotes(key))[0]!.hint, "only if they bring it up; never quote it");
  });

  // @spec MEM-CONSOL-001, MEM-CONSOL-004
  t("dirty notes are counted and their viewers listed", async ({ store }) => {
    const before = await store.dirtyNoteCount();
    const k1 = uid("a"), k2 = uid("b"), k3 = uid("c");
    for (const k of [k1, k2, k3]) await store.touchViewer(k, k);
    await store.insertNote({ userKey: k1, category: "general", text: "one" });
    await store.insertNote({ userKey: k1, category: "general", text: "two" });
    await store.insertNote({ userKey: k2, category: "general", text: "three" });
    await store.insertNote({ userKey: k3, category: "general", text: "four", dirty: false });
    assert.equal(await store.dirtyNoteCount(), before + 3);
    const keys = await store.dirtyViewerKeys();
    assert.ok(keys.includes(k1) && keys.includes(k2) && !keys.includes(k3));
  });

  // @spec MEM-CONSOL-016
  t("purging keeps deletions with a reason and recent soft deletions", async ({ store, advance, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const mk = async (text: string, reason?: string) => (await store.deleteNote((await store.insertNote({ userKey: key, category: "general", text })).id, reason));
    await mk("old soft");
    await mk("old with reason", "do not store this");
    advance(40 * DAY);
    await mk("recent soft");
    const purged = await store.purgeSoftDeletions(new Date(now() - 30 * DAY));
    assert.equal(purged >= 1, true);
    assert.deepEqual((await store.listDeletions(key)).map((d) => d.text), ["old with reason", "recent soft"]);
  });

  // @spec MEM-CONSOL-010
  t("only one holder of the consolidation lock at a time", async ({ store }) => {
    let inner: unknown;
    const outer = await store.withConsolidationLock(async () => {
      inner = await store.withConsolidationLock(async () => "never");
      return "outer";
    });
    assert.deepEqual(outer, { ran: true, value: "outer" });
    assert.deepEqual(inner, { ran: false });
    assert.deepEqual(await store.withConsolidationLock(async () => 1), { ran: true, value: 1 }, "released afterwards");
    await assert.rejects(store.withConsolidationLock(async () => { throw new Error("boom"); }), /boom/);
    assert.deepEqual(await store.withConsolidationLock(async () => 2), { ran: true, value: 2 }, "released after a throw");
  });

  // @spec MEM-ADMIN-001
  t("listViewers orders by last seen, filters by a case-insensitive display substring, counts stored notes and honours the limit", async ({ store, advance }) => {
    const tag = uid("tag").replace(/-/g, "");
    const [a, b, c] = [uid("a"), uid("b"), uid("c")];
    await store.touchViewer(a, `Alice${tag}`); advance(1000);
    await store.touchViewer(b, `bob${tag}`); advance(1000);
    await store.touchViewer(c, `Carol${tag}`); advance(1000);
    await store.touchViewer(a, `Alice${tag}`); advance(1000); // a is now the most recently seen
    await store.insertNote({ userKey: a, category: "general", text: "one" });
    await store.insertNote({ userKey: a, category: "general", text: "two" });
    await store.setRegular(c, true);
    const all = await store.listViewers({ query: tag.toUpperCase() });
    assert.deepEqual(all.map((v) => v.key), [a, c, b]);
    assert.deepEqual(all.map((v) => [v.noteCount, v.msgCount, v.regularManual]), [[2, 2, false], [0, 1, true], [0, 1, false]]);
    assert.deepEqual((await store.listViewers({ query: `ALICE${tag}` })).map((v) => v.key), [a]);
    assert.deepEqual((await store.listViewers({ query: `zzz${tag}` })), []);
    assert.deepEqual((await store.listViewers({ query: tag, limit: 2 })).map((v) => v.key), [a, c]);
    assert.equal((await store.listViewers({ query: "%" })).length, 0, "LIKE wildcards in the query are literal");
  });

  // @spec MEM-ADMIN-004, MEM-NOTE-004
  t("restoreDeletion recreates the note at its recorded strength from now, clean, and removes the record", async ({ store, advance, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const original = await store.insertNote({ userKey: key, layer: "core", category: "health", text: "has a cold", hint: "ask gently" });
    advance(10 * DAY);
    assert.equal(await store.deleteNote(original.id, "private"), true);
    const [record] = await store.listDeletions(key);
    assert.ok(record!.strength < 1 && record!.strength > 0);
    advance(DAY);
    const restored = (await store.restoreDeletion(record!.id))!;
    assert.notEqual(restored.id, original.id, "ids are never reused, so a stale consolidation commit cannot touch it");
    assert.deepEqual(
      [restored.userKey, restored.layer, restored.category, restored.text, restored.hint, restored.dirty, restored.version, restored.strengthAt.getTime()],
      [key, "core", "health", "has a cold", "ask gently", false, 1, now()],
    );
    assert.ok(Math.abs(restored.strength - record!.strength) < 1e-9);
    assert.equal(restored.embedding.length, original.embedding.length);
    assert.deepEqual((await store.listNotes(key)).map((n) => n.id), [restored.id]);
    assert.deepEqual(await store.listDeletions(key), [], "the record, and any suppression it carried, is gone");
    assert.equal(await store.restoreDeletion(record!.id), undefined, "a second restore finds nothing");
    assert.equal(await store.restoreDeletion(987_654_321), undefined);
  });

  // @spec MEM-ADMIN-005
  t("clearNotes deletes every note of one viewer into restorable records with one reason and leaves the viewer untouched", async ({ store }) => {
    const key = uid(), other = uid("other");
    await store.touchViewer(key, "Bob");
    await store.touchViewer(other, "Amy");
    await store.setRegular(key, true);
    for (const text of ["one", "two", "three"]) await store.insertNote({ userKey: key, category: "general", text });
    const kept = await store.insertNote({ userKey: other, category: "general", text: "untouched" });
    assert.equal(await store.clearNotes(key, "  not for stream  "), 3);
    assert.deepEqual(await store.listNotes(key), []);
    assert.deepEqual((await store.listDeletions(key)).map((d) => [d.text, d.reason]), [["one", "not for stream"], ["two", "not for stream"], ["three", "not for stream"]]);
    const v = (await store.getViewer(key))!;
    assert.deepEqual([v.regularManual, v.msgCount], [true, 1]);
    assert.deepEqual((await store.listNotes(other)).map((n) => n.id), [kept.id]);
    assert.equal(await store.clearNotes(key), 0, "nothing left to clear");
    await store.insertNote({ userKey: key, category: "general", text: "again" });
    assert.equal(await store.clearNotes(key, "   "), 1);
    assert.equal((await store.listDeletions(key)).at(-1)!.reason, null, "a blank reason stores none");
  });
}
