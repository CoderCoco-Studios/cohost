import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, posix, relative } from "node:path";
import { repoRoot } from "./helpers/docs-fixture.ts";
import { extendYamlFences, fences, fragmentProblem, layer, lockMismatches, tsFilesUnder, workspaceMembers } from "./helpers/docs-guides.ts";

const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const tsc = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");

/** Runs tsc from the repository root; returns its combined output and exit status. */
function runTsc(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [tsc, ...args], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

// ---------------------------------------------------------------- DOCS-GUIDE-010 (config fragments)

// @spec DOCS-GUIDE-010
test("a fragment is laid over config.example.yaml and parsed with ConfigSchema", () => {
  assert.equal(fragmentProblem(read("config/config.example.yaml"), "llm:\n  provider: mock\n"), null);
  assert.equal(fragmentProblem(read("config/config.example.yaml"), "llm:\n  provider: openai\n  openai:\n    base_url: http://host.docker.internal:8000/v1\n    api_key: x\n"), null);
  assert.match(fragmentProblem(read("config/config.example.yaml"), "llm:\n  provider: not-a-provider\n") ?? "", /llm\.provider/);
  assert.match(fragmentProblem(read("config/config.example.yaml"), "llm: [1]\n") ?? "", /llm/);
  assert.match(fragmentProblem(read("config/config.example.yaml"), "a: [unclosed\n") ?? "", /not valid YAML/);
});

// @spec DOCS-GUIDE-010
test("layering merges mappings key by key and replaces scalars and lists", () => {
  assert.deepEqual(layer({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] }), { a: { b: 1, c: 3 }, l: [9] });
  assert.deepEqual(layer({ a: { b: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(layer({ a: 1 }, { z: { y: 1 } }), { a: 1, z: { y: 1 } });
});

// @spec DOCS-GUIDE-010
test("placeholders resolve as the loader does with nothing set: a default is taken, none leaves the key to its schema default", () => {
  const real = read("config/config.example.yaml");
  assert.equal(fragmentProblem(real, "llm:\n  provider: ${NOT_SET:-mock}\n"), null);
  assert.equal(fragmentProblem(real, "llm:\n  provider: ${NOT_SET}\n"), null);
  assert.match(fragmentProblem(real, "llm:\n  provider: ${NOT_SET:-bogus}\n") ?? "", /llm\.provider/);
});

// @spec DOCS-GUIDE-010
test("every yaml fence of every Extend page parses with ConfigSchema laid over config.example.yaml", () => {
  const example = read("config/config.example.yaml");
  const failures = extendYamlFences(repoRoot).flatMap((f) => {
    const p = fragmentProblem(example, f.text);
    return p === null ? [] : [`${f.page}:${f.line}: ${p}`];
  });
  assert.deepEqual(failures, []);
});

test("the fence reader finds backtick and tilde fences with their opening line and language", () => {
  const f = fences("a\n```yaml\nx: 1\n```\n~~~YML{1}\ny: 2\n~~~\n```text\nz\n```\n");
  assert.deepEqual(f.map((x) => [x.line, x.lang, x.text]), [[2, "yaml", "x: 1"], [5, "yml", "y: 2"], [8, "text", "z"]]);
});

// ---------------------------------------------------------------- DOCS-GUIDE-025 (examples TypeScript project)

// @spec DOCS-GUIDE-025
test("examples/tsconfig.json includes every .ts file under examples/ and sets erasableSyntaxOnly and noEmit", () => {
  const shown = runTsc("-p", "examples/tsconfig.json", "--showConfig");
  assert.equal(shown.status, 0, shown.out);
  const options = (JSON.parse(shown.out) as { compilerOptions: Record<string, unknown> }).compilerOptions;
  assert.equal(options.erasableSyntaxOnly, true, "compilerOptions.erasableSyntaxOnly must be true");
  assert.equal(options.noEmit, true, "compilerOptions.noEmit must be true");

  const listed = runTsc("-p", "examples/tsconfig.json", "--listFilesOnly");
  assert.equal(listed.status, 0, listed.out);
  const inProject = new Set(
    listed.out.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => relative(repoRoot, l).split("\\").join("/"))
      .filter((l) => l.startsWith("examples/") && !l.split("/").includes("node_modules") && !l.endsWith(".d.ts")),
  );
  const onDisk = tsFilesUnder(repoRoot, "examples");
  assert.deepEqual(onDisk.filter((f) => !inProject.has(f)), [], "these .ts files are not in examples/tsconfig.json");
});

// @spec DOCS-GUIDE-025
test("the root tsconfig.json does not reference the examples project", () => {
  const refs = (JSON.parse(read("tsconfig.json")) as { references?: { path: string }[] }).references ?? [];
  const bad = refs.map((r) => posix.normalize(r.path.split("\\").join("/"))).filter((p) => p === "examples" || p.startsWith("examples/"));
  assert.deepEqual(bad, []);
});

// @spec DOCS-GUIDE-025
test("tsc -p examples/tsconfig.json reports no error", { timeout: 300_000 }, () => {
  const r = runTsc("-p", "examples/tsconfig.json");
  assert.equal(r.status, 0, `tsc -p examples/tsconfig.json failed:\n${r.out}`);
});

// ---------------------------------------------------------------- DOCS-GUIDE-026 (examples Cargo workspace)

const LOCK = (...pkgs: [string, string][]) => pkgs.map(([n, v]) => `[[package]]\nname = "${n}"\nversion = "${v}"\n`).join("\n");

// @spec DOCS-GUIDE-026
test("examples/Cargo.toml is a workspace of exactly modules/rust and rust-bus", () => {
  assert.deepEqual(workspaceMembers(read("examples/Cargo.toml")), ["modules/rust", "rust-bus"]);
});

// @spec DOCS-GUIDE-026
test("the root Cargo.toml names no path under examples/ as a workspace member", () => {
  const bad = workspaceMembers(read("Cargo.toml")).filter((m) => posix.normalize(m).startsWith("examples/") || posix.normalize(m) === "examples");
  assert.deepEqual(bad, []);
});

// @spec DOCS-GUIDE-026
test("examples/Cargo.lock is committed and holds every shared package at the root Cargo.lock's version", () => {
  assert.ok(existsSync(join(repoRoot, "examples/Cargo.lock")), "examples/Cargo.lock must exist");
  const ignored = spawnSync("git", ["check-ignore", "-q", "examples/Cargo.lock"], { cwd: repoRoot });
  assert.notEqual(ignored.status, 0, "examples/Cargo.lock must not be ignored by git");
  assert.deepEqual(lockMismatches(read("Cargo.lock"), read("examples/Cargo.lock")), []);
});

// @spec DOCS-GUIDE-026
test("the lock comparison reports a version that differs and ignores packages only one lock holds", () => {
  const root = LOCK(["serde", "1.0.200"], ["syn", "1.0.109"], ["syn", "2.0.60"], ["only-root", "1.0.0"]);
  assert.deepEqual(lockMismatches(root, LOCK(["serde", "1.0.200"], ["syn", "2.0.60"], ["only-examples", "9.0.0"])), []);
  assert.deepEqual(lockMismatches(root, LOCK(["serde", "1.0.199"], ["syn", "2.0.60"])), ["serde 1.0.199 (root Cargo.lock: 1.0.200)"]);
  assert.deepEqual(lockMismatches(root, LOCK(["syn", "3.0.0"])), ["syn 3.0.0 (root Cargo.lock: 1.0.109, 2.0.60)"]);
});

// @spec DOCS-GUIDE-026
test("the member reader handles single and multi-line arrays, comments and a later table", () => {
  assert.deepEqual(workspaceMembers('[workspace]\nresolver = "2"\nmembers = ["a", "b/*"]\n[profile.release]\nlto = true\n'), ["a", "b/*"]);
  assert.deepEqual(workspaceMembers('[workspace]\nmembers = [\n  "a", # one\n  "b",\n]\n'), ["a", "b"]);
  assert.deepEqual(workspaceMembers('[package]\nname = "x"\n'), []);
});

const hasCargo = spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;

// @spec DOCS-GUIDE-026
test("cargo build --manifest-path examples/Cargo.toml --workspace --all-targets succeeds", { skip: hasCargo ? false : "cargo is not installed", timeout: 900_000 }, () => {
  const r = spawnSync("cargo", ["build", "--manifest-path", "examples/Cargo.toml", "--workspace", "--all-targets"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `cargo build failed:\n${r.stdout}${r.stderr}`);
});
