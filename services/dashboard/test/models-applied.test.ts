import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { glb, model, open, rig, send, tick, type Rig } from "./models-rig.js";
import { configText } from "./config-fixture.js";

// DELETE /avatar/models/<name> (DASH-MDL-033..036), the renderer save check (DASH-MDL-037) and the applied view
// (DASH-AVR-023, 024, 026..029), observed through the model routes and the settings route.

const del = (r: Rig, name: string, headers: Record<string, string> = r.auth) => send(r.port, "DELETE", `/avatar/models/${name}`, { headers });
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const served = async (r: Rig): Promise<Buffer | null> => { const x = await r.get("/avatar/model"); return x.status === 200 ? x.body : null; };

// @spec DASH-MDL-033
test("DELETE is a 404 on the LAN listener and checks Host, Origin, token, name, applied model in that order, with no slot or size check", async (t) => {
  const r = await rig(t, { control: true, seed: { "Aiko.vrm": model("a"), "Active.vrm": model("act") }, renderer: { model: "Active.vrm" } });
  assert.equal((await send(r.lanPort, "DELETE", "/avatar/models/Aiko.vrm", { headers: r.auth })).status, 404);
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Aiko.vrm", { headers: { ...r.auth, host: "evil.example", origin: "http://evil.example" } })).status, 403, "Host");
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Aiko.vrm", { headers: { ...r.auth, origin: "http://evil.example" } })).status, 403, "Origin before token");
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Nope.vrm", { headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Nope.vrm")).status, 401, "token before name");
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Active.vrm")).status, 401, "token before the applied check");
  assert.equal((await del(r, "Nope.vrm")).status, 404, "name before the applied check");
  assert.equal((await del(r, "Active.vrm")).status, 409);
  assert.deepEqual(r.ls(), ["Active.vrm", "Aiko.vrm"]);
  // an upload holding the one slot, and a body of any size on the DELETE, change nothing
  const whole = model("slot", 4096);
  const h = open(r.port, "POST", "/avatar/models?name=Slot.vrm", { ...r.auth, "content-length": String(whole.length) });
  h.write(whole.subarray(0, 64));
  for (let i = 0; i < 200 && !r.ls().some((n) => n.startsWith(".incoming-")); i++) await tick(5);
  const res = await send(r.port, "DELETE", "/avatar/models/Aiko.vrm", { headers: r.auth, body: Buffer.alloc(2 * 1024 * 1024) });
  assert.equal(res.status, 200, "no upload-slot or size check applies");
  h.destroy();
});

// @spec DASH-MDL-033
test("with control off a loopback DELETE is open", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") } });
  assert.equal((await send(r.port, "DELETE", "/avatar/models/Aiko.vrm")).status, 200);
});

// @spec DASH-MDL-034
test("a name outside the grammar, undecodable, or matching no stored model is 404 and deletes nothing", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "notes.txt": Buffer.from("n") } });
  for (const n of ["..%2FAiko.vrm", "%2e%2e%2f", "notes.txt", "Aiko.VRM", "Aiko.vrm%00", "%E0%A4%A", "Unknown.vrm", "a%2Fb.vrm", "x".repeat(90) + ".vrm"]) {
    assert.equal((await del(r, n)).status, 404, n);
  }
  assert.deepEqual(r.ls(), ["Aiko.vrm", "notes.txt"]);
  assert.equal((await del(r, "AIKO.vrm")).status, 200, "a valid name for a stored model is deleted");
});

// @spec DASH-MDL-035
test("the applied model, by any ASCII case, is 409 {ok:false, detail} and stays", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") }, renderer: { model: "aiko.vrm" } });
  for (const n of ["Aiko.vrm", "AIKO.vrm", "aiko.vrm"]) {
    const res = await del(r, n);
    assert.equal(res.status, 409, n);
    assert.equal(res.json().ok, false);
    assert.equal(typeof res.json().detail, "string");
  }
  assert.deepEqual(r.ls(), ["Aiko.vrm"]);
});

// @spec DASH-MDL-036
test("DELETE of a stored model that is not applied removes it (any ASCII case) and answers 200 {ok:true}", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Bea.vrm" } });
  const res = await del(r, "AIKO.vrm");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.deepEqual(r.ls(), ["Bea.vrm"]);
  assert.equal((await r.get("/avatar/models/Aiko.vrm")).status, 404);
});

// @spec DASH-AVR-023
test("at start the applied model is the stored valid model renderer.model names (ASCII case aside), and /avatar/model serves it", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "aiko.vrm", zoom: 1.5, offset_y: 0.2, turn: 30 } });
  assert.deepEqual(await served(r), model("a"));
  const list = (await r.get("/avatar/models")).json();
  assert.equal(list.active, "Aiko.vrm");
  assert.deepEqual(list.models.map((m: { name: string; active: boolean }) => [m.name, m.active]), [["Aiko.vrm", true], ["Bea.vrm", false]]);
  assert.deepEqual(r.rec.lines.filter((l) => l.level === "warn" && /renderer\.model/.test(JSON.stringify(l))), [], "no warning when the model exists");
});

// @spec DASH-AVR-023
test("an empty renderer.model applies no model and logs no warning", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") } });
  assert.equal(await served(r), null);
  assert.equal((await r.get("/avatar/models")).json().active, null);
  assert.deepEqual(r.rec.lines.filter((l) => l.level === "warn" && /renderer\.model/.test(JSON.stringify(l))), []);
});

// @spec DASH-AVR-023
test("a renderer.model that names no stored model, or one listed with an error, applies none and logs a warning naming renderer.model", async (t) => {
  const missing = await rig(t, { folder: true, renderer: { model: "Ghost.vrm" } });
  assert.equal(await served(missing), null);
  assert.equal((await missing.get("/avatar/models")).json().active, null);
  assert.ok(missing.rec.lines.some((l) => l.level === "warn" && /renderer\.model/.test(JSON.stringify(l))), "a warning names renderer.model");
  const broken = await rig(t, { seed: { "Broken.vrm": glb({ asset: { version: "2.0" } }, { bin: 4 }) }, renderer: { model: "Broken.vrm" } });
  assert.equal(await served(broken), null);
  assert.ok(broken.rec.lines.some((l) => l.level === "warn" && /renderer\.model/.test(JSON.stringify(l))));
});

// @spec DASH-MDL-037, DASH-AVR-024
test("a PUT /config/renderer, a dry run included, that would leave a model that is not stored or has an error is 400 with an issue on renderer.model and writes nothing", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Broken.vrm": glb({ asset: { version: "2.0" } }, { bin: 4 }) } });
  const before = readFileSync(r.cfgFile, "utf8");
  for (const dryRun of [false, true]) {
    for (const m of ["Ghost.vrm", "Broken.vrm"]) {
      const res = await r.save({ model: m }, { dryRun });
      assert.equal(res.status, 400, `${m} dryRun=${dryRun}`);
      assert.ok(res.json().issues.some((i: { path: string }) => i.path === "renderer.model"));
      assert.equal(readFileSync(r.cfgFile, "utf8"), before);
    }
  }
  assert.equal((await r.save({ model: "" }, { dryRun: true })).status, 200, "blank is allowed");
  assert.equal((await r.save({ model: "AIKO.vrm" }, { dryRun: true })).status, 200, "ASCII case aside");
});

// @spec DASH-MDL-037, DASH-AVR-024
test("the check is on the section as the file would hold it: a save that does not send model still fails when the file's model is not stored", async (t) => {
  const r = await rig(t, { folder: true });
  writeFileSync(r.cfgFile, configText({ renderer: { model: "Ghost.vrm" } }));
  const before = readFileSync(r.cfgFile, "utf8");
  const res = await r.save({ zoom: 2 });
  assert.equal(res.status, 400);
  assert.ok(res.json().issues.some((i: { path: string }) => i.path === "renderer.model"));
  assert.equal(readFileSync(r.cfgFile, "utf8"), before);
  assert.equal((await r.save({ zoom: 2, model: "" })).status, 200, "sending a blank model fixes it");
});

// @spec DASH-MDL-037
test("the etag comparison comes first: a stale etag with a bad model is 409 and not 400", async (t) => {
  const r = await rig(t, { folder: true });
  assert.equal((await r.save({ model: "Ghost.vrm" })).status, 400, "with the current etag the model check answers");
  const res = await r.save({ model: "Ghost.vrm" }, { etag: sha("stale") });
  assert.equal(res.status, 409);
});

// @spec DASH-AVR-024
test("a successful save sets the applied view before it answers, with no restart: the new model is served at once, blank applies none", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Aiko.vrm" } });
  const res = await r.save({ model: "bea.vrm", zoom: 2 });
  assert.equal(res.status, 200);
  assert.deepEqual(await served(r), model("b"));
  assert.equal((await r.get("/avatar/models")).json().active, "Bea.vrm");
  assert.equal((await r.save({ model: "" })).status, 200);
  assert.equal(await served(r), null);
  assert.equal((await r.get("/avatar/models")).json().active, null);
});

// @spec DASH-AVR-024
test("a value edited by hand into the file goes live with the next save of any key, the model by the rule of DASH-AVR-023", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Aiko.vrm" } });
  writeFileSync(r.cfgFile, configText({ renderer: { model: "Bea.vrm" } }));
  assert.deepEqual(await served(r), model("a"), "not applied until a save");
  assert.equal((await r.save({ turn: 10 })).status, 200);
  assert.deepEqual(await served(r), model("b"));
});

// @spec DASH-AVR-026
test("/avatar/model, the active field and the delete guard read the applied view and never config.yaml", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Aiko.vrm" } });
  writeFileSync(r.cfgFile, configText({ renderer: { model: "Bea.vrm" } })); // a hand edit, not saved through the dashboard
  assert.deepEqual(await served(r), model("a"));
  assert.equal((await r.get("/avatar/models")).json().active, "Aiko.vrm");
  assert.equal((await del(r, "Aiko.vrm")).status, 409, "the applied model, not the file's");
  assert.equal((await del(r, "Bea.vrm")).status, 200, "the file's model is not applied");
});

// @spec DASH-AVR-027
test("an upload that replaces the applied model's file serves the new bytes under a new etag", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("old") }, renderer: { model: "Aiko.vrm" } });
  const first = await r.get("/avatar/model");
  const res = await send(r.port, "POST", "/avatar/models?name=Aiko.vrm&replace=1", { headers: r.auth, body: model("a much newer and larger one", 2048) });
  assert.equal(res.status, 201);
  const second = await r.get("/avatar/model");
  assert.notEqual(second.headers["etag"], first.headers["etag"]);
  assert.deepEqual(second.body, model("a much newer and larger one", 2048));
  assert.equal((await r.get("/avatar/model", { "if-none-match": first.headers["etag"] as string })).status, 200, "the old version is no longer current");
});

// @spec DASH-AVR-028
test("a delete and a save that selects the same model never both succeed", async (t) => {
  // Every model listing waits 25 ms, so a delete and a save overlap unless the applied view's lock orders them.
  const r = await rig(t, { seed: { "Keep.vrm": model("keep") }, renderer: { model: "Keep.vrm" }, pause: () => new Promise((ok) => setTimeout(ok, 25)) });
  const outcomes = new Set<string>();
  for (let i = 0; i < 25; i++) {
    const name = `Pick${i}.vrm`;
    assert.equal((await send(r.port, "POST", `/avatar/models?name=${name}`, { headers: r.auth, body: model(`p${i}`) })).status, 201);
    const [sel, rm] = await Promise.all([r.save({ model: name }), del(r, name)]);
    outcomes.add(`${sel.status}/${rm.status}`);
    assert.ok((sel.status === 200 && rm.status === 409) || (sel.status === 400 && rm.status === 200), `save ${sel.status}, delete ${rm.status}`);
    assert.equal(sel.status === 200 && rm.status === 200, false, "both succeeded: the save selected a file the delete removed");
    const applied = (await r.get("/avatar/models")).json().active;
    assert.equal(applied === name, sel.status === 200);
    if (sel.status === 200) assert.ok(r.ls().includes(name), "the selected file is still there");
    await r.save({ model: "Keep.vrm" });
    await del(r, name);
  }
  assert.ok(outcomes.size > 0);
});

// @spec DASH-AVR-029
test("a dry run writes nothing and changes neither the applied view nor what is served", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a"), "Bea.vrm": model("b") }, renderer: { model: "Aiko.vrm" } });
  const before = readFileSync(r.cfgFile, "utf8");
  const res = await r.save({ model: "Bea.vrm", zoom: 3 }, { dryRun: true });
  assert.equal(res.status, 200);
  assert.equal(readFileSync(r.cfgFile, "utf8"), before);
  assert.deepEqual(await served(r), model("a"));
  assert.equal((await r.get("/avatar/models")).json().active, "Aiko.vrm");
  assert.equal((await del(r, "Bea.vrm")).status, 200, "Bea was never selected");
});
