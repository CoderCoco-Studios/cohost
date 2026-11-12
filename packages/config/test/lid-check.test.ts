import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/lid-check.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Builds a throwaway repository from `files` (path -> text), runs the check on it and always removes it. */
function run(files: Record<string, string>, root?: string) {
  const dir = root ?? mkdtempSync(join(tmpdir(), "cohost-lid-"));
  try {
    if (!root) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(dir, path, ".."), { recursive: true });
        writeFileSync(join(dir, path), text);
      }
    }
    const r = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    if (!root) rmSync(dir, { recursive: true, force: true });
  }
}

// The marker is assembled so this file does not cite the fixture IDs itself.
const AT = "@" + "spec";
const SPECS = "docs/intent/x/x-specs.md";
const spec = (...lines: string[]) => lines.join("\n") + "\n";

// @spec DEPLOY-CI-006
test("a coherent tree passes", () => {
  const r = run({
    [SPECS]: spec("- [x] **X-ONE-001**: a.", "- [ ] **X-ONE-002**: b, see X-ONE-001."),
    "src/a.ts": `// ${AT} X-ONE-001, X-ONE-002\n`,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /2 specs defined, 0 problems/);
});

// @spec DEPLOY-CI-006
test("a @spec ID defined in no spec file fails and is named with its file and line", () => {
  const r = run({ [SPECS]: spec("- [x] **X-ONE-001**: a."), "src/a.ts": `const a = 1;\n// ${AT} X-ONE-001, X-ONE-009\n` });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/a\.ts:2: .* X-ONE-009 is defined in no spec file/);
});

// @spec DEPLOY-CI-006
test("an ID defined twice fails", () => {
  const r = run({ [SPECS]: spec("- [x] **X-ONE-001**: a.", "- [ ] **X-ONE-001**: again.") });
  assert.equal(r.code, 1);
  assert.match(r.err, /X-ONE-001 is defined twice/);
});

// @spec DEPLOY-CI-006
test("a spec file citing an ID that no spec file defines fails, unless its line says the ID is retired or moved", () => {
  const bad = run({ [SPECS]: spec("- [x] **X-ONE-001**: a, see X-GONE-004.") });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /X-GONE-004 is mentioned but defined in no spec file/);
  for (const note of ["X-GONE-004 is retired.", "Moved from X-GONE-004.", "Superseded X-GONE-004."]) {
    const ok = run({ [SPECS]: spec(`- [x] **X-ONE-001**: a. ${note}`) });
    assert.equal(ok.code, 0, `${note}: ${ok.err}`);
  }
});

// @spec DEPLOY-CI-006
test("an ID cited by code after its spec was deleted fails", () => {
  const r = run({ [SPECS]: spec("- [x] **X-ONE-001**: a."), "test/a.test.ts": `// ${AT} X-ONE-001\n// ${AT} X-ONE-002\n` });
  assert.equal(r.code, 1);
  assert.match(r.err, /X-ONE-002/);
});

// @spec DEPLOY-CI-006
test("the repository itself is coherent", () => {
  const r = run({}, repoRoot);
  assert.equal(r.code, 0, r.err);
});
