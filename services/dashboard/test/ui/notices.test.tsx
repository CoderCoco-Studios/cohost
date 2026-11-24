// The UI build's third-party notices (DEPLOY-LIC-005 to DEPLOY-LIC-007): the pure part of the Vite plugin, which takes the
// bundled packages as data. Failing-first step of issue #218: `ui/notices.ts` does not exist yet (it also needs adding to
// `ui/tsconfig.json` `include`, like `dev-proxy.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { ALLOWED_LICENCES, isLicenceFile, licenceAllowed, buildNotices, manifestLicence, substituteNoticesName, type BundledPackage } from "../../ui/notices";

const MIT = "Permission is hereby granted, free of charge, to any person obtaining a copy\nof this software ...";
const pkg = (over: Partial<BundledPackage> = {}): BundledPackage => ({ name: "left-pad", version: "1.3.0", license: "MIT", workspace: false, files: [{ name: "LICENSE", text: MIT }], ...over });

// @spec DEPLOY-LIC-006
test("the allow-list is exactly the ten permissive identifiers", () => {
  assert.deepEqual([...ALLOWED_LICENCES].sort(), ["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BlueOak-1.0.0", "CC0-1.0", "ISC", "MIT", "Unlicense", "Zlib"]);
});

// @spec DEPLOY-LIC-006
test("a single allowed identifier is satisfied; any other, an empty, absent or non-SPDX value is not", () => {
  for (const id of ALLOWED_LICENCES) assert.equal(licenceAllowed(id), true, id);
  for (const bad of ["GPL-3.0-only", "AGPL-3.0-only", "LGPL-2.1-only", "MPL-2.0", "UNLICENSED", "SEE LICENSE IN LICENSE.md", "Custom", "", "   ", undefined, null]) {
    assert.equal(licenceAllowed(bad as string), false, String(bad));
  }
});

// @spec DEPLOY-LIC-006
test("an OR expression is satisfied when any alternative is allowed, an AND expression only when every part is", () => {
  assert.equal(licenceAllowed("(MIT OR GPL-3.0-only)"), true);
  assert.equal(licenceAllowed("MIT OR GPL-3.0-only"), true);
  assert.equal(licenceAllowed("(GPL-2.0-only OR GPL-3.0-only)"), false);
  assert.equal(licenceAllowed("(MIT AND ISC)"), true);
  assert.equal(licenceAllowed("(MIT AND GPL-3.0-only)"), false);
  assert.equal(licenceAllowed("MIT AND (ISC OR GPL-2.0-only)"), true);
  assert.equal(licenceAllowed("MIT AND (GPL-2.0-only OR GPL-3.0-only)"), false);
  assert.equal(licenceAllowed("(MIT OR Apache-2.0) AND BSD-3-Clause"), true);
  assert.equal(licenceAllowed("GPL-3.0-only OR (MIT AND ISC)"), true);
  assert.equal(licenceAllowed("(BSD-3-Clause AND MIT AND Zlib)"), true);
});

// @spec DEPLOY-LIC-006
test("a malformed expression is refused rather than guessed at", () => {
  for (const bad of ["(MIT", "MIT)", "MIT OR", "OR MIT", "MIT AND AND ISC", "()", "MIT ISC", "MIT or ISC garbage", "MIT WITH Foo"]) assert.equal(licenceAllowed(bad), false, bad);
});

// @spec DEPLOY-LIC-007
test("a licence file is one in the root named LICENSE, LICENCE, COPYING or NOTICE, in any case and with any extension", () => {
  for (const n of ["LICENSE", "LICENCE", "COPYING", "NOTICE", "license", "License.md", "LICENSE.txt", "licence.MD", "Copying.txt", "notice", "NOTICE.md", "LICENSE.markdown"]) assert.equal(isLicenceFile(n), true, n);
  for (const n of ["README.md", "package.json", "licensee.js", "LICENSES", "my-license", "NOTICES.txt", "LICENSE/x", "dist/LICENSE", "", "license-checker.json"]) assert.equal(isLicenceFile(n), false, n);
});

// @spec DEPLOY-LIC-005
test("each bundled third-party package gets an entry with name, version, licence expression and the full text of its licence files", () => {
  const { text, fileName } = buildNotices([
    pkg({ name: "three", version: "0.200.0", files: [{ name: "LICENSE", text: "THREE TEXT" }] }),
    pkg({ name: "@pixiv/three-vrm", version: "3.5.0", license: "(MIT OR Apache-2.0)", files: [{ name: "LICENSE", text: "VRM TEXT" }, { name: "NOTICE", text: "VRM NOTICE TEXT" }] }),
  ]);
  assert.match(text, /@pixiv\/three-vrm@3\.5\.0/);
  assert.match(text, /\(MIT OR Apache-2\.0\)/);
  for (const t of ["THREE TEXT", "VRM TEXT", "VRM NOTICE TEXT"]) assert.ok(text.includes(t), t);
  assert.match(text, /three@0\.200\.0/);
  assert.match(fileName, /^third-party-notices-[0-9a-f]{8}\.txt$/);
});

// @spec DEPLOY-LIC-005
test("the file name is the first 8 lowercase hex characters of the SHA-256 of the content, so a changed file has a new name", () => {
  const a = buildNotices([pkg()]);
  assert.equal(a.fileName, `third-party-notices-${createHash("sha256").update(a.text).digest("hex").slice(0, 8)}.txt`);
  const b = buildNotices([pkg({ version: "1.3.1" })]);
  assert.notEqual(a.fileName, b.fileName);
});

// @spec DEPLOY-LIC-005
test("the output is deterministic: the order the packages arrive in does not change the file", () => {
  const x = pkg({ name: "aaa" }), y = pkg({ name: "zzz" });
  assert.deepEqual(buildNotices([x, y]), buildNotices([y, x]));
});

// @spec DEPLOY-LIC-005
test("a package that is in the pnpm workspace has no entry, and no licence check", () => {
  const { text } = buildNotices([pkg(), pkg({ name: "@cohost/shared", version: "0.1.0", license: "AGPL-3.0-only", workspace: true, files: [] })]);
  assert.ok(!text.includes("@cohost/shared"));
  assert.ok(!text.includes("AGPL"));
});

// @spec DEPLOY-LIC-005
test("a package listed twice (two bundled versions or two bundle entries) appears once per name and version", () => {
  const { text } = buildNotices([pkg(), pkg()]);
  assert.equal(text.split("left-pad@1.3.0").length - 1, 1);
  const two = buildNotices([pkg(), pkg({ version: "2.0.0" })]).text;
  assert.ok(two.includes("left-pad@1.3.0") && two.includes("left-pad@2.0.0"));
});

// @spec DEPLOY-LIC-006
test("a bundled package whose licence no allowed identifier satisfies fails the build, naming the package and its licence", () => {
  assert.throws(() => buildNotices([pkg({ name: "copyleft-lib", version: "9.9.9", license: "GPL-3.0-only" })]), (e: Error) => /copyleft-lib/.test(e.message) && /GPL-3\.0-only/.test(e.message));
  assert.throws(() => buildNotices([pkg({ name: "mixed", license: "(MIT AND GPL-3.0-only)" })]), /mixed/);
});

// @spec DEPLOY-LIC-006
test("a bundled package with no licence expression fails the build, naming it", () => {
  assert.throws(() => buildNotices([pkg({ name: "no-expr", license: undefined })]), /no-expr/);
  assert.throws(() => buildNotices([pkg({ name: "blank-expr", license: "" })]), /blank-expr/);
});

// @spec DEPLOY-LIC-007
test("a bundled package with no licence file fails the build, naming it", () => {
  assert.throws(() => buildNotices([pkg({ name: "no-file", files: [] })]), (e: Error) => /no-file/.test(e.message));
  assert.throws(() => buildNotices([pkg({ name: "readme-only", files: [{ name: "README.md", text: "x" }] })]), /readme-only/);
  assert.throws(() => buildNotices([pkg({ name: "empty-file", files: [{ name: "LICENSE", text: "" }] })]), /empty-file/, "an empty licence file is no licence text");
});

// @spec DEPLOY-LIC-007
test("where a package has several licence files the entry holds all of them", () => {
  const { text } = buildNotices([pkg({ files: [{ name: "LICENSE", text: "FIRST-TEXT" }, { name: "COPYING.txt", text: "SECOND-TEXT" }, { name: "NOTICE.md", text: "THIRD-TEXT" }, { name: "README.md", text: "NOT-A-LICENCE" }] })]);
  for (const t of ["FIRST-TEXT", "SECOND-TEXT", "THIRD-TEXT"]) assert.ok(text.includes(t), t);
  assert.ok(!text.includes("NOT-A-LICENCE"));
});

// @spec DEPLOY-LIC-006
test("a manifest's licence is its license string or object type; the legacy licenses array is an AND of its entries, failing closed", () => {
  assert.equal(manifestLicence({ license: "MIT" }), "MIT");
  assert.equal(manifestLicence({ license: { type: "ISC" } }), "ISC");
  assert.equal(manifestLicence({ licenses: [{ type: "MIT" }, { type: "GPL-3.0-only" }] }), "MIT AND GPL-3.0-only");
  assert.equal(licenceAllowed(manifestLicence({ licenses: [{ type: "MIT" }, { type: "GPL-3.0-only" }] }) ?? ""), false);
  assert.equal(licenceAllowed(manifestLicence({ licenses: [{ type: "MIT" }, { type: "ISC" }] }) ?? ""), true);
  assert.equal(manifestLicence({}), undefined);
  assert.equal(manifestLicence({ licenses: [] }), undefined);
  assert.equal(manifestLicence({ licenses: [{}] }), undefined);
});

// @spec DASH-AVS-011
test("the sentinel literal is replaced as a whole string, and nothing that only resembles it (a member access, a key, a longer string) is touched", () => {
  const src = 'const B = "__COHOST_NOTICES_NAME__"; const g = globalThis.__COHOST_NOTICES__; const o = { __COHOST_NOTICES__: 1, ...x, __COHOST_NOTICES_NAME__: 2 }; const s = "a__COHOST_NOTICES_NAME__"; const q = \'__COHOST_NOTICES_NAME__\'; const t = `__COHOST_NOTICES_NAME__`;';
  const out = substituteNoticesName(src, "third-party-notices-abcd1234.txt");
  assert.equal(out, 'const B = "third-party-notices-abcd1234.txt"; const g = globalThis.__COHOST_NOTICES__; const o = { __COHOST_NOTICES__: 1, ...x, __COHOST_NOTICES_NAME__: 2 }; const s = "a__COHOST_NOTICES_NAME__"; const q = "third-party-notices-abcd1234.txt"; const t = "third-party-notices-abcd1234.txt";');
  assert.doesNotThrow(() => new Script(out), "the substituted script still parses");
});
