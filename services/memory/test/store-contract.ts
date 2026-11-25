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
import { viewerKey } from "@cohost/shared/untrusted";
import { testConfig } from "@cohost/testing";
import { buildNotesReply } from "../src/surface.js";

export const DAY = 86_400_000;
export const T0 = new Date("2026-03-01T12:00:00Z").getTime();

/** A stored memory row as the store holds it, read directly rather than through `recall` (which skips rows younger than two minutes on the database clock). */
export interface StoredRow { kind: string; text: string; platform?: string; userId?: string; messageId?: string }

export interface Harness {
  store: MemoryBackend;
  /** The stored rows whose text contains `text`, read from the backing store (no recency cutoff, no similarity filter). */
  memories(text: string): Promise<StoredRow[]>;
  /** Move the store's clock (and the caller's) forward. */
  advance(ms: number): void;
  now(): number;
}

/** Fresh viewer key per test, so a shared database needs no cleanup. */
export const uid = (name = "viewer"): string => `${name}-${randomUUID().slice(0, 8)}`;
/** A fresh chat viewer key in the `viewerKey` format (MEM-VIEWER-008): `twitch:id:<unique id>`. */
export const vkey = (name = "viewer"): string => viewerKey({ platform: "twitch", userId: uid(name) });

export function registerStoreContract(label: string, make: () => Promise<Harness>, opts: { regular_messages: number }): void {
  const t = (name: string, fn: (h: Harness) => Promise<void>) => test(`${label}: ${name}`, async () => fn(await make()));

  // @spec MEM-REG-001, MEM-VIEWER-001
  t("regular is the owner's flag or a lifetime message count above regular_messages; counts never reset", async ({ store }) => {
    const key = vkey();
    let last = await store.touchViewer(key, "Bob");
    assert.deepEqual([last.msgCount, last.isNew, last.regular], [1, true, false]);
    for (let i = 2; i <= opts.regular_messages; i++) last = await store.touchViewer(key, "Bob");
    assert.equal(last.regular, false, "exactly regular_messages is not above it");
    last = await store.touchViewer(key, "Bob");
    assert.deepEqual([last.msgCount, last.isNew, last.regular], [opts.regular_messages + 1, false, true]);
    const flagged = vkey();
    assert.equal((await store.touchViewer(flagged, "Amy")).regular, false);
    assert.equal((await store.setRegular(flagged, true))?.regular, true);
    assert.equal((await store.touchViewer(flagged, "Amy")).regular, true);
    assert.equal((await store.setRegular(flagged, false))?.regular, false, "clearing returns to the count rule");
    assert.equal((await store.getViewer(flagged))!.msgCount, 2);
  });

  // @spec MEM-REG-005
  t("the subscriber flag follows the latest message and is stored only", async ({ store }) => {
    const key = vkey();
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
    const key = vkey();
    const shown = `Display${uid("")}`;
    await store.touchViewer(key, shown);
    const byName = await store.setRegular(shown.toUpperCase(), true);
    assert.equal(byName!.key, key, "found by case-insensitive display name");
    assert.equal(byName!.placeholder, false);
    assert.equal((await store.setRegular(key, true))!.key, key, "found by key as written");
  });

  // @spec MEM-REG-004, MEM-REG-003
  t("the first chat line of a placeholder's name re-keys it, keeping flag and notes, and counts the message", async ({ store }) => {
    const name = `Pat${uid("")}`;
    await store.setRegular(name, true);
    const placeholderKey = name.toLowerCase();
    const note = await store.insertNote({ userKey: placeholderKey, category: "general", text: "streams on tuesdays" });
    const userId = vkey();
    const touch = await store.touchViewer(userId, name.toUpperCase(), { isSub: true });
    assert.deepEqual([touch.msgCount, touch.isNew, touch.regular], [1, true, true]);
    assert.equal(await store.getViewer(placeholderKey), undefined, "the placeholder key is gone");
    const claimed = (await store.getViewer(userId))!;
    assert.deepEqual([claimed.display, claimed.placeholder, claimed.regularManual, claimed.isSub], [name.toUpperCase(), false, true, true]);
    assert.deepEqual((await store.listNotes(userId)).map((n) => n.id), [note.id], "notes follow the key");
    assert.deepEqual(await store.listNotes(placeholderKey), []);
    // a second viewer with the same name gets a fresh row: the placeholder is already claimed
    const other = await store.touchViewer(vkey(), name);
    assert.equal(other.regular, false);
  });

  // @spec MEM-REG-004
  t("a chat line from a key that already has a row never takes a placeholder", async ({ store }) => {
    const name = `Taylor${uid("")}`;
    await store.setRegular(name, true);
    const key = vkey();
    await store.touchViewer(key, "someone else");
    await store.touchViewer(key, name); // display now matches the placeholder, but the key has a row
    assert.equal((await store.getViewer(name.toLowerCase()))!.placeholder, true);
  });

  // @spec MEM-NOTE-001, MEM-NOTE-004, MEM-NOTE-010
  t("a note holds layer, category, hint, strength, mentions, dirty flag and version, and defaults a sensitive hint", async ({ store, now }) => {
    const key = vkey();
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
    const key = vkey();
    const made = await store.ensureViewer(key, "Bob");
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
    const userId = vkey();
    const row = await store.ensureViewer(userId, name.toUpperCase());
    assert.deepEqual([row.key, row.msgCount, row.placeholder, row.regularManual], [userId, 0, false, true]);
    assert.equal(await store.getViewer(name.toLowerCase()), undefined);
    assert.deepEqual((await store.listNotes(userId)).map((n) => n.id), [note.id]);
    const touch = await store.touchViewer(userId, name);
    assert.deepEqual([touch.msgCount, touch.isNew, touch.regular], [1, true, true]);
  });

  // @spec MEM-CAPTURE-005, MEM-CAPTURE-006
  t("embedText embeds with the store's own embedder, so a note's embedding is comparable and insertNote can reuse it", async ({ store }) => {
    const key = vkey();
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
    const key = vkey();
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
    const key = vkey();
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
    const key = vkey();
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
    const key = vkey();
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
    const key = vkey();
    await store.touchViewer(key, "Bob");
    const n = await store.insertNote({ userKey: key, category: "general", text: "has a cold" });
    await store.commitViewer(key, [{ kind: "update", id: n.id, version: n.version, set: { category: "health" } }]);
    assert.equal((await store.listNotes(key))[0]!.hint, "only if they bring it up; never quote it");
  });

  // @spec MEM-CONSOL-001, MEM-CONSOL-004
  t("dirty notes are counted and their viewers listed", async ({ store }) => {
    const before = await store.dirtyNoteCount();
    const k1 = vkey("a"), k2 = vkey("b"), k3 = vkey("c");
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
    const key = vkey();
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
    const [a, b, c] = [vkey("a"), vkey("b"), vkey("c")];
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
    const key = vkey();
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
    const key = vkey(), other = vkey("other");
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

  // @spec MEM-SURF-002, MEM-SURF-006
  t("a name-keyed viewer is found by display name, case-insensitively, the most recently seen when several share it", async ({ store, advance }) => {
    const name = `Shared${uid("")}`;
    const first = viewerKey({ platform: "twitch", user: name });
    const second = viewerKey({ platform: "youtube", user: name });
    await store.touchViewer(first, name);
    advance(1000);
    await store.touchViewer(second, name.toUpperCase());
    assert.equal((await store.findNameKeyedViewerByDisplay(name.toLowerCase()))!.key, second, "latest last_seen wins");
    advance(1000);
    await store.touchViewer(first, name);
    assert.equal((await store.findNameKeyedViewerByDisplay(name))!.key, first);
    assert.equal(await store.findNameKeyedViewerByDisplay(`Nobody${uid("")}`), undefined);
    const user = `Ren${uid("")}`;
    const renamed = viewerKey({ platform: "twitch", user });
    await store.touchViewer(renamed, `Old${user}`);
    await store.touchViewer(renamed, `New${user}`);
    assert.equal(await store.findNameKeyedViewerByDisplay(`Old${user}`), undefined, "lookups use the current display");
    assert.equal((await store.findNameKeyedViewerByDisplay(`new${user}`))!.key, renamed);
  });

  // @spec MEM-STORE-003, MEM-BACKEND-006, MEM-REFLECT-008
  t("recentSince lists memories strictly after a (ts, id) cursor in (ts, id) order, whatever the cursor's timestamp precision", async ({ store }) => {
    const tag = uid("cursor");
    for (const x of ["a", "b", "c"]) await store.remember("chat", "bob", `${tag} ${x}`);
    const epoch = { ts: "1970-01-01T00:00:00.000Z", id: 0 };
    const mine = async (after: { ts: string; id: number }) => (await store.recentSince(after, 1_000_000)).filter((m) => m.text.startsWith(tag));
    const all = await mine(epoch);
    assert.deepEqual(all.map((m) => m.text.slice(-1)), ["a", "b", "c"]);
    const cursorOf = (m: (typeof all)[number]) => ({ ts: m.tsText ?? m.ts.toISOString(), id: Number(m.id) });
    assert.deepEqual((await mine(cursorOf(all[0]!))).map((m) => m.text.slice(-1)), ["b", "c"], "the cursor row itself is not read again");
    assert.deepEqual(await mine(cursorOf(all[2]!)), []);
    assert.equal((await store.recentSince(epoch, 2)).length, 2, "the limit caps the page");
  });

  // @spec MEM-SURF-004
  t("markSurfaced records the time on the named notes only", async ({ store, now }) => {
    const key = vkey();
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

  // @spec MEM-VOICE-001
  t("an unlinked speaker is a voice viewer keyed discord:<id>: created with no messages, display follows, never counted or placeholder-claimed", async ({ store, advance }) => {
    const id = uid("d").replace(/-/g, "");
    const name = `Vox${id}`;
    await store.setRegular(name, true); // an owner placeholder with the same display name
    const first = await store.touchSpeaker(id, name);
    assert.deepEqual([first.key, first.display, first.msgCount, first.regularManual, first.regular], [`discord:${id}`, name, 0, false, false]);
    assert.equal((await store.getViewer(name.toLowerCase()))!.placeholder, true, "the placeholder is left for chat to claim");
    advance(1000);
    const again = await store.touchSpeaker(id, `${name} v2`);
    assert.deepEqual([again.key, again.display, again.msgCount], [`discord:${id}`, `${name} v2`, 0]);
    assert.ok(again.lastSeen.getTime() > first.lastSeen.getTime(), "last_seen refreshed");
  });

  // @spec MEM-VOICE-005, MEM-VOICE-004, MEM-VOICE-001
  t("linking moves the voice viewer's notes and deletions (dirty) to the chat viewer and later speech follows the link", async ({ store }) => {
    const id = uid("d").replace(/-/g, "");
    const chat = vkey("chat");
    await store.touchViewer(chat, "BobChat");
    await store.touchSpeaker(id, "bob_voice");
    const voice = `discord:${id}`;
    const kept = await store.insertNote({ userKey: voice, category: "general", text: "plays celeste", dirty: false });
    const gone = await store.insertNote({ userKey: voice, category: "general", text: "likes tea" });
    await store.deleteNote(gone.id, "private");
    const out = await store.linkDiscord(id, chat);
    assert.equal(out!.viewer.key, chat);
    assert.equal(out!.moved, 1);
    assert.equal(await store.getViewer(voice), undefined, "the voice row is removed");
    const notes = await store.listNotes(chat);
    assert.deepEqual(notes.map((n) => [n.id, n.dirty]), [[kept.id, true]]);
    assert.equal((await store.listDeletions(chat)).length, 1);
    const after = await store.touchSpeaker(id, "bob_voice_renamed");
    assert.deepEqual([after.key, after.display, after.msgCount], [chat, "BobChat", 1], "display and count stay the chat viewer's");
    assert.equal(await store.getViewer(voice), undefined);
    assert.deepEqual((await store.listLinks(chat)).map((l) => [l.discordId, l.discordDisplay]), [[id, "bob_voice_renamed"]]);
  });

  // @spec MEM-VOICE-005
  t("linking resolves the target by key or display name, replaces an earlier link, and refuses a missing or voice target", async ({ store }) => {
    const id = uid("d").replace(/-/g, "");
    const a = vkey("a"), b = vkey("b");
    await store.touchViewer(a, `Ann${id}`);
    await store.touchViewer(b, `Ben${id}`);
    assert.equal((await store.linkDiscord(id, `ann${id}`))!.viewer.key, a, "by display name");
    assert.equal((await store.linkDiscord(id, b))!.viewer.key, b, "relinking replaces");
    assert.deepEqual(await store.listLinks(a), []);
    assert.equal((await store.touchSpeaker(id, "x")).key, b);
    assert.equal(await store.linkDiscord(id, `nobody-${id}`), undefined);
    await store.touchSpeaker(`other${id}`, "o");
    assert.equal(await store.linkDiscord(id, `discord:other${id}`), undefined, "a voice viewer is not a target");
    assert.equal((await store.touchSpeaker(id, "x")).key, b, "a refused link changes nothing");
  });

  // @spec MEM-VOICE-006
  t("unlinking removes only the link: notes stay and the next utterance starts a fresh voice viewer", async ({ store }) => {
    const id = uid("d").replace(/-/g, "");
    const chat = vkey("chat");
    await store.touchViewer(chat, "Cy");
    await store.linkDiscord(id, chat);
    await store.insertNote({ userKey: chat, category: "general", text: "streams chess" });
    assert.equal(await store.unlinkDiscord(id), true);
    assert.equal(await store.unlinkDiscord(id), false);
    assert.equal((await store.listNotes(chat)).length, 1);
    const v = await store.touchSpeaker(id, "cy_voice");
    assert.equal(v.key, `discord:${id}`);
    assert.deepEqual(await store.listNotes(v.key), []);
  });

  // @spec MEM-VOICE-007, MEM-SURF-009
  t("a name matching no display never resolves through a linked id's Discord display name; a name-keyed display match still resolves", async ({ store }) => {
    const id = uid("d").replace(/-/g, "");
    const chat = viewerKey({ platform: "twitch", user: `Dee${id}` });
    await store.touchViewer(chat, `Dee${id}`);
    await store.linkDiscord(id, chat);
    await store.touchSpeaker(id, `DeeVoice${id}`);
    assert.equal(await store.findNameKeyedViewerByDisplay(`DEEVOICE${id}`), undefined, "no alias through discord_display");
    assert.equal((await store.findNameKeyedViewerByDisplay(`dee${id}`))!.key, chat);
    assert.equal(await store.findNameKeyedViewerByDisplay(`nobody${id}`), undefined);
    const other = viewerKey({ platform: "twitch", user: `DeeVoice${id}` });
    await store.touchViewer(other, `DeeVoice${id}`);
    assert.equal((await store.findNameKeyedViewerByDisplay(`DeeVoice${id}`))!.key, other, "a name-keyed viewer whose display matches is found");
    // No display lookup can return an id-keyed or voice row.
    assert.equal("findViewerByDisplay" in store, false, "the unrestricted display lookup is gone");
  });

  // @spec MEM-REG-006, MEM-SURF-006
  t("the owner's regular flag on a key-looking name creates no placeholder, so it cannot take over a voice row", async ({ store, now }) => {
    const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash" } } }).brain.memory;
    const w = uid("").replace(/-/g, "");
    for (const name of [`discord:${w}`, `Twitch:Name:${w}`, `YOUTUBE:id:${w}`]) {
      assert.equal(await store.setRegular(name, true), undefined, name);
      assert.equal(await store.getViewer(name.toLowerCase()), undefined, `${name}: no row`);
    }
    // The takeover the refusal prevents: a voice key marked regular first, then claimed by a chat viewer with the same display.
    await store.setRegular(`discord:${w}`, true);
    const voice = await store.touchSpeaker(w, `Eve${w}`);
    assert.equal(voice.placeholder, false, "an unlinked voice row is not a placeholder");
    await store.insertNote({ userKey: voice.key, category: "general", text: `eve note ${w}` });
    const chat = viewerKey({ platform: "twitch", userId: `9${w}`, user: `Eve${w}` });
    await store.touchViewer(chat, `Eve${w}`);
    assert.deepEqual((await store.listNotes(voice.key)).map((n) => n.text), [`eve note ${w}`], "the speaker's notes stay on the voice row");
    assert.deepEqual(await store.listNotes(chat), []);
    assert.deepEqual(await buildNotesReply(store, cfg, [{ user: `Eve${w}` }] as never, now()), [], "the voice row is not name-keyed");
    // A plain name still makes a placeholder (MEM-REG-003).
    assert.equal((await store.setRegular(`Plain${w}`, true))!.placeholder, true);
  });

  // @spec MEM-SURF-008, MEM-VOICE-007
  t("a notes entry with speakerId reaches only the chat viewer its id is linked to, whatever that viewer's key", async ({ store, now }) => {
    const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash" } } }).brain.memory;
    const w = uid("").replace(/-/g, "");
    const ask = (entry: Record<string, unknown>) => buildNotesReply(store, cfg, [entry] as never, now());
    const byId = viewerKey({ platform: "twitch", userId: `5${w}`, user: `Ida${w}` });
    const named = viewerKey({ platform: "twitch", user: `Nia${w}` });
    await store.touchViewer(byId, `Ida${w}`);
    await store.touchViewer(named, `Nia${w}`);
    await store.insertNote({ userKey: byId, category: "general", text: `ida ${w}` });
    await store.insertNote({ userKey: named, category: "general", text: `nia ${w}` });
    await store.linkDiscord(`I${w}`, byId);
    await store.linkDiscord(`N${w}`, named);
    await store.touchSpeaker(`I${w}`, `IdaVoice${w}`);
    await store.touchSpeaker(`N${w}`, `NiaVoice${w}`);
    const texts = async (e: Record<string, unknown>) =>
      (await ask(e)).map((v) => [v.user, (v as { speakerId?: string }).speakerId, v.notes.map((n) => n.text)]);
    assert.deepEqual(await texts({ user: `IdaVoice${w}`, speakerId: `I${w}` }), [[`Ida${w}`, `I${w}`, [`ida ${w}`]]]);
    assert.deepEqual(await texts({ user: "ignored", speakerId: `i${w}` }), [[`Ida${w}`, `i${w}`, [`ida ${w}`]]], "the id is compared lowercased");
    assert.deepEqual(await texts({ user: `NiaVoice${w}`, speakerId: `N${w}` }), [[`Nia${w}`, `N${w}`, [`nia ${w}`]]]);
    // An unlinked speaker and a refused id find nothing; other entry fields do not steer the lookup.
    await store.touchSpeaker(`U${w}`, `Unlinked${w}`);
    assert.deepEqual(await ask({ user: `Unlinked${w}`, speakerId: `U${w}` }), []);
    assert.deepEqual(await ask({ user: "x", speakerId: `id:5${w}` }), []);
    assert.deepEqual(await ask({ user: "x", speakerId: `name:nia${w}` }), []);
    assert.deepEqual(await texts({ user: `Nia${w}`, platform: "twitch", speakerId: `U${w}` }), []);
  });

  // @spec MEM-SURF-006, MEM-VOICE-007
  t("a notes entry with no platform reaches only name-keyed rows: never an id-keyed row, a voice row or a link alias", async ({ store, now }) => {
    const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash" } } }).brain.memory;
    const w = uid("").replace(/-/g, "");
    const ask = (entry: { user: string; platform?: "twitch" | "youtube" | "discord"; userId?: string }) =>
      buildNotesReply(store, cfg, [entry] as never, now());
    const texts = async (e: Parameters<typeof ask>[0]) => (await ask(e)).flatMap((v) => v.notes.map((n) => n.text));
    // An id-keyed row seen later than a name-keyed row with the same display never masks it.
    const shared = `Shared${w}`;
    const named = viewerKey({ platform: "twitch", user: shared });
    const byId = viewerKey({ platform: "youtube", userId: `UC${w}`, user: shared });
    await store.touchViewer(named, shared);
    await store.touchViewer(byId, shared);
    await store.insertNote({ userKey: named, category: "general", text: `named ${w}` });
    await store.insertNote({ userKey: byId, category: "general", text: `by id ${w}` });
    assert.deepEqual(await texts({ user: shared.toLowerCase() }), [`named ${w}`]);
    // Only an id-keyed row has the display: nothing.
    const solo = viewerKey({ platform: "twitch", userId: `1${w}`, user: `Solo${w}` });
    await store.touchViewer(solo, `Solo${w}`);
    await store.insertNote({ userKey: solo, category: "general", text: `solo ${w}` });
    assert.deepEqual(await ask({ user: `Solo${w}` }), []);
    // A voice row and a linked id's Discord display name are not reached.
    await store.touchSpeaker(`v${w}`, `Voice${w}`);
    assert.deepEqual(await ask({ user: `Voice${w}` }), []);
    await store.linkDiscord(`l${w}`, solo);
    await store.touchSpeaker(`l${w}`, `Linked${w}`);
    assert.deepEqual(await ask({ user: `Linked${w}` }), []);
    // A link to a name-keyed target is no alias either: a name-only ask by the Discord display finds nothing (MEM-VOICE-007).
    const nk = viewerKey({ platform: "twitch", user: `Nk${w}` });
    await store.touchViewer(nk, `Nk${w}`);
    await store.insertNote({ userKey: nk, category: "general", text: `nk note ${w}` });
    await store.linkDiscord(`k${w}`, nk);
    await store.touchSpeaker(`k${w}`, `NkVoice${w}`);
    assert.deepEqual(await ask({ user: `NkVoice${w}` }), []);
    assert.deepEqual(await texts({ user: `Nk${w}` }), [`nk note ${w}`], "the viewer's own display still resolves");
    // Hostile names and ids address no other viewer's row.
    for (const user of [`id:1${w}`, `twitch:id:1${w}`, `name:solo${w}`.toLowerCase()]) {
      assert.deepEqual(await texts({ user }), [], user);
      assert.deepEqual(await texts({ user, platform: "twitch" }), [], user);
    }
    assert.deepEqual(await texts({ user: "x", platform: "twitch", userId: `name:${shared}` }), []);
    // An owner placeholder is name-keyed: a name-only entry reaches it until chat claims it (MEM-REG-003, MEM-REG-004).
    const pat = `Pat${w}`;
    const placeholder = await store.setRegular(pat, true);
    assert.equal(placeholder!.key, pat.toLowerCase());
    await store.insertNote({ userKey: placeholder!.key, category: "general", text: `pat note ${w}` });
    assert.deepEqual(await texts({ user: pat.toLowerCase() }), [`pat note ${w}`]);
  });

  // ---- Issue #180: viewers keyed by viewerKey, chat rows with platform / user id / message id, forgetting removals ----
  const recallAll = (h: Harness, query: string) => h.memories(query);

  // @spec MEM-VIEWER-001, MEM-VIEWER-008, MEM-BACKEND-005
  t("a viewer key holding an id is kept as written: two ids differing only in case are two viewers counted separately", async ({ store }) => {
    const id = uid("UCid").replace(/-/g, "");
    const a = viewerKey({ platform: "youtube", userId: id, user: "Zed" });
    const b = viewerKey({ platform: "youtube", userId: id.toLowerCase(), user: "Zed" });
    assert.notEqual(a, b);
    assert.deepEqual([(await store.touchViewer(a, "Zed")).msgCount, (await store.touchViewer(a, "Zed")).msgCount], [1, 2]);
    const first = await store.touchViewer(b, "Zed");
    assert.deepEqual([first.msgCount, first.isNew], [1, true]);
    assert.equal((await store.getViewer(a))!.key, a, "the stored key is not case-folded");
    assert.equal((await store.getViewer(b))!.msgCount, 1);
  });

  // @spec MEM-VIEWER-009, MEM-VIEWER-010, MEM-BACKEND-005
  t("the same name on two platforms is two viewers, each with its own notes", async ({ store }) => {
    const name = uid("Sam");
    const tw = viewerKey({ platform: "twitch", userId: `${uid("")}1`, user: name });
    const yt = viewerKey({ platform: "youtube", userId: `UC${uid("")}`, user: name });
    const twName = viewerKey({ platform: "twitch", user: name.toUpperCase() });
    const ytName = viewerKey({ platform: "youtube", user: name });
    await store.touchViewer(tw, name);
    await store.touchViewer(yt, name);
    await store.touchViewer(twName, name);
    await store.touchViewer(ytName, name);
    const n = await store.insertNote({ userKey: yt, category: "general", text: "only youtube" });
    assert.deepEqual((await store.listNotes(yt)).map((x) => x.id), [n.id]);
    assert.deepEqual(await store.listNotes(tw), []);
    assert.equal((await store.getViewer(twName))!.msgCount, 1);
    assert.equal((await store.getViewer(ytName))!.msgCount, 1);
    assert.notEqual(twName, ytName);
  });

  // @spec MEM-WRITE-009, MEM-STORE-004, MEM-BACKEND-005
  t("a chat row records its platform, user id and message id; a row without ids records none", async (h) => {
    const w = uid("w").replace(/-/g, "");
    await h.store.remember("chat", `bob${w}`, `ids ${w}`, { platform: "youtube", userId: `UC${w}`, messageId: `m${w}` });
    await h.store.remember("chat", `amy${w}`, `bare ${w}`, { platform: "discord" });
    const got = await recallAll(h, `ids ${w}`);
    const withIds = got.find((m) => m.text === `ids ${w}`)!;
    assert.deepEqual([withIds.platform, withIds.userId, withIds.messageId], ["youtube", `UC${w}`, `m${w}`]);
    const bare = (await h.memories(`bare ${w}`)).find((m) => m.text === `bare ${w}`)!;
    assert.deepEqual([bare.platform, bare.userId, bare.messageId], ["discord", undefined, undefined]);
  });

  // @spec MEM-FORGET-002
  t("a message removal deletes the chat rows with that platform and message id, and no other", async (h) => {
    const w = uid("w").replace(/-/g, "");
    const ids = (messageId: string, platform = "twitch") => ({ platform, userId: `u${w}`, messageId });
    await h.store.remember("chat", `a${w}`, `gone ${w}`, ids(`m1${w}`));
    await h.store.remember("chat", `a${w}`, `kept same-platform ${w}`, ids(`m2${w}`));
    await h.store.remember("chat", `a${w}`, `kept other-platform ${w}`, ids(`m1${w}`, "youtube"));
    await h.store.remember("speech", `a${w}`, `kept speech ${w}`, ids(`m1${w}`));
    await h.store.forgetChat({ platform: "twitch", scope: "message", messageId: `m1${w}` });
    const texts = (await recallAll(h, `${w}`)).map((m) => m.text);
    assert.ok(!texts.includes(`gone ${w}`));
    assert.ok(texts.includes(`kept same-platform ${w}`) && texts.includes(`kept other-platform ${w}`) && texts.includes(`kept speech ${w}`), texts.join("|"));
  });

  // @spec MEM-FORGET-003
  t("a user removal deletes the chat rows with that platform and user id, and no other", async (h) => {
    const w = uid("w").replace(/-/g, "");
    await h.store.remember("chat", `a${w}`, `gone one ${w}`, { platform: "youtube", userId: `UC${w}`, messageId: `m1${w}` });
    await h.store.remember("chat", `a${w}`, `gone two ${w}`, { platform: "youtube", userId: `UC${w}`, messageId: `m2${w}` });
    await h.store.remember("chat", `a${w}`, `kept other user ${w}`, { platform: "youtube", userId: `UCother${w}` });
    await h.store.remember("chat", `a${w}`, `kept other platform ${w}`, { platform: "twitch", userId: `UC${w}` });
    await h.store.remember("chat", `a${w}`, `kept no ids ${w}`);
    await h.store.forgetChat({ platform: "youtube", scope: "user", userId: `UC${w}` });
    const texts = (await recallAll(h, `${w}`)).map((m) => m.text).sort();
    assert.deepEqual(texts, [`kept no ids ${w}`, `kept other platform ${w}`, `kept other user ${w}`].sort());
  });

  // @spec MEM-FORGET-004
  t("an all-scope removal deletes no stored row", async (h) => {
    const w = uid("w").replace(/-/g, "");
    await h.store.remember("chat", `a${w}`, `stays ${w}`, { platform: "twitch", userId: `u${w}`, messageId: `m${w}` });
    await h.store.forgetChat({ platform: "twitch", scope: "all" });
    assert.ok((await recallAll(h, `stays ${w}`)).some((m) => m.text === `stays ${w}`));
  });

  // @spec MEM-FORGET-005
  t("a removal matching no row changes nothing and does not throw", async (h) => {
    const w = uid("w").replace(/-/g, "");
    await h.store.remember("chat", `a${w}`, `stays ${w}`, { platform: "twitch", userId: `u${w}`, messageId: `m${w}` });
    await h.store.forgetChat({ platform: "twitch", scope: "message", messageId: `nope${w}` });
    await h.store.forgetChat({ platform: "twitch", scope: "user", userId: `nope${w}` });
    assert.ok((await recallAll(h, `stays ${w}`)).some((m) => m.text === `stays ${w}`));
  });

  // @spec MEM-FORGET-007
  t("a removal leaves viewer rows, counts, flags, notes and deletion records unchanged", async (h) => {
    const { store } = h;
    const key = viewerKey({ platform: "twitch", userId: uid("u"), user: "Rae" });
    await store.touchViewer(key, "Rae", { isSub: true });
    await store.touchViewer(key, "Rae");
    await store.setRegular(key, true);
    const kept = await store.insertNote({ userKey: key, category: "general", text: "likes tea" });
    const deleted = await store.insertNote({ userKey: key, category: "general", text: "was deleted" });
    await store.deleteNote(deleted.id);
    const userId = key.split(":").slice(2).join(":");
    await store.remember("chat", "Rae", `rae line ${userId}`, { platform: "twitch", userId, messageId: `m-${userId}` });
    const before = JSON.stringify([await store.getViewer(key), await store.listNotes(key), await store.listDeletions(key)]);
    await store.forgetChat({ platform: "twitch", scope: "user", userId });
    await store.forgetChat({ platform: "twitch", scope: "message", messageId: `m-${userId}` });
    await store.forgetChat({ platform: "twitch", scope: "all" });
    assert.equal(JSON.stringify([await store.getViewer(key), await store.listNotes(key), await store.listDeletions(key)]), before);
    assert.deepEqual((await store.listNotes(key)).map((n) => n.id), [kept.id]);
  });

  // @spec MEM-FORGET-005
  t("a message removal without a message id, or a user removal without a user id, deletes nothing (no NULL matches)", async (h) => {
    const w = uid("w").replace(/-/g, "");
    await h.store.remember("chat", `a${w}`, `no id kept ${w}`, { platform: "twitch", userId: `u${w}`, messageId: `m${w}` });
    await h.store.forgetChat({ platform: "twitch", scope: "message" });
    await h.store.forgetChat({ platform: "twitch", scope: "user" });
    assert.equal((await recallAll(h, `no id kept ${w}`)).length, 1);
  });

  // @spec MEM-VOICE-001, MEM-VOICE-011
  t("a Discord id shaped like a viewerKey prefix is refused: it never names a voice key or a link", async ({ store }) => {
    await assert.rejects(store.touchSpeaker("id:12345", "Mallory"), /viewerKey prefix/);
    await assert.rejects(store.touchSpeaker("NAME:kit", "Mallory"), /viewerKey prefix/);
    const chat = vkey("victim");
    await store.touchViewer(chat, "Victim");
    await assert.rejects(store.linkDiscord("name:kit", chat), /viewerKey prefix/);
    assert.equal(await store.getViewer(chat).then((v) => v?.key), chat);
    assert.equal((await store.getViewer(chat))!.msgCount, 1, "the chat viewer is unchanged");
    assert.equal(await store.getViewer("discord:id:12345"), undefined, "no voice row was created");
    assert.equal(await store.getViewer("discord:name:kit"), undefined, "no voice row was created");
    assert.deepEqual(await store.listLinks(chat), [], "no link was recorded");
  });

  // @spec MEM-REG-003
  t("an owner placeholder is never created under a viewerKey: setting the flag for one names no row", async ({ store }) => {
    const key = vkey("ghost");
    assert.equal(await store.setRegular(key, true), undefined);
    assert.equal(await store.getViewer(key), undefined);
  });
}
