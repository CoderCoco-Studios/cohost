/**
 * Behaviour both memory stores must share for viewers and notes (MEM-BACKEND-005: "the same behaviour as the Postgres store").
 * Run against the in-process store always (notes-store.test.ts) and against a real Postgres with pgvector
 * when COHOST_TEST_DATABASE_URL is set (notes-store.pg.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { MemoryBackend } from "../src/store.js";
import { cosine } from "../src/notes.js";

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

  // @spec MEM-CAPTURE-011, MEM-VIEWER-001
  t("ensureViewer creates a missing row with msg_count 0 and leaves an existing row alone; the next chat line counts as the first", async ({ store }) => {
    const key = uid();
    const made = await store.ensureViewer(key.toUpperCase(), "Bob");
    assert.deepEqual([made.key, made.display, made.msgCount, made.placeholder, made.regular], [key, "Bob", 0, false, false]);
    await store.ensureViewer(key, "Other");
    const same = (await store.getViewer(key))!;
    assert.deepEqual([same.display, same.msgCount], ["Bob", 0], "an existing row is untouched");
    const touch = await store.touchViewer(key, "Bob");
    assert.deepEqual([touch.msgCount, touch.isNew], [1, true]);
    await store.ensureViewer(key, "Bob");
    assert.equal((await store.getViewer(key))!.msgCount, 1, "an existing counted row keeps its count");
  });

  // @spec MEM-CAPTURE-011, MEM-REG-004
  t("ensureViewer claims a matching placeholder without counting a message, keeping the flag and notes", async ({ store }) => {
    const name = `Quinn${uid("")}`;
    await store.setRegular(name, true);
    const note = await store.insertNote({ userKey: name.toLowerCase(), category: "general", text: "streams on fridays" });
    const userId = `id-${uid("")}`;
    const row = await store.ensureViewer(userId, name.toUpperCase());
    assert.deepEqual([row.key, row.msgCount, row.placeholder, row.regularManual], [userId, 0, false, true]);
    assert.equal(await store.getViewer(name.toLowerCase()), undefined);
    assert.deepEqual((await store.listNotes(userId)).map((n) => n.id), [note.id]);
    const touch = await store.touchViewer(userId, name);
    assert.deepEqual([touch.msgCount, touch.isNew, touch.regular], [1, true, true]);
  });

  // @spec MEM-CAPTURE-005, MEM-CAPTURE-006
  t("embedText embeds with the store's own embedder, so a note's embedding is comparable and insertNote can reuse it", async ({ store }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const a = await store.embedText("plays Elden Ring every night");
    const b = await store.embedText("plays Elden Ring every night");
    assert.ok(a.length > 0);
    assert.equal(cosine(a, b) > 0.999, true);
    const n = await store.insertNote({ userKey: key, category: "general", text: "plays Elden Ring every night", embedding: a });
    assert.ok(cosine(n.embedding, a) > 0.999, "the supplied embedding is stored");
    const [stored] = await store.listNotes(key);
    assert.ok(cosine(stored!.embedding, a) > 0.999);
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
  // @spec MEM-SURF-002
  t("a viewer is found by display name, case-insensitively, the most recently seen when several share it", async ({ store, advance }) => {
    const name = `Shared${uid("")}`;
    const first = uid("first");
    const second = uid("second");
    await store.touchViewer(first, name);
    advance(1000);
    await store.touchViewer(second, name.toUpperCase());
    assert.equal((await store.findViewerByDisplay(name.toLowerCase()))!.key, second, "latest last_seen wins");
    advance(1000);
    await store.touchViewer(first, name);
    assert.equal((await store.findViewerByDisplay(name))!.key, first);
    assert.equal(await store.findViewerByDisplay(`Nobody${uid("")}`), undefined);
    const renamed = uid("renamed");
    await store.touchViewer(renamed, `Old${renamed}`);
    await store.touchViewer(renamed, `New${renamed}`);
    assert.equal(await store.findViewerByDisplay(`Old${renamed}`), undefined, "lookups use the current display");
    assert.equal((await store.findViewerByDisplay(`new${renamed}`))!.key, renamed);
  });

  // @spec MEM-SURF-004
  t("markSurfaced records the time on the named notes only", async ({ store, now }) => {
    const key = uid();
    await store.touchViewer(key, "Bob");
    const a = await store.insertNote({ userKey: key, category: "health", text: "has a cold" });
    const b = await store.insertNote({ userKey: key, category: "general", text: "plays celeste" });
    assert.equal(a.lastSurfacedAt, null);
    const at = new Date(now() + 5000);
    await store.markSurfaced([a.id], at);
    await store.markSurfaced([], at);
    const notes = new Map((await store.listNotes(key)).map((n) => [n.id, n]));
    assert.equal(notes.get(a.id)!.lastSurfacedAt!.getTime(), at.getTime());
    assert.equal(notes.get(b.id)!.lastSurfacedAt, null);
    assert.equal(notes.get(a.id)!.version, a.version, "surfacing is not a content change: the version stays");
    assert.equal(notes.get(a.id)!.dirty, a.dirty);
  });
}
