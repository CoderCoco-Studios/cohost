import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@cohost/testing";
import { ANSWER_CAP_MS, glb, model, modelOfSize, open, rig, send, tick, MiB, type Rig } from "./models-rig.js";

// POST /avatar/models: the gating, the check order, the streamed write, the head checks and the commit (DASH-MDL-015..032).

const up = (r: Rig, query: string, body: Buffer, o: { headers?: Record<string, string>; chunked?: boolean } = {}) =>
  send(r.port, "POST", `/avatar/models${query}`, { headers: { ...r.auth, ...o.headers }, body, chunked: o.chunked });
const incoming = (r: Rig): string[] => r.ls().filter((n) => n.startsWith(".incoming-"));
const names = (r: Rig): string[] => r.ls().filter((n) => !n.startsWith(".incoming-"));
/** The first bytes of an upload: the whole glTF head (well under 1 KiB) and a little of the BIN chunk, so the head is judged. */
const HEAD_BYTES = 1024;
/** Waits until the dropped upload's temporary file is gone; the server learns of the drop on its own schedule, so no event marks it. */
const untilRemoved = (r: Rig, what: string): Promise<void> => waitFor(() => incoming(r).length === 0, `${what}: the temporary file removed`, ANSWER_CAP_MS);

/** An upload held open mid-body: the head is sent, the rest never is, until the caller ends it. */
async function hold(r: Rig, name: string, extra = ""): Promise<{ finish: (rest: Buffer) => Promise<Awaited<ReturnType<typeof open>["done"]>>; drop: () => void; whole: Buffer }> {
  const whole = model(name, 4096);
  const h = open(r.port, "POST", `/avatar/models?name=${name}.vrm${extra}`, { ...r.auth, "content-length": String(whole.length) });
  const opened = r.tempOpened();
  h.write(whole.subarray(0, HEAD_BYTES));
  await opened;
  assert.equal(incoming(r).length, 1, "the upload has opened its temporary file");
  return { whole, finish: (rest) => { h.end(rest); return h.done; }, drop: () => h.destroy() };
}

// @spec DASH-MDL-001
test("the models live only in <dataDir>/dashboard/avatar-models/, created at the first upload, and nothing else is written under dataDir", async (t) => {
  const r = await rig(t, {});
  assert.deepEqual(readdirSync(r.data), [], "nothing is created at start");
  const res = await up(r, "?name=Aiko.vrm", model("a"));
  assert.equal(res.status, 201);
  assert.deepEqual(readdirSync(r.data), ["dashboard"]);
  assert.deepEqual(readdirSync(join(r.data, "dashboard")), ["avatar-models"]);
  assert.deepEqual(r.ls(), ["Aiko.vrm"]);
  assert.deepEqual(readFileSync(join(r.models, "Aiko.vrm")), model("a"));
});

// @spec DASH-MDL-015
test("POST /avatar/models is a 404 on the LAN listener and stores nothing", async (t) => {
  const r = await rig(t, { control: true });
  const res = await send(r.lanPort, "POST", "/avatar/models?name=Aiko.vrm", { headers: r.auth, body: model("a") });
  assert.equal(res.status, 404);
  assert.deepEqual(r.ls(), []);
  assert.equal((await up(r, "?name=Aiko.vrm", model("a"))).status, 201, "the same request on the full surface is served");
});

// @spec DASH-MDL-016
test("with control on it needs the bearer token; with it off a loopback full surface is open; a foreign Origin is refused", async (t) => {
  const on = await rig(t, { control: true });
  assert.equal((await send(on.port, "POST", "/avatar/models?name=A.vrm", { body: model("a") })).status, 401);
  assert.equal((await send(on.port, "POST", "/avatar/models?name=A.vrm", { headers: { authorization: "Bearer wrong" }, body: model("a") })).status, 401);
  assert.deepEqual(on.ls(), []);
  assert.equal((await up(on, "?name=A.vrm", model("a"))).status, 201);
  const off = await rig(t, {});
  assert.equal((await send(off.port, "POST", "/avatar/models?name=A.vrm", { body: model("a") })).status, 201);
  for (const origin of ["http://evil.example", "null", "not a url", "https://127.0.0.1:" + off.port]) {
    const res = await send(off.port, "POST", "/avatar/models?name=B.vrm", { headers: { origin }, body: model("b") });
    assert.equal(res.status, 403, origin);
  }
  assert.deepEqual(off.ls(), ["A.vrm"]);
  assert.equal((await send(off.port, "POST", "/avatar/models?name=C.vrm", { headers: { origin: `http://127.0.0.1:${off.port}` }, body: model("c") })).status, 201);
});

// @spec DASH-MDL-017
test("the checks run in order, each answering alone and reading no body byte after it: Host, Origin, token, Content-Length, name, slot, collision, limit", async (t) => {
  const r = await rig(t, { control: true, maxBytes: MiB, seed: { "Aiko.vrm": model("a") } });
  const answers = async (query: string, headers: Record<string, string>, expected: number, why: string) => {
    const h = open(r.port, "POST", `/avatar/models${query}`, headers);
    h.write(Buffer.alloc(100, 1)); // a body that never finishes: the answer must come without it
    const res = await Promise.race([h.done, new Promise<null>((ok) => setTimeout(() => ok(null), ANSWER_CAP_MS))]);
    h.destroy();
    assert.notEqual(res, null, `${why}: no answer without the rest of the body`);
    assert.equal(res!.status, expected, why);
    return res!;
  };
  const big = String(2 * MiB), small = String(500);
  await answers("", { host: "evil.example", origin: "http://evil.example", "content-length": big }, 403, "Host before Origin, token, size, name");
  await answers("", { origin: "http://evil.example", "content-length": big }, 403, "Origin before token, size, name");
  await answers("", { "content-length": big }, 401, "token before size and name");
  await answers("", { ...r.auth, "content-length": big }, 413, "size before name");
  await answers("", { ...r.auth, "content-length": small }, 400, "name");
  const slot = await hold(r, "Slot");
  const a = await answers("?name=Other.vrm", { ...r.auth, "content-length": small }, 409, "slot");
  assert.equal("name" in a.json(), false, "the slot refusal names no model");
  const c = await answers("?name=Aiko.vrm", { ...r.auth, "content-length": small }, 409, "slot before collision");
  assert.equal("name" in c.json(), false);
  await answers("", { ...r.auth, "content-length": small }, 400, "name before slot");
  slot.drop();
  await untilRemoved(r, "the dropped slot upload");
  const col = await answers("?name=aiko.vrm", { ...r.auth, "content-length": small }, 409, "collision");
  assert.equal(col.json().name, "Aiko.vrm");
});

// @spec DASH-MDL-017, DASH-MDL-020
test("a collision is judged before a limit", async (t) => {
  const seed: Record<string, Buffer> = {};
  for (let i = 0; i < 20; i++) seed[`m${String(i).padStart(2, "0")}.vrm`] = model(String(i));
  const r = await rig(t, { control: true, seed });
  const col = await up(r, "?name=m00.vrm", model("again"));
  assert.equal(col.status, 409);
  assert.equal(col.json().name, "m00.vrm", "the collision answer, not the limit one");
});

// @spec DASH-MDL-018
test("the stored name is the last path segment, NFC, without .vrm, outside-grammar characters as _, a letter or digit first, 76-character stem, model when empty", async (t) => {
  const r = await rig(t, {});
  const cases: [string, string][] = [
    ["Aiko.vrm", "Aiko.vrm"], ["my model.VRM", "my model.vrm"], ["a/b/Deep.vrm", "Deep.vrm"], ["../../etc/passwd", "passwd.vrm"], ["noext", "noext.vrm"],
    ["héllo.vrm", "h_llo.vrm"], ["__x.vrm", "x.vrm"], ["-.-y.vrm", "y.vrm"], [".vrm", "model.vrm"],
    ["é.vrm", "model.vrm"], ["a.b.vrm.VRM", "a.b.vrm.vrm"], ["wei rd!@#$.vrm", "wei rd____.vrm"], [`${"x".repeat(100)}.vrm`, `${"x".repeat(76)}.vrm`],
  ];
  const seen: string[] = [];
  for (const [input, expected] of cases) {
    const bytes = model(String(seen.length));
    const res = await up(r, `?name=${encodeURIComponent(input)}&replace=1`, bytes);
    assert.equal(res.status, 201, `${input}: ${res.text}`);
    const got = res.json().model.name as string;
    assert.equal(got, expected, JSON.stringify(input));
    assert.ok(got.length <= 80);
    seen.push(got);
  }
  assert.ok(existsSync(join(r.models, `${"x".repeat(76)}.vrm`)));
});

// @spec DASH-MDL-019
test("a stored name (ASCII case aside) without replace=1 is 409 naming the stored model and stores nothing; with replace=1 the stored file keeps its name", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("old") } });
  const res = await up(r, "?name=AIKO.vrm", model("new"));
  assert.equal(res.status, 409);
  assert.deepEqual([res.json().ok, typeof res.json().detail, res.json().name], [false, "string", "Aiko.vrm"]);
  assert.deepEqual(readFileSync(join(r.models, "Aiko.vrm")), model("old"));
  assert.deepEqual(r.ls(), ["Aiko.vrm"]);
  const rep = await up(r, "?name=AIKO.vrm&replace=1", model("new"));
  assert.equal(rep.status, 201);
  assert.equal(rep.json().model.name, "Aiko.vrm");
  assert.deepEqual(r.ls(), ["Aiko.vrm"], "no second file in another case");
  assert.deepEqual(readFileSync(join(r.models, "Aiko.vrm")), model("new"));
});

// @spec DASH-MDL-020
test("20 stored models refuse a new name with 409 and no model field, a replace still goes through", async (t) => {
  const seed: Record<string, Buffer> = {};
  for (let i = 0; i < 20; i++) seed[`m${String(i).padStart(2, "0")}.vrm`] = model(String(i));
  const r = await rig(t, { seed });
  const res = await up(r, "?name=extra.vrm", model("x"));
  assert.equal(res.status, 409);
  assert.equal(res.json().ok, false);
  assert.equal(typeof res.json().detail, "string");
  assert.equal("name" in res.json(), false);
  assert.equal(r.ls().length, 20);
  assert.equal((await up(r, "?name=m05.vrm&replace=1", model("again"))).status, 201);
  assert.equal(r.ls().length, 20);
});

// @spec DASH-MDL-020
test("a total of stored bytes past 2 GiB refuses an upload, a replace is judged by the total it leaves, and the total is checked again at the end of a body with no Content-Length", async (t) => {
  const r = await rig(t, { seed: { "Big.vrm": model("big"), "Small.vrm": model("small") } });
  truncateSync(join(r.models, "Big.vrm"), 2147483648 - 20_000); // sparse; its head is intact
  const bytes = modelOfSize(40_000);
  const res = await up(r, "?name=New.vrm", bytes);
  assert.equal(res.status, 409, "declared size pushes the total past the limit");
  assert.equal(res.json().ok, false);
  assert.equal("name" in res.json(), false);
  assert.deepEqual(r.ls(), ["Big.vrm", "Small.vrm"]);
  const rep = await up(r, "?name=Big.vrm&replace=1", bytes);
  assert.equal(rep.status, 201, "replacing the big file leaves a small total");
  truncateSync(join(r.models, "Big.vrm"), 2147483648 - 20_000);
  const late = await up(r, "?name=Late.vrm", bytes, { chunked: true });
  assert.equal(late.status, 409, "no Content-Length: refused at the end of the body");
  assert.deepEqual(incoming(r), [], "the temporary file is removed");
  assert.equal(r.ls().includes("Late.vrm"), false);
});

// @spec DASH-MDL-021
test("a body over dashboard.models.max_bytes is cut at the first byte over: 413, connection closed, temporary file removed, with or without Content-Length", async (t) => {
  const r = await rig(t, { maxBytes: MiB });
  const exact = await up(r, "?name=Exact.vrm", modelOfSize(MiB), { chunked: true });
  assert.equal(exact.status, 201, "a body of exactly the cap is accepted");
  const over = modelOfSize(MiB + 4);
  const noLength = await up(r, "?name=Over.vrm", over, { chunked: true });
  assert.equal(noLength.status, 413);
  const declared = await up(r, "?name=Over2.vrm", over);
  assert.equal(declared.status, 413);
  assert.deepEqual(names(r), ["Exact.vrm"]);
  assert.deepEqual(incoming(r), []);
  // An endless body is cut: the server answers 413 while the client is still sending.
  const h = open(r.port, "POST", "/avatar/models?name=Endless.vrm", {});
  // The head declares a JSON chunk of 2 MiB, so no head is judged before the cap: the zeros after the first 100 bytes are never parsed.
  const endless = glb({ asset: { version: "2.0" }, extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } }, { bin: 0, jsonLen: 2 * MiB });
  h.write(endless.subarray(0, 100));
  const chunk = Buffer.alloc(64 * 1024);
  let sent = 0;
  const pump = setInterval(() => { for (let i = 0; i < 8; i++) { h.write(chunk); sent += chunk.length; } }, 1);
  const res = await Promise.race([h.done, new Promise<null>((ok) => setTimeout(() => ok(null), ANSWER_CAP_MS))]);
  clearInterval(pump);
  h.destroy();
  assert.notEqual(res, null, "answered while the body was still arriving");
  assert.equal(res!.status, 413);
  assert.ok(sent < 64 * MiB, "the client was not left to send the whole stream");
  assert.deepEqual(incoming(r), []);
});

// @spec DASH-MDL-022
test("the body goes to .incoming-<16 hex> in the model folder, and a large upload is not held in memory", async (t) => {
  // The write seam counts the bytes waiting in writeChunk: at most the head and one body chunk (DASH-MDL-022).
  let inflight = 0;
  let peak = 0;
  const r = await rig(t, {
    maxBytes: 80 * MiB,
    writeChunk: async (fh, c) => {
      inflight += c.length;
      peak = Math.max(peak, inflight);
      try {
        for (let off = 0; off < c.length;) off += (await fh.write(c, off, c.length - off)).bytesWritten;
      } finally { inflight -= c.length; }
    },
  });
  const total = 48 * MiB;
  const whole = modelOfSize(total);
  const h = open(r.port, "POST", "/avatar/models?name=Large.vrm", { ...r.auth, "content-length": String(total) });
  const opened = r.tempOpened();
  h.write(whole.subarray(0, HEAD_BYTES));
  await opened;
  assert.match(incoming(r)[0] ?? "", /^\.incoming-[0-9a-f]{16}$/);
  const baseline = process.memoryUsage().rss;
  let peakRss = baseline;
  const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  const piece = 256 * 1024;
  for (let off = HEAD_BYTES; off < total; off += piece) {
    if (!h.write(whole.subarray(off, Math.min(total, off + piece)))) await new Promise((ok) => h.req.once("drain", ok));
  }
  h.end();
  const res = await h.done;
  clearInterval(sample);
  assert.equal(res.status, 201);
  // Secondary: RSS also moves with the garbage collector and with the other tests of the same process, so only a gross growth
  // (a whole-file buffer would show in the write peak above first) is refused here.
  assert.ok(peakRss - baseline < 96 * MiB, `the process grew by ${((peakRss - baseline) / MiB).toFixed(0)} MiB while a ${total / MiB} MiB file streamed`);
  assert.equal(statSync(join(r.models, "Large.vrm")).size, total);
  assert.ok(peak <= 17 * MiB, `at most ${(peak / MiB).toFixed(1)} MiB waited in writeChunk at once`);
});

// @spec DASH-MDL-023
test("an upload that sends no byte for 30 s is aborted with 408, its temporary file removed and its slot freed", async (t) => {
  const r = await rig(t, {});
  const whole = model("slow", 4096);
  // The clock is faked before the upload starts, so its idle timer (a setTimeout) is made under the fake; the test drives it.
  mock.timers.enable({ apis: ["setTimeout"] });
  let h!: ReturnType<typeof open>;
  try {
    h = open(r.port, "POST", "/avatar/models?name=Slow.vrm", { ...r.auth, "content-length": String(whole.length) });
    const opened = r.tempOpened();
    h.write(whole.subarray(0, HEAD_BYTES));
    await opened;
    assert.equal(incoming(r).length, 1);
    mock.timers.tick(29_000);
    await tick(10);
    assert.equal(incoming(r).length, 1, "still open at 29 s");
    mock.timers.tick(1_500);
    await tick(20);
  } finally { mock.timers.reset(); }
  const res = await h.done;
  assert.equal(res.status, 408);
  assert.deepEqual(incoming(r), []);
  assert.equal((await up(r, "?name=Next.vrm", model("n"))).status, 201, "the slot is free");
});

// @spec DASH-MDL-024, DASH-MDL-025
test("a bad head is 400 JSON {ok:false, detail} as soon as it is read, the temporary file removed and the connection closed without the rest", async (t) => {
  const r = await rig(t, {});
  const ok = { extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } };
  const cases: Record<string, Buffer> = {
    magic: glb(ok, { magic: "gltf", bin: 8 }),
    version: glb(ok, { version: 1, bin: 8 }),
    firstChunkNotJson: glb(ok, { chunkType: 0x004e4942, bin: 8 }),
    jsonOver16MiB: glb({}, { rawJson: "{}", jsonLen: 16 * MiB + 4 }),
    jsonInvalid: glb(null, { rawJson: "{nope", bin: 8 }),
    noVrmExtension: glb({ asset: { version: "2.0" } }, { bin: 8 }),
    vrmListedButAbsent: glb({ extensionsUsed: ["VRMC_vrm"], extensions: {} }, { bin: 8 }),
    requiredUnsupported: glb({ ...ok, extensionsRequired: ["KHR_materials_clearcoat"] }, { bin: 8 }),
    draco: glb({ ...ok, extensionsUsed: ["VRMC_vrm", "KHR_draco_mesh_compression"] }, { bin: 8 }),
    basisu: glb({ ...ok, extensionsUsed: ["VRMC_vrm", "KHR_texture_basisu"] }, { bin: 8 }),
    meshopt: glb({ ...ok, extensionsUsed: ["VRMC_vrm", "EXT_meshopt_compression"] }, { bin: 8 }),
    externalBuffer: glb({ ...ok, buffers: [{ byteLength: 8, uri: "file:///etc/passwd" }] }, { bin: 8 }),
    externalImage: glb({ ...ok, images: [{ uri: "https://example.test/t.png" }] }, { bin: 8 }),
    relativeImage: glb({ ...ok, images: [{ uri: "../t.png" }] }, { bin: 8 }),
  };
  for (const [why, head] of Object.entries(cases)) {
    const h = open(r.port, "POST", "/avatar/models?name=Bad.vrm", { ...r.auth });
    h.write(head.subarray(0, Math.min(head.length, 4 * MiB)));
    const res = await Promise.race([h.done, new Promise<null>((o) => setTimeout(() => o(null), ANSWER_CAP_MS))]);
    h.destroy();
    assert.notEqual(res, null, `${why}: answered without the rest of the body`);
    assert.equal(res!.status, 400, why);
    assert.equal(res!.json().ok, false, why);
    assert.equal(typeof res!.json().detail, "string", why);
    assert.match(String(res!.headers["connection"] ?? "close"), /close/i, why);
    assert.deepEqual(r.ls(), [], `${why}: nothing left behind`);
  }
});

// @spec DASH-MDL-026
test("every supported extension may be required and the upload is stored; data: URIs and the container's own chunk are embedded", async (t) => {
  const supported = ["VRM", "VRMC_vrm", "VRMC_springBone", "VRMC_node_constraint", "VRMC_materials_mtoon", "VRMC_materials_hdr_emissiveMultiplier", "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_texture_transform", "KHR_mesh_quantization", "EXT_texture_webp"];
  const r = await rig(t, {});
  const bytes = glb({ extensionsUsed: supported, extensionsRequired: supported, extensions: { VRMC_vrm: {} }, buffers: [{ byteLength: 8 }, { byteLength: 1, uri: "data:application/octet-stream;base64,AA==" }] }, { bin: 8 });
  assert.equal((await up(r, "?name=All.vrm", bytes)).status, 201);
});

// @spec DASH-MDL-027
test("a body shorter or longer than the header's total length is 400, the temporary file removed, nothing stored", async (t) => {
  const r = await rig(t, {});
  const whole = model("len", 64);
  assert.equal((await up(r, "?name=Short.vrm", whole.subarray(0, whole.length - 4))).status, 400);
  assert.equal((await up(r, "?name=Long.vrm", Buffer.concat([whole, Buffer.alloc(8)]))).status, 400);
  assert.equal((await up(r, "?name=Short2.vrm", whole.subarray(0, whole.length - 4), { chunked: true })).status, 400);
  assert.deepEqual(r.ls(), []);
  assert.equal((await up(r, "?name=Exact.vrm", whole)).status, 201);
});

// @spec DASH-MDL-028
test("without replace=1 the file is hard-linked and a name that appeared meanwhile is 409; with it the file is renamed over the old one; the temporary file is removed either way", async (t) => {
  const r = await rig(t, {});
  const held = await hold(r, "Race");
  writeFileSync(join(r.models, "Race.vrm"), "taken by hand"); // the derived name appears while the body streams
  const lost = await held.finish(held.whole.subarray(HEAD_BYTES));
  assert.equal(lost.status, 409);
  assert.equal(lost.json().name, "Race.vrm");
  assert.equal(readFileSync(join(r.models, "Race.vrm"), "utf8"), "taken by hand");
  assert.deepEqual(r.ls(), ["Race.vrm"]);

  assert.equal((await up(r, "?name=Fresh.vrm", model("fresh"))).status, 201);
  assert.equal(statSync(join(r.models, "Fresh.vrm")).nlink, 1, "the temporary name is gone");
  const before = statSync(join(r.models, "Fresh.vrm")).ino;
  assert.equal((await up(r, "?name=Fresh.vrm&replace=1", model("fresher"))).status, 201);
  assert.notEqual(statSync(join(r.models, "Fresh.vrm")).ino, before, "a new file took the name");
  assert.deepEqual(readFileSync(join(r.models, "Fresh.vrm")), model("fresher"));
  assert.deepEqual(incoming(r), []);
});

// @spec DASH-MDL-029
test("a stored upload is 201 {ok:true, model} with the list entry; a write failure is 500 {ok:false, detail} with no temporary file", async (t) => {
  const r = await rig(t, {});
  const res = await up(r, "?name=Aiko.vrm", model("a"));
  assert.equal(res.status, 201);
  assert.equal(res.json().ok, true);
  const entry = (await r.get("/avatar/models")).json().models.find((m: { name: string }) => m.name === "Aiko.vrm");
  assert.deepEqual(res.json().model, entry);
  if (process.getuid?.() === 0) return; // root ignores the permission bits
  chmodSync(r.models, 0o555);
  t.after(() => chmodSync(r.models, 0o755));
  const fail = await up(r, "?name=Other.vrm", model("o"));
  assert.equal(fail.status, 500);
  assert.equal(fail.json().ok, false);
  assert.equal(fail.json().detail, "EACCES", "the error code is carried, not the path");
  assert.deepEqual(incoming(r), []);
});

// @spec DASH-MDL-029
test("a full disk is 507 {ok:false, detail} and the temporary file is removed", async (t) => {
  // The write seam fails the first chunk with ENOSPC, the error a full disk gives: the head is good, so the write is reached.
  const r = await rig(t, { writeChunk: async () => { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); } });
  const res = await up(r, "?name=Full.vrm", model("f"));
  assert.equal(res.status, 507);
  assert.equal(res.json().ok, false);
  assert.match(res.json().detail, /ENOSPC/);
  assert.deepEqual(incoming(r), []);
  assert.deepEqual(r.ls(), []);
});

// @spec DASH-MDL-030
test("a client that drops the connection mid-upload leaves no temporary file and frees the slot", async (t) => {
  const r = await rig(t, {});
  const held = await hold(r, "Drop");
  held.drop();
  await untilRemoved(r, "the dropped upload");
  assert.deepEqual(incoming(r), []);
  assert.equal((await up(r, "?name=After.vrm", model("after"))).status, 201);
});

// @spec DASH-MDL-031
test("at start every .incoming-* file in the model folder is removed and nothing else", async (t) => {
  const r = await rig(t, { seed: { ".incoming-0123456789abcdef": Buffer.from("stale"), ".incoming-x": Buffer.from("stale"), "Keep.vrm": model("keep"), "notes.txt": Buffer.from("n") } });
  assert.deepEqual(r.ls(), ["Keep.vrm", "notes.txt"]);
});

// @spec DASH-MDL-032, DASH-AVR-027
test("a stored upload changes no setting and does not select the model", async (t) => {
  const r = await rig(t, { seed: { "Old.vrm": model("old") }, renderer: { model: "Old.vrm", zoom: 1.5 } });
  const cfg = readFileSync(r.cfgFile, "utf8");
  assert.equal((await up(r, "?name=New.vrm", model("new"))).status, 201);
  assert.equal(readFileSync(r.cfgFile, "utf8"), cfg);
  assert.equal((await r.get("/avatar/models")).json().active, "Old.vrm");
  assert.deepEqual((await r.get("/avatar/model")).body, model("old"));
});

// @spec DASH-HTTP-015
test("the upload body is not capped at 64 KiB while the JSON and text routes still are", async (t) => {
  const r = await rig(t, {});
  assert.equal((await up(r, "?name=Big.vrm", modelOfSize(MiB))).status, 201);
  const ctl = (n: number) => { const head = '{"cmd":"mute","pad":"'; const tail = '"}'; return send(r.port, "POST", "/control", { body: head + "x".repeat(n - head.length - tail.length) + tail }); };
  assert.equal((await ctl(64 * 1024)).status, 204);
  assert.equal((await ctl(64 * 1024 + 1)).status, 413);
});

// @spec DASH-MDL-028, DASH-MDL-019
test("a directory, a symbolic link and an upper-case .VRM entry holding the derived name are a 409 naming it, never a 500", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "mdl-clash-"));
  writeFileSync(join(outside, "target.vrm"), model("t"));
  const r = await rig(t, { folder: true, seed: { "Up.VRM": model("upper") } });
  mkdirSync(join(r.models, "Dir.vrm"));
  symlinkSync(join(outside, "target.vrm"), join(r.models, "Link.vrm"));
  for (const [query, derived] of [["Dir.vrm", "Dir.vrm"], ["Link.vrm", "Link.vrm"], ["up.vrm", "up.vrm"]] as const) {
    const res = await up(r, `?name=${query}`, model(query));
    assert.equal(res.status, 409, `${query}: ${res.text}`);
    assert.equal(res.json().ok, false);
    assert.equal(res.json().name, derived, query);
    assert.deepEqual(incoming(r), [], `${query}: temporary file removed`);
  }
  assert.deepEqual(r.ls(), ["Dir.vrm", "Link.vrm", "Up.VRM"], "nothing was written or replaced");
  assert.equal(readFileSync(join(r.models, "Up.VRM")).equals(model("upper")), true);
});

// @spec DASH-MDL-021
test("a header whose total length passes dashboard.models.max_bytes is refused 413 as soon as the head is read", async (t) => {
  const r = await rig(t, { maxBytes: MiB });
  const big = glb({ asset: { version: "2.0" }, extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } }, { bin: 2 * MiB });
  const h = open(r.port, "POST", "/avatar/models?name=Huge.vrm", r.auth);
  h.write(big.subarray(0, 512)); // the head only: the rest is never sent
  const res = await Promise.race([h.done, new Promise<null>((ok) => setTimeout(() => ok(null), ANSWER_CAP_MS))]);
  h.destroy();
  assert.notEqual(res, null, "answered without the rest of the body");
  assert.equal(res!.status, 413);
  assert.deepEqual(r.ls(), []);
});
