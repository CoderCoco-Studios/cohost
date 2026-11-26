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

const SHA = "0123456789abcdef0123456789abcdef01234567";

// @spec DEPLOY-CI-010
test("a Compose build context that is a Git URL fails unless its ref is a full 40-character commit SHA, naming the file and line", () => {
  const compose = (ctx: string) => `services:\n  a:\n    build:\n      context: ${ctx}\n`;
  for (const ctx of ["https://github.com/o/r.git#v4.0.1", "https://github.com/o/r.git#main", "https://github.com/o/r.git", `https://github.com/o/r.git#${SHA.slice(0, 12)}`, `https://github.com/o/r.git#${SHA}0`, `https://github.com/o/r.git#${SHA.toUpperCase()}`]) {
    const r = run({ "docker-compose.yml": compose(ctx) });
    assert.equal(r.code, 1, ctx);
    assert.match(r.err, /docker-compose\.yml:4: .*full commit SHA/, ctx);
  }
  const short = run({ "docker-compose.yml": "services:\n  a:\n    build: https://github.com/o/r.git#main\n" });
  assert.equal(short.code, 1, "the short `build: <url>` form is judged too");
  assert.match(short.err, /docker-compose\.yml:3: /);
  for (const ok of [`https://github.com/o/r.git#${SHA}`, `https://github.com/o/r.git#${SHA}:sub/dir`, ".", "docker/stt-kyutai"]) {
    const r = run({ "docker-compose.yml": compose(ok) });
    assert.equal(r.code, 0, `${ok}: ${r.err}`);
  }
  assert.equal(run({ "docker-compose.yml": `services:\n  a:\n    build:\n      context: https://github.com/o/r.git#${SHA}   # v4.0.1\n` }).code, 0, "a trailing tag comment is not part of the ref");
  assert.equal(run({}, repoRoot).code, 0, "the repository's own Compose files pass");
});

const dockerfile = (...l: string[]) => ({ "docker/x/Dockerfile": l.join("\n") + "\n" });

// @spec DEPLOY-CI-011
test("a cargo install in a Dockerfile under docker/ fails without an exact =x.y.z version or without --locked, naming file and line", () => {
  for (const line of ["RUN cargo install moshi-server --locked", "RUN cargo install moshi-server --version ^0.6 --locked", "RUN cargo install moshi-server --version 0.6.4", "RUN cargo install moshi-server --version =0.6.4"]) {
    const r = run(dockerfile("FROM nvidia/cuda:12.8.1-devel-ubuntu24.04", line));
    assert.equal(r.code, 1, line);
    assert.match(r.err, /docker\/x\/Dockerfile:2: /, line);
  }
  for (const line of ["RUN cargo install moshi-server --version =0.6.4 --locked", "RUN cargo install --locked --version =0.6.4 moshi-server"]) {
    const r = run(dockerfile("FROM nvidia/cuda:12.8.1-devel-ubuntu24.04", line));
    assert.equal(r.code, 0, `${line}: ${r.err}`);
  }
});

// @spec DEPLOY-CI-011
test("a FROM in a Dockerfile under docker/ fails when its tag is missing, latest or not an exact version; stage names and exact tags pass", () => {
  for (const from of ["FROM ubuntu", "FROM ubuntu:latest", "FROM ubuntu:24.04", "FROM nvidia/cuda:12.8-devel", "FROM nvidia/cuda:latest-devel", "FROM ubuntu:noble"]) {
    const r = run(dockerfile(from));
    assert.equal(r.code, 1, from);
    assert.match(r.err, /docker\/x\/Dockerfile:1: /, from);
  }
  const ok = run(dockerfile("FROM nvidia/cuda:12.8.1-devel-ubuntu24.04 AS build", "FROM nvidia/cuda:12.8.1-runtime-ubuntu24.04", "FROM build AS final"));
  assert.equal(ok.code, 0, ok.err);
  assert.equal(run({ Dockerfile: "FROM ubuntu:24.04\n" }).code, 0, "a Dockerfile outside docker/ is not judged by this rule");
});

// @spec DEPLOY-CI-011
test("a git clone or an ADD of a Git URL under docker/ fails unless its source is a full 40-character commit SHA, naming file and line", () => {
  const bad = [
    "RUN git clone https://github.com/o/r.git /src",
    "RUN git clone --branch v0.3.0 https://github.com/o/r.git /src",
    `RUN git clone https://github.com/o/r.git /src && git -C /src checkout ${SHA.slice(0, 12)}`,
    "ADD https://github.com/o/r.git#v0.3.0 /src",
    "ADD https://github.com/o/r.git /src",
    `ADD https://github.com/o/r.git#${SHA.slice(0, 7)} /src`,
  ];
  for (const line of bad) {
    const r = run(dockerfile("FROM ubuntu:24.04.1", line));
    assert.equal(r.code, 1, line);
    assert.match(r.err, /docker\/x\/Dockerfile:2: /, line);
  }
  const good = [
    `RUN git clone https://github.com/o/r.git /src && git -C /src checkout ${SHA}`,
    `ADD https://github.com/o/r.git#${SHA} /src`,
  ];
  for (const line of good) {
    const r = run(dockerfile("FROM ubuntu:24.04.1", line));
    assert.equal(r.code, 0, `${line}: ${r.err}`);
  }
  assert.equal(run({ Dockerfile: "FROM ubuntu:24.04.1\nRUN git clone https://github.com/o/r.git /src\n" }).code, 0, "outside docker/ is not judged");
  assert.equal(run({}, repoRoot).code, 0, "the repository's own Dockerfiles pass, docker/stt-nemotron/Dockerfile included");
});

// @spec DEPLOY-CI-010
test("a quoted Git build context is judged as its unquoted value: a short ref fails, a full SHA passes", () => {
  const compose = (ctx: string) => `services:\n  a:\n    build:\n      context: ${ctx}\n`;
  const bad = run({ "docker-compose.yml": compose(`"https://github.com/o/r.git#main"`) });
  assert.equal(bad.code, 1, "a quoted ref that is a branch fails");
  assert.match(bad.err, /docker-compose\.yml:4: /);
  assert.equal(run({ "docker-compose.yml": compose(`'https://github.com/o/r.git#${SHA}'`) }).code, 0, "a single-quoted full SHA passes");
});

// @spec DEPLOY-CI-011
test("a git clone's ref is the SHA it checks out: a full SHA elsewhere on the line, with no checkout of it, fails", () => {
  const r = run(dockerfile("FROM ubuntu:24.04.1", `RUN echo ${SHA} && git clone https://github.com/o/r.git /src`));
  assert.equal(r.code, 1, "the SHA is not a checkout target");
  assert.match(r.err, /docker\/x\/Dockerfile:2: /);
  assert.equal(run(dockerfile("FROM ubuntu:24.04.1", `RUN git clone https://github.com/o/r.git /src && git -C /src checkout ${SHA}`)).code, 0);
});

// @spec DEPLOY-CI-011
test("a FROM pinned by a sha256 digest passes without a tag; a digest that is not 64 hex characters falls back to the tag rule", () => {
  const digest = "sha256:" + "ab".repeat(32);
  assert.equal(run(dockerfile(`FROM ubuntu@${digest}`)).code, 0, "a full digest is a full pin");
  const short = run(dockerfile("FROM ubuntu@sha256:abc"));
  assert.equal(short.code, 1, "a short digest is not a pin");
  assert.match(short.err, /docker\/x\/Dockerfile:1: /);
});

const workflow = (...steps: string[]) => `name: w\non: [push]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps.join("\n")}\n`;

// @spec DEPLOY-CI-012
test("a workflow step that is an action or one mise run passes", () => {
  const ok = run({
    [WF]: workflow(
      "      - uses: actions/checkout@v7.0.1",
      "      - uses: jdx/mise-action@v5.3.0\n        with:\n          version: 2026.11.14\n          install_args: node",
      "      - run: mise run lint",
      "      - name: docs\n        run: MISE_TASK_RUN_AUTO_INSTALL=false mise run docs:build",
      "      - run: mise run --force test:rust-example",
      "      # a comment\n      - id: x\n        run: mise run bus:bench -- --runs 3",
    ),
  });
  assert.equal(ok.code, 0, ok.err);
});

// @spec DEPLOY-CI-012
test("a workflow step that runs anything else fails, naming the file and line", () => {
  const cases: [string, number][] = [
    ["      - run: pnpm install --frozen-lockfile", 7],
    ["      - uses: actions/checkout@v7.0.1\n      - run: cargo test --workspace", 8],
    ["      - run: mise run lint && mise run test", 7],
    ["      - run: mise run lint; echo done", 7],
    ["      - name: two\n        run: |\n          mise run lint\n          mise run test", 7],
    ["      - run: sudo apt-get install -y libpulse-dev", 7],
    ["      - name: nothing", 7],
  ];
  for (const [step, line] of cases) {
    const r = run({ [WF]: workflow(step) });
    assert.equal(r.code, 1, step);
    assert.match(r.err, new RegExp(`w\\.yml:${line}: a workflow step must be a uses: action or a run: of exactly one mise run`), step);
  }
});

// @spec DEPLOY-CI-012
test("the one held step (the desktop helper's libpulse, until EARS-SRC-023) passes only in the test workflow, with that exact command", () => {
  const held = "      - name: held\n        run: sudo apt-get update && sudo apt-get install -y libpulse-dev pkg-config";
  assert.equal(run({ ".github/workflows/test.yml": workflow(held) }).code, 0);
  assert.equal(run({ ".github/workflows/other.yml": workflow(held) }).code, 1, "not in another workflow");
  assert.equal(run({ ".github/workflows/test.yml": workflow(`${held} cmake`) }).code, 1, "not with another package");
});
