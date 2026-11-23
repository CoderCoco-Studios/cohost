import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glb, model, rig, send, texts, vrm0, vrm1, MiB } from "./models-rig.js";

// The model store: the folder and its name rules, serving, the list and the metadata (DASH-MDL-001..014).

const etagOfFile = (f: string): string => {
  const s = statSync(f, { bigint: true });
  return `W/"${s.size.toString(16)}-${(s.mtimeNs / 1_000_000n).toString(16)}"`;
};

// @spec DASH-MDL-002, DASH-MDL-003
test("only grammar-valid regular files are listed; a link, a directory, a bad or upper-case-extension name is never listed, opened or served", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "mdl-outside-"));
  writeFileSync(join(outside, "secret.vrm"), model("secret"));
  const r = await rig(t, { seed: { "Aiko.vrm": model("aiko"), "bad name!.vrm": model("b"), "noext": model("c"), ".hidden.vrm": model("d"), "UPPER.VRM": model("e"), [`${"x".repeat(78)}.vrm`]: model("f") } });
  symlinkSync(join(outside, "secret.vrm"), join(r.models, "link.vrm"));
  symlinkSync(join(r.models, "Aiko.vrm"), join(r.models, "alias.vrm"));
  mkdirSync(join(r.models, "dir.vrm"));
  const list = (await r.get("/avatar/models")).json();
  assert.deepEqual(list.models.map((m: { name: string }) => m.name), ["Aiko.vrm"], "a name over 80 characters, a link, a directory and the rest are absent");
  for (const n of ["link.vrm", "alias.vrm", "dir.vrm", "UPPER.VRM", "bad%20name!.vrm", ".hidden.vrm", "noext"]) assert.equal((await r.get(`/avatar/models/${n}`)).status, 404, n);
  assert.equal((await r.get("/avatar/models/Aiko.vrm")).status, 200);
  // two names that differ only in ASCII case are one name
  assert.equal((await r.get("/avatar/models/AIKO.vrm")).status, 200);
  assert.equal((await r.get("/avatar/models/aiko.vrm")).status, 200);
});

// @spec DASH-MDL-002, DASH-MDL-006, DASH-MDL-007
test("an applied model whose file is a symbolic link is not served", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "mdl-outside-"));
  writeFileSync(join(outside, "secret.vrm"), model("secret"));
  const r = await rig(t, { folder: true, renderer: { model: "link.vrm" } });
  symlinkSync(join(outside, "secret.vrm"), join(r.models, "link.vrm"));
  const res = await r.get("/avatar/model");
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.text, /link|secret/);
  const control = await rig(t, { seed: { "Real.vrm": model("real") }, renderer: { model: "Real.vrm" } });
  assert.equal((await control.get("/avatar/model")).status, 200, "the same name as a regular file is served");
});

// @spec DASH-MDL-004
test("GET and HEAD /avatar/model answer 200 with the model headers and the file streamed byte for byte", async (t) => {
  const bytes = model("body", 4096);
  const r = await rig(t, { seed: { "Aiko.vrm": bytes }, renderer: { model: "Aiko.vrm" } });
  utimesSync(join(r.models, "Aiko.vrm"), 1_700_000_000, 1_700_000_000.1239);
  const expected = etagOfFile(join(r.models, "Aiko.vrm"));
  const get = await r.get("/avatar/model");
  assert.equal(get.status, 200);
  assert.equal(get.headers["content-type"], "model/gltf-binary");
  assert.equal(get.headers["content-length"], String(bytes.length));
  assert.equal(get.headers["x-content-type-options"], "nosniff");
  assert.equal(get.headers["cache-control"], "no-cache");
  assert.equal(get.headers["etag"], expected);
  assert.match(expected, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
  assert.deepEqual(get.body, bytes);
  const head = await send(r.port, "HEAD", "/avatar/model");
  assert.equal(head.status, 200);
  assert.equal(head.headers["etag"], expected);
  assert.equal(head.headers["content-length"], String(bytes.length));
  assert.equal(head.body.length, 0);
});

// @spec DASH-MDL-005
test("If-None-Match naming the current etag, a list holding it, or * answers 304 with only etag and cache-control", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") }, renderer: { model: "Aiko.vrm" } });
  const etag = (await r.get("/avatar/model")).headers["etag"] as string;
  for (const inm of [etag, `W/"nope", ${etag}`, "*"]) {
    const res = await r.get("/avatar/model", { "if-none-match": inm });
    assert.equal(res.status, 304, inm);
    assert.equal(res.body.length, 0);
    assert.deepEqual(Object.keys(res.headers).filter((h) => ["etag", "cache-control", "content-type", "content-length", "x-content-type-options"].includes(h)).sort(), ["cache-control", "etag"], inm);
    assert.equal(res.headers["etag"], etag);
    assert.equal(res.headers["cache-control"], "no-cache");
  }
  assert.equal((await r.get("/avatar/model", { "if-none-match": 'W/"0-0"' })).status, 200);
});

// @spec DASH-MDL-006
test("no model applied, or an applied name with no file, is 404 JSON whose detail holds no file name", async (t) => {
  const none = await rig(t, { folder: true });
  const a = await none.get("/avatar/model");
  assert.equal(a.status, 404);
  assert.equal(a.json().ok, false);
  assert.equal(typeof a.json().detail, "string");
  const gone = await rig(t, { folder: true, renderer: { model: "Ghostly.vrm" } });
  const b = await gone.get("/avatar/model");
  assert.equal(b.status, 404);
  assert.equal(b.json().ok, false);
  assert.doesNotMatch(b.text, /Ghostly/i);
});

// @spec DASH-MDL-007
test("a request path never reaches a file: traversal, separators, NUL and odd encodings are 404 and the listing holds only the folder", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") } });
  writeFileSync(join(r.data, "dashboard", "outside.vrm"), model("outside"));
  for (const n of ["..%2Foutside.vrm", "%2e%2e%2foutside.vrm", "..%5Coutside.vrm", "Aiko.vrm%00", "Aiko.vrm%00.vrm", "%2FAiko.vrm", "Aiko.vrm/", "%E0%A4%A", "..", "."]) {
    const res = await r.get(`/avatar/models/${n}`);
    assert.equal(res.status, 404, n);
  }
  assert.equal((await r.get("/avatar/models")).json().models.length, 1);
});

// @spec DASH-MDL-008
test("GET /avatar/model is served on both listeners and needs no token in either control mode", async (t) => {
  for (const control of [false, true]) {
    const r = await rig(t, { control, seed: { "Aiko.vrm": model("a") }, renderer: { model: "Aiko.vrm" } });
    const full = await r.get("/avatar/model");
    assert.equal(full.status, 200, `full surface, control ${control}`);
    const lan = await r.lan("GET", "/avatar/model");
    assert.equal(lan.status, 200, `LAN listener, control ${control}`);
    assert.deepEqual(lan.body, full.body);
    assert.equal((await r.lan("HEAD", "/avatar/model")).status, 200);
  }
});

// @spec DASH-MDL-009
test("GET and HEAD /avatar/models/<name> serve a listed valid model as /avatar/model does, 304 included; an error model or a bad name is 404; the LAN listener answers 404", async (t) => {
  const good = model("good", 256);
  const r = await rig(t, { control: true, seed: { "Aiko.vrm": good, "Broken.vrm": glb({ asset: { version: "2.0" } }, { bin: 8 }) } });
  const res = await r.get("/avatar/models/Aiko.vrm"); // no token, control mode on
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "model/gltf-binary");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers["etag"], etagOfFile(join(r.models, "Aiko.vrm")));
  assert.deepEqual(res.body, good);
  assert.equal((await send(r.port, "HEAD", "/avatar/models/Aiko.vrm")).headers["etag"], res.headers["etag"]);
  assert.equal((await r.get("/avatar/models/Aiko.vrm", { "if-none-match": res.headers["etag"] as string })).status, 304);
  assert.equal((await r.get("/avatar/models/Broken.vrm")).status, 404, "listed with an error");
  assert.equal((await r.get("/avatar/models/Unknown.vrm")).status, 404);
  assert.equal((await r.get("/avatar/models/not%20a%20name")).status, 404);
  assert.equal((await r.lan("GET", "/avatar/models/Aiko.vrm")).status, 404);
  assert.equal((await r.lan("HEAD", "/avatar/models/Aiko.vrm")).status, 404);
});

// @spec DASH-MDL-010
test("GET /avatar/models answers the sorted list with the limits and the active name, no-store, ungated; the LAN listener answers 404", async (t) => {
  const r = await rig(t, { control: true, maxBytes: 5 * MiB, seed: { "b.vrm": model("b"), "A.vrm": model("a"), "c.vrm": model("c") }, renderer: { model: "b.vrm" } });
  const res = await r.get("/avatar/models");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  const j = res.json();
  assert.deepEqual(Object.keys(j).sort(), ["active", "maxBytes", "maxModels", "maxTotalBytes", "models"]);
  assert.deepEqual(j.models.map((m: { name: string }) => m.name), ["A.vrm", "b.vrm", "c.vrm"]);
  assert.equal(j.active, "b.vrm");
  assert.equal(j.maxBytes, 5 * MiB);
  assert.equal(j.maxModels, 20);
  assert.equal(j.maxTotalBytes, 2147483648);
  assert.equal((await r.lan("GET", "/avatar/models")).status, 404);
  const empty = await rig(t, {});
  const e = (await empty.get("/avatar/models")).json();
  assert.deepEqual([e.models, e.active, e.maxBytes], [[], null, 104857600]);
});

// @spec DASH-MDL-011, DASH-MDL-014
test("each entry carries name, bytes, modified, active, vrm, title, authors, license, usage, expressions; a file that fails its head check carries an error", async (t) => {
  const good = model("good", 64);
  const r = await rig(t, { seed: { "Good.vrm": good, "Bad.vrm": Buffer.from("not a glb at all") }, renderer: { model: "Good.vrm" } });
  utimesSync(join(r.models, "Good.vrm"), 1_700_000_000, 1_700_000_000);
  const { models } = (await r.get("/avatar/models")).json();
  const g = models.find((m: { name: string }) => m.name === "Good.vrm");
  for (const k of ["name", "bytes", "modified", "active", "vrm", "title", "authors", "license", "usage", "expressions"]) assert.ok(k in g, k);
  assert.equal("error" in g, false);
  assert.equal(g.bytes, good.length);
  assert.equal(g.modified, 1_700_000_000_000);
  assert.equal(g.active, true);
  const b = models.find((m: { name: string }) => m.name === "Bad.vrm");
  assert.equal(typeof b.error, "string");
  assert.ok(b.error.length > 0);
  assert.equal(b.active, false);
  assert.equal(b.bytes, "not a glb at all".length);
});

// @spec DASH-MDL-012
test("vrm is \"1\" for VRMC_vrm, \"0\" for VRM only and \"1\" for both; a JSON chunk over 16 MiB is an error; geometry is never read", async (t) => {
  const both = glb({ asset: { version: "2.0" }, extensionsUsed: ["VRM", "VRMC_vrm"], extensions: { VRM: { meta: { title: "t" } }, VRMC_vrm: { specVersion: "1.0", meta: { name: "n" } } } }, { bin: 8 });
  // A BIN chunk that declares more bytes than the file holds: only a reader that touches the geometry notices.
  const lyingBin = Buffer.concat([vrm1({ bin: 0 }).subarray(0, -8), Buffer.from([0xff, 0xff, 0xff, 0x7f, 0x42, 0x49, 0x4e, 0x00])]);
  const r = await rig(t, {
    seed: { "One.vrm": vrm1(), "Zero.vrm": vrm0(), "Both.vrm": both, "Huge.vrm": glb({}, { rawJson: "{}", jsonLen: 16 * MiB + 4 }), "Lying.vrm": lyingBin },
  });
  const by = Object.fromEntries((await r.get("/avatar/models")).json().models.map((m: { name: string }) => [m.name, m]));
  assert.equal(by["One.vrm"].vrm, "1");
  assert.equal(by["Zero.vrm"].vrm, "0");
  assert.equal(by["Both.vrm"].vrm, "1");
  assert.equal(typeof by["Huge.vrm"].error, "string");
  assert.equal("error" in by["Lying.vrm"], false, "the geometry is not read");
});

// @spec DASH-MDL-013
test("VRM 1.0 meta is normalised into title, authors, license, usage and expressions, strings cut at 500", async (t) => {
  const r = await rig(t, {
    seed: {
      "One.vrm": vrm1({
        meta: {
          name: "Aiko", authors: ["Ann", "Bob"], licenseUrl: "https://example.test/l", copyrightInformation: "(c) Ann", contactInformation: "ann@example.test",
          avatarPermission: "onlyAuthor", commercialUsage: "corporation", creditNotation: "required", modification: "prohibited", redistribution: "prohibited",
          allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: true, allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: true,
        },
        expressions: { preset: ["happy", "blink", "aa"], custom: ["wink"] },
      }),
      "Long.vrm": vrm1({ meta: { name: "N".repeat(900), authors: ["A".repeat(700)] } }),
    },
  });
  const by = Object.fromEntries((await r.get("/avatar/models")).json().models.map((m: { name: string }) => [m.name, m]));
  const e = by["One.vrm"];
  assert.ok(texts(e.title).includes("Aiko"));
  assert.ok(["Ann", "Bob"].every((a) => texts(e.authors).includes(a)));
  assert.ok(texts(e.license).some((s) => s.includes("https://example.test/l")), "the licence URL is carried as text");
  const usage = (label: string, value: string): boolean => (e.usage as unknown[]).some((u) => { const s = texts(u); return s.includes(label) && s.some((x) => x === value || x.includes(value)); });
  assert.ok(usage("Allowed users", "onlyAuthor"));
  assert.ok(usage("Commercial use", "corporation"));
  assert.ok(usage("Credit", "required"));
  assert.ok(usage("Modification", "prohibited"));
  assert.ok(usage("Redistribution", "prohibited"));
  assert.ok(usage("Violent use", "Not allowed"));
  assert.ok(usage("Sexual use", "Allowed"));
  assert.ok(usage("Political or religious use", "Not allowed"));
  assert.ok(usage("Antisocial or hateful use", "Allowed"));
  assert.deepEqual([...e.expressions].sort(), ["aa", "blink", "happy", "wink"]);
  const long = by["Long.vrm"];
  assert.ok(texts(long.title).every((s) => s.length <= 500) && texts(long.title).some((s) => s.length === 500), "title cut at 500");
  assert.ok(texts(long.authors).every((s) => s.length <= 500) && texts(long.authors).some((s) => s.length === 500), "an author cut at 500");
});

// @spec DASH-MDL-013
test("VRM 0.x meta is normalised the same way, presets map to their 1.0 names and a group with no preset keeps its own", async (t) => {
  const r = await rig(t, {
    seed: {
      "Zero.vrm": vrm0({
        meta: {
          title: "Old Aiko", author: "Cleo", licenseName: "Redistribution_Prohibited", otherLicenseUrl: "https://example.test/old", contactInformation: "c@example.test",
          allowedUserName: "OnlyAuthor", commercialUssageName: "Disallow", violentUssageName: "Allow", sexualUssageName: "Disallow",
        },
        groups: [
          { name: "Joy", presetName: "joy" }, { name: "Sorrow", presetName: "sorrow" }, { name: "Fun", presetName: "fun" }, { name: "A", presetName: "a" },
          { name: "I", presetName: "i" }, { name: "U", presetName: "u" }, { name: "E", presetName: "e" }, { name: "O", presetName: "o" },
          { name: "Blink_L", presetName: "blink_l" }, { name: "Blink_R", presetName: "blink_r" }, { name: "LookUp", presetName: "lookup" },
          { name: "Neutral", presetName: "neutral" }, { name: "Angry", presetName: "angry" }, { name: "Blink", presetName: "blink" },
          { name: "MyFace", presetName: "unknown" }, { name: "Plain" },
        ],
      }),
    },
  });
  const e = (await r.get("/avatar/models")).json().models[0];
  assert.ok(texts(e.title).includes("Old Aiko"));
  assert.ok(texts(e.authors).includes("Cleo"));
  assert.ok(texts(e.license).some((s) => s.includes("https://example.test/old")));
  assert.ok(texts(e.license).some((s) => s.includes("Redistribution_Prohibited")));
  const usage = (label: string, value: string): boolean => (e.usage as unknown[]).some((u) => { const s = texts(u); return s.includes(label) && s.includes(value); });
  assert.ok(usage("Allowed users", "OnlyAuthor"));
  assert.ok(usage("Commercial use", "Disallow"));
  assert.ok(usage("Violent use", "Allow"));
  assert.ok(usage("Sexual use", "Disallow"));
  assert.deepEqual([...e.expressions].sort(), ["MyFace", "Plain", "aa", "angry", "blink", "blinkLeft", "blinkRight", "ee", "happy", "ih", "lookUp", "neutral", "oh", "ou", "relaxed", "sad"].sort());
});

// @spec DASH-MDL-014, DASH-MDL-024, DASH-MDL-025, DASH-MDL-026
test("a file in the folder is listed with an error when its head fails the upload checks, and with none when it passes", async (t) => {
  const bad: Record<string, Buffer> = {
    "BadMagic.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } }, { magic: "gltf", bin: 4 }),
    "Version1.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } }, { version: 1, bin: 4 }),
    "FirstBin.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} } }, { chunkType: 0x004e4942, bin: 4 }),
    "NotJson.vrm": glb(null, { rawJson: "{not json", bin: 4 }),
    "NoVrm.vrm": glb({ asset: { version: "2.0" } }, { bin: 4 }),
    "NoObject.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: {} }, { bin: 4 }),
    "ReqUnknown.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensionsRequired: ["KHR_unknown_thing"], extensions: { VRMC_vrm: {} } }, { bin: 4 }),
    "Draco.vrm": glb({ extensionsUsed: ["VRMC_vrm", "KHR_draco_mesh_compression"], extensions: { VRMC_vrm: {} } }, { bin: 4 }),
    "Basis.vrm": glb({ extensionsUsed: ["VRMC_vrm", "KHR_texture_basisu"], extensions: { VRMC_vrm: {} } }, { bin: 4 }),
    "Meshopt.vrm": glb({ extensionsUsed: ["VRMC_vrm", "EXT_meshopt_compression"], extensions: { VRMC_vrm: {} } }, { bin: 4 }),
    "BufUri.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} }, buffers: [{ byteLength: 4, uri: "http://example.test/x.bin" }] }, { bin: 4 }),
    "ImgUri.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} }, images: [{ uri: "tex.png" }] }, { bin: 4 }),
  };
  const supported = ["VRM", "VRMC_vrm", "VRMC_springBone", "VRMC_node_constraint", "VRMC_materials_mtoon", "VRMC_materials_hdr_emissiveMultiplier", "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_texture_transform", "KHR_mesh_quantization", "EXT_texture_webp"];
  const good: Record<string, Buffer> = {
    "Supported.vrm": glb({ extensionsUsed: supported, extensionsRequired: supported, extensions: { VRMC_vrm: {} } }, { bin: 4 }),
    "DataUri.vrm": glb({ extensionsUsed: ["VRMC_vrm"], extensions: { VRMC_vrm: {} }, buffers: [{ byteLength: 4 }, { byteLength: 1, uri: "data:application/octet-stream;base64,AA==" }], images: [{ uri: "data:image/png;base64,AA==" }, { bufferView: 0 }] }, { bin: 4 }),
  };
  const r = await rig(t, { seed: { ...bad, ...good } });
  const by = Object.fromEntries((await r.get("/avatar/models")).json().models.map((m: { name: string }) => [m.name, m]));
  for (const n of Object.keys(bad)) assert.equal(typeof by[n]?.error, "string", `${n} is listed with an error`);
  for (const n of Object.keys(good)) assert.equal("error" in by[n], false, `${n} is listed without an error`);
});
