import { test } from "node:test";
import assert from "node:assert/strict";
import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { answerViewersRequest, type ViewersAdminStore } from "../src/admin.js";

const DAY = 86_400_000;
const T0 = new Date("2026-03-01T12:00:00Z").getTime();

function setup() {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", regular_messages: 3 } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  const ask = (req: Record<string, unknown>) => answerViewersRequest(store, cfg.notes, { id: "r1", ...req } as never, now);
  return { store, ask, advance: (ms: number) => { now += ms; } };
}
type Data = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// @spec MEM-ADMIN-001
test("list: viewers newest first, filtered by display substring, with the owner flag and counts", async () => {
  const { store, ask, advance } = setup();
  await store.touchViewer("1", "Alice"); advance(1000);
  await store.touchViewer("2", "bob"); advance(1000);
  await store.insertNote({ userKey: "1", category: "general", text: "likes cats" });
  await store.setRegular("2", true);
  const all = await ask({ op: "list" });
  assert.equal(all.ok, true);
  assert.deepEqual((all.data as Data).viewers, [
    { key: "2", display: "bob", regular: true, regularManual: true, msgCount: 1, noteCount: 0 },
    { key: "1", display: "Alice", regular: false, regularManual: false, msgCount: 1, noteCount: 1 },
  ]);
  assert.deepEqual(((await ask({ op: "list", query: "ALI" })).data as Data).viewers.map((v: Data) => v.key), ["1"]);
  assert.deepEqual(((await ask({ op: "list", query: "  " })).data as Data).viewers.length, 2, "a blank query lists everyone");
});

// @spec MEM-ADMIN-001
test("list: at most 500 viewers", async () => {
  const { store, ask } = setup();
  for (let i = 0; i < 502; i++) await store.touchViewer(`u${i}`, `User${i}`);
  assert.equal(((await ask({ op: "list" })).data as Data).viewers.length, 500);
});

// @spec MEM-ADMIN-002
test("get: notes split into core and recent with effective strength, plus deletion records", async () => {
  const { store, ask, advance } = setup();
  await store.touchViewer("1", "Alice");
  const core = await store.insertNote({ userKey: "1", layer: "core", category: "family", text: "has a sister" });
  await store.insertNote({ userKey: "1", layer: "recent", category: "general", text: "playing chess" });
  const gone = await store.insertNote({ userKey: "1", category: "general", text: "hates mondays" });
  await store.deleteNote(gone.id, "off topic");
  advance(14 * DAY);
  const r = await ask({ op: "get", key: "1" });
  assert.equal(r.ok, true);
  const d = r.data as Data;
  assert.deepEqual([d.viewer.key, d.viewer.display, d.viewer.regular, d.viewer.regularManual, d.viewer.msgCount, d.viewer.noteCount], ["1", "Alice", false, false, 1, 2]);
  assert.deepEqual(d.core.map((n: Data) => [n.id, n.category, n.text, n.hint]), [[String(core.id), "family", "has a sister", "check in warmly and gently; never name or quote it"]]);
  assert.ok(d.core[0].strength > 0.8 && d.core[0].strength < 1, "core fades slowly: still strong after 14 days");
  assert.equal(d.recent.length, 1);
  assert.ok(d.recent[0].strength < d.core[0].strength, "recent fades faster than core");
  assert.deepEqual(d.deletions.map((x: Data) => [x.category, x.text, x.reason, x.deletedAt]), [["general", "hates mondays", "off topic", T0]]);
  assert.equal(typeof d.deletions[0].id, "string");
});

// @spec MEM-ADMIN-002, MEM-ADMIN-007
test("get: an unknown viewer is not_found", async () => {
  const { ask } = setup();
  const r = await ask({ op: "get", key: "nobody" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "not_found");
  assert.match(r.detail!, /nobody/);
});

// @spec MEM-ADMIN-003
test("delete_note: records the deletion with the trimmed reason, none when blank; an unknown or non-numeric id is not_found", async () => {
  const { store, ask } = setup();
  await store.touchViewer("1", "Alice");
  const a = await store.insertNote({ userKey: "1", category: "general", text: "a" });
  const b = await store.insertNote({ userKey: "1", category: "general", text: "b" });
  assert.deepEqual(await ask({ op: "delete_note", noteId: String(a.id), reason: "  too personal " }), { ok: true, data: {} });
  assert.deepEqual(await ask({ op: "delete_note", noteId: String(b.id), reason: "   " }), { ok: true, data: {} });
  assert.deepEqual((await store.listDeletions("1")).map((d) => d.reason), ["too personal", null]);
  assert.equal((await ask({ op: "delete_note", noteId: String(a.id) })).error, "not_found");
  assert.equal((await ask({ op: "delete_note", noteId: "abc" })).error, "not_found");
});

// @spec MEM-ADMIN-004
test("restore: the note comes back and the record is gone; an unknown record is not_found", async () => {
  const { store, ask } = setup();
  await store.touchViewer("1", "Alice");
  const n = await store.insertNote({ userKey: "1", category: "general", text: "likes cats" });
  await store.deleteNote(n.id, "no");
  const [rec] = await store.listDeletions("1");
  const r = await ask({ op: "restore", deletionId: String(rec!.id) });
  assert.equal(r.ok, true);
  assert.equal((r.data as Data).note.text, "likes cats");
  assert.deepEqual((await store.listNotes("1")).map((x) => x.text), ["likes cats"]);
  assert.deepEqual(await store.listDeletions("1"), []);
  assert.equal((await ask({ op: "restore", deletionId: String(rec!.id) })).error, "not_found");
  assert.equal((await ask({ op: "restore", deletionId: "x" })).error, "not_found");
});

// @spec MEM-ADMIN-005
test("clear: every note becomes a deletion with the one reason; the flag and counts stay; unknown viewer is not_found", async () => {
  const { store, ask } = setup();
  await store.touchViewer("1", "Alice");
  await store.setRegular("1", true);
  await store.insertNote({ userKey: "1", category: "general", text: "a" });
  await store.insertNote({ userKey: "1", category: "general", text: "b" });
  assert.deepEqual(await ask({ op: "clear", key: "1", reason: "reset" }), { ok: true, data: { cleared: 2 } });
  assert.deepEqual((await store.listDeletions("1")).map((d) => d.reason), ["reset", "reset"]);
  const v = (await store.getViewer("1"))!;
  assert.deepEqual([v.regularManual, v.msgCount], [true, 1]);
  assert.equal((await ask({ op: "clear", key: "ghost" })).error, "not_found");
});

// @spec MEM-ADMIN-006
test("set_regular: by key, by display name, and a placeholder for a name with no row; clearing an unknown name is not_found", async () => {
  const { store, ask } = setup();
  await store.touchViewer("1", "Alice");
  const byKey = await ask({ op: "set_regular", key: "1", regular: true });
  assert.equal((byKey.data as Data).viewer.regularManual, true);
  const off = await ask({ op: "set_regular", name: "alice", regular: false });
  assert.deepEqual([(off.data as Data).viewer.key, (off.data as Data).viewer.regularManual, (off.data as Data).viewer.regular], ["1", false, false]);
  const made = await ask({ op: "set_regular", name: "Newcomer", regular: true });
  assert.deepEqual([(made.data as Data).viewer.key, (made.data as Data).viewer.msgCount, (made.data as Data).viewer.regular], ["newcomer", 0, true]);
  assert.equal((await ask({ op: "set_regular", name: "Ghost", regular: false })).error, "not_found");
});

// @spec MEM-ADMIN-007
test("a store failure is answered ok:false, error failed, with a detail", async () => {
  const { store, ask } = setup();
  (store as ViewersAdminStore).listViewers = async () => { throw new Error("db down"); };
  const r = await ask({ op: "list" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "failed");
  assert.match(r.detail!, /db down/);
});
