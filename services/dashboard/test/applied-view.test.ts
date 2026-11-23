import { test } from "node:test";
import assert from "node:assert/strict";
import { AppliedView, modelIssue, Mutex, type Loadable } from "../src/applied.js";

// The applied view on its own: the model and the framing it holds from `renderer.*` at start and after a save (DASH-AVR-023,
// DASH-AVR-024, DASH-AVR-027), the issue a save raises (DASH-MDL-037) and the lock that orders a save with a delete (DASH-AVR-028).

const stored: Loadable[] = [{ name: "Aiko.vrm", version: "10-18c0a" }, { name: "Bea.vrm", version: "20-18c0b" }];
const framing = { model: "", zoom: 1, offset_y: 0, turn: 0 };

// @spec DASH-AVR-023
test("at start the framing is renderer.zoom, offset_y and turn, and the model is the loadable stored one the name compares equal to", () => {
  const v = new AppliedView();
  v.start({ model: "aiko.vrm", zoom: 1.5, offset_y: -0.25, turn: 30 }, stored);
  assert.deepEqual(v.get(), { model: { name: "Aiko.vrm", version: "10-18c0a" }, configuredModel: "aiko.vrm", zoom: 1.5, offsetY: -0.25, turn: 30 });
});

// @spec DASH-AVR-023
test("at start an empty model applies none, and a name that is not loadable applies none, keeps the configured name and warns naming renderer.model", () => {
  const warnings: unknown[] = [];
  const v = new AppliedView({ warn: (...a: unknown[]) => { warnings.push(a); } } as never);
  v.start({ ...framing, zoom: 2 }, stored);
  assert.deepEqual([v.get().model, v.get().zoom, warnings.length], [null, 2, 0], "no warning for an empty model");
  v.start({ ...framing, model: "Ghost.vrm" }, stored);
  assert.equal(v.get().model, null);
  assert.equal(v.get().configuredModel, "Ghost.vrm");
  assert.equal(warnings.length, 1);
  assert.match(JSON.stringify(warnings[0]), /renderer\.model/);
});

// @spec DASH-AVR-024
test("a saved renderer section sets the framing and the model before the save answers, and a blank model applies none", () => {
  const v = new AppliedView();
  v.start({ model: "Aiko.vrm", zoom: 1, offset_y: 0, turn: 0 }, stored);
  v.apply({ model: "BEA.vrm", zoom: 2.5, offset_y: 0.5, turn: -45 }, stored);
  assert.deepEqual(v.get(), { model: { name: "Bea.vrm", version: "20-18c0b" }, configuredModel: "BEA.vrm", zoom: 2.5, offsetY: 0.5, turn: -45 });
  v.apply({ ...framing, zoom: 3 }, stored);
  assert.deepEqual([v.get().model, v.get().zoom], [null, 3]);
});

// @spec DASH-AVR-027
test("an upload that replaces the applied file gives the applied model its new version", () => {
  const v = new AppliedView();
  v.start({ model: "Aiko.vrm", zoom: 1, offset_y: 0, turn: 0 }, stored);
  v.refresh([{ name: "Aiko.vrm", version: "99-18c0z" }, stored[1]!]);
  assert.equal(v.get().model?.version, "99-18c0z");
  v.refresh(stored.slice(1));
  assert.equal(v.get().model?.version, "99-18c0z", "no stored file to follow: the view keeps its last version");
});

// @spec DASH-AVR-024
test("the view pushes each change to its listeners, and a stopped listener gets nothing more", () => {
  const v = new AppliedView();
  const seen: number[] = [];
  const stop = v.onChange((s) => seen.push(s.zoom));
  v.apply({ ...framing, zoom: 2 }, stored);
  stop();
  v.apply({ ...framing, zoom: 3 }, stored);
  assert.deepEqual(seen, [2]);
});

// @spec DASH-MDL-037
test("a model that is blank or loadable raises no issue; any other names the renderer.model issue", () => {
  assert.equal(modelIssue(stored, ""), undefined);
  assert.equal(modelIssue(stored, "aiko.vrm"), undefined);
  assert.match(modelIssue(stored, "Ghost.vrm") ?? "", /renderer\.model/);
});

// @spec DASH-AVR-021
test("a listener that throws is logged and skipped: the change is kept, the other listeners still run, and no caller sees the throw", () => {
  const logged: unknown[] = [];
  const v = new AppliedView({ warn: (...a: unknown[]) => { logged.push(a); } } as never);
  const seen: number[] = [];
  v.onChange(() => { throw new Error("broken relay"); });
  v.onChange((s) => seen.push(s.zoom));
  assert.doesNotThrow(() => v.apply({ ...framing, zoom: 2 }, stored));
  assert.doesNotThrow(() => v.refresh(stored));
  assert.equal(v.get().zoom, 2);
  assert.deepEqual(seen, [2]);
  assert.equal(logged.length, 1);
});

// @spec DASH-AVR-028
test("the lock runs one job at a time, in the order they were asked for, and a failed job does not hold it", async () => {
  const m = new Mutex();
  const order: string[] = [];
  const slow = m.run(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("slow"); });
  const fast = m.run(async () => { order.push("fast"); });
  const failing = m.run(async () => { throw new Error("boom"); });
  await slow; await fast;
  await assert.rejects(failing, /boom/);
  assert.deepEqual(order, ["slow", "fast"]);
  assert.equal(await m.run(async () => 7), 7);
});
