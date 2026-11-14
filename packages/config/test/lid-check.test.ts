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

const WF = ".github/workflows/w.yml";
const wf = (...steps: string[]) => `jobs:\n  j:\n    steps:\n${steps.map((s) => `      - ${s}`).join("\n")}\n`;

// @spec DEPLOY-CI-009
test("a workflow action pinned to a floating major, a branch or nothing fails with its file and line", () => {
  for (const ref of ["actions/checkout@v4", "actions/checkout@main", "actions/checkout", "actions/checkout@v4.1"]) {
    const r = run({ [WF]: wf(`uses: ${ref}`) });
    assert.equal(r.code, 1, ref);
    assert.match(r.err, /\.github\/workflows\/w\.yml:4: .*not pinned to an exact/, ref);
  }
  const ok = run({ [WF]: wf("uses: actions/checkout@v7.0.1", `uses: x/y@${"a".repeat(40)} # v2.6.1`, "uses: ./local-action") });
  assert.equal(ok.code, 0, ok.err);
});

// @spec DEPLOY-CI-009
test("one action pinned to two different refs across workflows fails", () => {
  const r = run({ [WF]: wf("uses: actions/checkout@v7.0.1"), ".github/workflows/z.yml": wf("uses: actions/checkout@v7.0.2") });
  assert.equal(r.code, 1);
  assert.match(r.err, /actions\/checkout is pinned to v7\.0\.2 but .*w\.yml:4 pins v7\.0\.1/);
});

// @spec DEPLOY-CI-009
test("a workflow or Compose image tagged latest, untagged or with a floating major fails; a defaulted exact tag passes", () => {
  for (const image of ["redis:latest", "redis", "redis:7", "pgvector/pgvector:pg16", "${IMG:-ghcr.io/a/b:latest}"]) {
    const w = run({ [WF]: `services:\n  s:\n    image: ${image}\n` });
    assert.equal(w.code, 1, image);
    assert.match(w.err, /not pinned to an exact x\.y\.z tag/, image);
    const c = run({ "docker-compose.yml": `services:\n  s:\n    image: ${image}\n` });
    assert.equal(c.code, 1, `compose ${image}`);
  }
  const ok = run({ "docker-compose.yml": "services:\n  a:\n    image: redis:7.4.12-alpine   # held\n  b:\n    image: ${IMG:-ghcr.io/a/b:v0.10.0}\n" });
  assert.equal(ok.code, 0, ok.err);
});

// @spec DEPLOY-CI-006
test("Rust and Cargo.toml @spec citations are read and target/ is skipped", () => {
  const specs = spec("- [x] **X-ONE-001**: a.");
  const ok = run({ [SPECS]: specs, "crates/a/src/lib.rs": `// ${AT} X-ONE-001\n`, "crates/a/Cargo.toml": `# ${AT} X-ONE-001\n` });
  assert.equal(ok.code, 0, ok.err);
  const bad = run({ [SPECS]: specs, "crates/a/src/lib.rs": `// ${AT} X-NO` + `PE-009\n`, "crates/a/Cargo.toml": `# ${AT} X-NO` + `PE-008\n` });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /lib\.rs:1: @.pec X-NOPE-009/);
  assert.match(bad.err, /Cargo\.toml:1: @.pec X-NOPE-008/);
  const skipped = run({ [SPECS]: specs, "target/debug/build/x.rs": `// ${AT} X-NO` + `PE-009\n` });
  assert.equal(skipped.code, 0, skipped.err);
});

// @spec DEPLOY-IMG-001
test("a Dockerfile rust: tag that differs from rust-toolchain.toml fails; a match passes", () => {
  const toolchain = '[toolchain]\nchannel = "1.99.1"\n';
  const ok = run({ "rust-toolchain.toml": toolchain, Dockerfile: "FROM rust:1.99.1-slim-bookworm AS native\n" });
  assert.equal(ok.code, 0, ok.err);
  const bad = run({ "rust-toolchain.toml": toolchain, Dockerfile: "FROM rust:1.98.0-slim-bookworm AS native\n" });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Dockerfile:1: rust:1\.98\.0 does not match the 1\.99\.1 channel/);
});
