// The TypeScript lint's configuration (deployment design, "Linting"): `.oxlintrc.json`'s rule set, the tsconfig files that
// give tsgolint the project's compiler options for test files, the inline-disable rule, and that a finding fails the lint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { readRepo, repoRoot } from "./helpers/mise.js";

type Severity = "off" | "warn" | "error";
type RuleSetting = Severity | [Severity, ...unknown[]];
interface OxlintConfig {
  options?: { reportUnusedDisableDirectives?: Severity };
  plugins?: string[];
  categories?: Record<string, Severity>;
  rules?: Record<string, RuleSetting>;
  overrides?: { files: string[]; rules?: Record<string, RuleSetting> }[];
}

/** JSON with whole-line `//` comments, the form the repository's tsconfig and oxlint files use. */
const parseJsonc = (text: string): unknown => JSON.parse(text.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n"));
const severity = (r: RuleSetting): Severity => (Array.isArray(r) ? r[0] : r);

const RC = ".oxlintrc.json";
const rcText = readRepo(RC);
const rc = parseJsonc(rcText) as OxlintConfig;
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);

// @spec DEPLOY-LINT-001
test(".oxlintrc.json is the only oxlint configuration and turns on four plugins and two categories as errors", () => {
  const configs = tracked.filter((f) => /(^|\/)\.?oxlintrc(\.[a-z]+)?$|(^|\/)oxlint\.config\.[a-z]+$/.test(f));
  assert.deepEqual(configs, [RC]);
  assert.deepEqual([...(rc.plugins ?? [])].sort(), ["eslint", "oxc", "typescript", "unicorn"]);
  assert.deepEqual(rc.categories, { correctness: "error", suspicious: "error" });
});

// @spec DEPLOY-LINT-002
test("the promise rules are errors, no override turns them off, and node:test's test functions are known-safe calls", () => {
  const rules = rc.rules ?? {};
  const PROMISE_RULES = ["typescript/no-floating-promises", "typescript/no-misused-promises", "typescript/only-throw-error", "typescript/prefer-promise-reject-errors"];
  for (const r of PROMISE_RULES) {
    assert.ok(rules[r], `${r} is set`);
    assert.equal(severity(rules[r]), "error", r);
  }
  for (const o of rc.overrides ?? []) {
    for (const r of PROMISE_RULES) {
      const set = o.rules?.[r];
      if (set !== undefined) assert.notEqual(severity(set), "off", `${o.files.join(",")} turns ${r} off`);
    }
  }
  const floating = rules["typescript/no-floating-promises"];
  assert.ok(Array.isArray(floating));
  const safe = (floating[1] as { allowForKnownSafeCalls?: { from: string; package?: string; name: string | string[] }[] }).allowForKnownSafeCalls ?? [];
  const fromNodeTest = safe.filter((s) => s.from === "package" && s.package === "node:test").flatMap((s) => (Array.isArray(s.name) ? s.name : [s.name]));
  assert.deepEqual(fromNodeTest.sort(), ["after", "afterEach", "before", "beforeEach", "describe", "it", "suite", "test"]);
});

/** Rules set to `off` (`"off"` or `["off", …]`) in `.oxlintrc.json` with no `//` comment above them (over a run of `off` lines). */
function offRulesWithoutReason(text: string): string[] {
  const lines = text.split("\n");
  const isOff = (l: string): boolean => /^\s*"[^"]+":\s*(\[\s*)?"off"/.test(l);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (!isOff(line)) return;
    let k = i - 1;
    while (k >= 0 && isOff(lines[k]!)) k--;
    if (k < 0 || !lines[k]!.trimStart().startsWith("//")) out.push(/"([^"]+)"/.exec(line)![1]!);
  });
  return out;
}

// @spec DEPLOY-LINT-003
test("no rule is a warning, and each rule turned off carries its reason", () => {
  const all = [rc.rules ?? {}, ...(rc.overrides ?? []).map((o) => o.rules ?? {})];
  for (const rules of all) for (const [name, r] of Object.entries(rules)) assert.notEqual(severity(r), "warn", `${name} is a warning`);
  for (const sev of Object.values(rc.categories ?? {})) assert.notEqual(sev, "warn");
  assert.deepEqual(offRulesWithoutReason(rcText), []);
  assert.ok(Object.values(rc.rules ?? {}).some((r) => severity(r) === "off"), "the check above saw the rules turned off");
  assert.deepEqual(offRulesWithoutReason('{\n  "rules": {\n    "a/x": "error",\n    "a/y": "off"\n  }\n}'), ["a/y"], "a bare off is caught");
  assert.deepEqual(offRulesWithoutReason('{\n    // why\n    "a/y": "off",\n    "a/z": "off"\n}'), [], "one comment covers a run of offs");
  assert.deepEqual(offRulesWithoutReason('{\n    "a/x": "error",\n    "a/y": ["off", { "k": 1 }]\n}'), ["a/y"], "the array form is caught");
});

// @spec DEPLOY-LINT-004
test("each test directory has a tsconfig.json with the project's compiler options", () => {
  const dirs = ["packages", "services"].flatMap((top) =>
    readdirSync(join(repoRoot, top), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(repoRoot, top, d.name, "test"))).map((d) => `${top}/${d.name}/test`));
  assert.ok(dirs.length > 10, "the check saw the test directories");
  for (const dir of [...dirs, "services/dashboard/test/ui"]) {
    const file = `${dir}/tsconfig.json`;
    assert.ok(existsSync(join(repoRoot, file)), `${file} exists`);
    const ts = parseJsonc(readRepo(file)) as { extends?: string; include?: string[] };
    const want = dir === "services/dashboard/test/ui" ? "services/dashboard/ui/tsconfig.json" : "tsconfig.base.json";
    assert.equal(ts.extends && resolve(repoRoot, dir, ts.extends), resolve(repoRoot, want), `${file} extends ${want}`);
    assert.ok(ts.include?.includes("."), `${file} includes its directory`);
  }
});

// @spec DEPLOY-LINT-005
test("the root tsconfig.json is a solution file, and no tsconfig sets baseUrl", () => {
  const root = parseJsonc(readRepo("tsconfig.json")) as Record<string, unknown>;
  assert.deepEqual(root.files, []);
  assert.deepEqual(Object.keys(root).sort(), ["files", "references"]);
  const tsconfigs = tracked.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f));
  assert.ok(tsconfigs.length > 20);
  for (const f of tsconfigs) assert.doesNotMatch(readRepo(f), /"baseUrl"/, `${f} sets baseUrl`);
});

const base = parseJsonc(readRepo("tsconfig.base.json")) as { compilerOptions: Record<string, unknown> };

/** The `//` comment lines directly above `"<rule>":` in `.oxlintrc.json`, joined. */
const commentAbove = (rule: string): string => {
  const lines = rcText.split("\n");
  let i = lines.findIndex((l) => l.trimStart().startsWith(`"${rule}":`));
  assert.ok(i > 0, `${rule} is in ${RC}`);
  const out: string[] = [];
  while (--i >= 0 && lines[i]!.trimStart().startsWith("//")) out.unshift(lines[i]!.trim());
  return out.join(" ");
};

// @spec DEPLOY-LINT-008
test("tsconfig.base.json sets noImplicitReturns, and consistent-return stays off naming it as the check", () => {
  assert.equal(base.compilerOptions.noImplicitReturns, true);
  assert.equal(severity(rc.rules!["typescript/consistent-return"]!), "off");
  assert.match(commentAbove("typescript/consistent-return"), /noImplicitReturns/);
});

const DISABLE = ["oxlint", "disable"].join("-");
const ESLINT_DISABLE = ["eslint", "disable"].join("-");
/** Lines of `text` holding an inline disable comment (oxlint's or eslint's) that is not one next-line rule with a `--` reason. */
function badDisables(text: string): string[] {
  const ok = new RegExp(`^\\s*(//|/\\*|\\{/\\*)\\s*${DISABLE}-next-line [a-z-]+/[a-z0-9-]+ -- \\S`);
  return text.split("\n").filter((l) => (l.includes(DISABLE) || l.includes(ESLINT_DISABLE)) && !ok.test(l));
}

// @spec DEPLOY-LINT-006
test("every inline oxlint disable comment names one rule for the next line and gives a reason", () => {
  const code = tracked.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/.test(f));
  const found: string[] = [];
  for (const f of code) for (const l of badDisables(readRepo(f))) found.push(`${f}: ${l.trim()}`);
  assert.deepEqual(found, []);
  assert.deepEqual(badDisables(`  // ${DISABLE}-next-line eslint/no-new -- the constructor's throw is the check`), []);
  assert.equal(badDisables(`  // ${DISABLE}-next-line eslint/no-new`).length, 1, "no reason");
  assert.equal(badDisables(`  // ${DISABLE}-next-line eslint/no-new, eslint/no-shadow -- two`).length, 1, "two rules");
  assert.equal(badDisables(`/* ${DISABLE} */`).length, 1, "a whole-file disable");
  assert.equal(badDisables(`  x(); // ${ESLINT_DISABLE}-line react-hooks/exhaustive-deps`).length, 1, "an eslint directive");
  assert.equal(rc.options?.reportUnusedDisableDirectives, "error", "a disable comment that suppresses nothing fails the lint");
});

// @spec DEPLOY-LINT-007
test("a finding fails the lint, a warning included, and CI's lint step may not continue on error", () => {
  const oxlint = join(repoRoot, "node_modules/.bin/oxlint");
  const dir = mkdtempSync(join(tmpdir(), "cohost-lint-"));
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify({ plugins: ["eslint"], categories: {}, rules: { "eslint/no-debugger": "warn" } }));
  writeFileSync(join(dir, "clean.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "warned.ts"), "export function f(): void {\n  debugger;\n}\n");
  const run = (file: string) => spawnSync(oxlint, ["--deny-warnings", "-c", join(dir, ".oxlintrc.json"), join(dir, file)], { cwd: dir, encoding: "utf8" });
  assert.equal(run("clean.ts").status, 0, "a clean file passes");
  assert.notEqual(run("warned.ts").status, 0, "a warning fails under --deny-warnings");
  writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify({ options: { reportUnusedDisableDirectives: "error" }, plugins: ["eslint"], categories: {}, rules: { "eslint/no-debugger": "error" } }));
  writeFileSync(join(dir, "unused.ts"), `// ${DISABLE}-next-line eslint/no-debugger -- nothing to suppress\nexport const y = 2;\n`);
  assert.notEqual(run("unused.ts").status, 0, "a disable comment that suppresses nothing fails");
  assert.equal(run("clean.ts").status, 0, "a clean file passes under the same config, so the failure is the unused directive");

  const wf = parseYaml(readRepo(".github/workflows/test.yml")) as { jobs: Record<string, { steps: { run?: string; "continue-on-error"?: unknown }[]; "continue-on-error"?: unknown }> };
  const lintJobs = Object.values(wf.jobs).filter((j) => j.steps.some((s) => s.run === "mise run lint"));
  assert.equal(lintJobs.length, 1, "one job runs mise run lint");
  const job = lintJobs[0]!;
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.steps.find((s) => s.run === "mise run lint")!["continue-on-error"], undefined);
});
