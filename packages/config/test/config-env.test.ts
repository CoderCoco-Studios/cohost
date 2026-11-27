import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { parseConfigText, placeholderIssues, parseYaml, loadConfig } from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, captureWarnings, repo } from "./helpers/config-sandbox.js";

isolateEnv();

/** The placeholder issues a settings write of the YAML settings `yaml` is refused with, one `path: message` line each. */
const message = (yaml: string): string => {
  const issues = placeholderIssues(parseYaml(yaml));
  assert.ok(issues.length > 0, "expected the write to be refused");
  return issues.map((i) => `${i.path}: ${i.message}`).join("\n");
};

// @spec CFG-ENV-011
test("a ${VAR} or ${VAR:-default} placeholder refuses the write, naming the key (an array entry as path[index]), the variable and the literal to write", () => {
  const yaml = MINIMAL_YAML
    .replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"${TWITCH_CHANNEL}\" }, ignore_users: [ok, \"${BOT_NAME:-nightbot}\"] }")
    .replace("llm: { model: m, embed_model: e }", "llm: { model: \"${LLM_MODEL:-qwen}\", embed_model: e, openai: { api_key: \"${LLM_API_KEY}\" } }");
  const m = message(yaml);
  assert.equal(m.split("\n").length, 4, m);
  assert.match(m, /chat\.twitch\.channel: .*TWITCH_CHANNEL.*literal/);
  assert.match(m, /chat\.ignore_users\[1\]: .*BOT_NAME.*literal/);
  assert.match(m, /llm\.model: .*LLM_MODEL.*literal/);
  assert.match(m, /llm\.openai\.api_key: .*LLM_API_KEY.*credential/, "a secret key says to set it as a credential");
});

// @spec CFG-ENV-011
test("a placeholder is never substituted, a placeholder in a comment is not checked, and lower-case or malformed ones are literal text", () => {
  process.env.TWITCH_CHANNEL = "from-env";
  const text = `# channel: \${TWITCH_CHANNEL}\n${MINIMAL_YAML.replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"literal-${lower_case}-${A-B}\" } } # \\${COMMENTED}")}`;
  assert.deepEqual(placeholderIssues(parseYaml(text)), []);
  const r = parseConfigText(text);
  assert.ok(r.ok);
  assert.equal(r.config.chat.twitch.channel, "literal-${lower_case}-${A-B}");
  const e = parseConfigText(MINIMAL_YAML.replace("brain: {}", "brain: { salience: { barge_in_sources: [\"${X}\"] } }"));
  assert.equal(e.ok, false);
  assert.ok(!e.ok && e.issues.some((i) => i.path === "brain.salience.barge_in_sources[0]" && /\bX\b/.test(i.message)));
});

// ---- CFG-ENV-012: cohost source reads only the permitted environment variables

const ALLOWED = new Set([
  "COHOST_ISOLATION", "CONFIG_DIR", "COHOST_ENV_FILE", "COHOST_DATA_DIR", "COHOST_DOCKER_BIN", "COHOST_VERSION", "HEARTBEAT_INTERVAL_MS",
  "REDIS_URL", "DATABASE_URL", "OLLAMA_URL", "TTS_URL", "STT_URL", "VOICE_URL", "VOICE_PORT",
  "CONTROL_TOKEN", "CONTROL_ADVANCED", "DASHBOARD_HOST", "PATH", "HOSTNAME", "WSLENV", "NO_COLOR",
  "COHOST_KEY_FILE", "XDG_CONFIG_HOME", "COHOST_TEST_ENV", "EDITOR", "COHOST_CREDENTIALS_FD",
]);

/**
 * Reads still tolerated (`<file>::<NAME>`); empty. The test fails on a read that is neither allowed nor listed here, and on a
 * listed read that no longer exists.
 */
const PENDING = new Set<string>([
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // dist-ui is the UI build output (minified third-party code, not source): the scan reads source only.
    if (name === "node_modules" || name === "dist" || name === "dist-ui" || name === "test" || name === "models" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** `<file>::<NAME>` of every environment read the text of a source file makes. */
function envReads(file: string, text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const names = new Set<string>();
  for (const m of code.matchAll(/\b(?:process\.env|env|e|ENV)\??\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\benv\??\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\b(?:env|envOr)\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) names.add(m[1]!);
  if (/\benv\[[a-z]/.test(code)) for (const m of code.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["']/g)) names.add(m[1]!);
  return [...names].map((n) => `${file}::${n}`);
}

// @spec CFG-ENV-012
test("cohost source reads only the permitted environment variables; the pending list shrinks to empty", () => {
  const found: string[] = [];
  for (const top of ["packages", "services"]) {
    for (const pkg of readdirSync(join(repo, top))) {
      const src = join(repo, top, pkg);
      if (!statSync(src).isDirectory()) continue;
      for (const f of sourceFiles(src)) found.push(...envReads(relative(repo, f).split(sep).join("/"), readFileSync(f, "utf8")));
    }
  }
  const unexpected = found.filter((r) => !ALLOWED.has(r.split("::")[1]!) && !PENDING.has(r));
  assert.deepEqual(unexpected, [], "an environment variable that is not in the permitted set; operator settings live in the settings store");
  const stale = [...PENDING].filter((r) => !found.includes(r));
  assert.deepEqual(stale, [], "a pending read that no longer exists: delete it from PENDING");
});

// @spec CFG-ENV-008
test("CONTROL_TOKEN is read only by the dashboard and @cohost/control, by no service; no cohost source reads CONTROL_ENABLED", () => {
  const found: string[] = [];
  for (const top of ["packages", "services"]) {
    for (const pkg of readdirSync(join(repo, top))) {
      const src = join(repo, top, pkg);
      if (!statSync(src).isDirectory()) continue;
      for (const f of sourceFiles(src)) found.push(...envReads(relative(repo, f).split(sep).join("/"), readFileSync(f, "utf8")));
    }
  }
  const token = found.filter((r) => r.endsWith("::CONTROL_TOKEN")).map((r) => r.split("::")[0]!);
  assert.ok(token.length > 0, "the scan sees the CONTROL_TOKEN reads");
  assert.deepEqual(token.filter((f) => !f.startsWith("services/dashboard/") && !f.startsWith("packages/control/")), [], "CONTROL_TOKEN read outside the dashboard and @cohost/control");
  assert.deepEqual(found.filter((r) => r.endsWith("::CONTROL_ENABLED")), []);
});

// @spec CFG-ENV-012
test("the environment-read scan finds property, call, index and dynamic reads and ignores comments", () => {
  const text = [
    "// env.IN_LINE_COMMENT", "/* process.env.IN_BLOCK */",
    "const a = process.env.ONE; const b = env.TWO; const c = e?.THREE; const d = process.env[\"FOUR\"]; const f = envOr(\"FIVE\", \"x\"); const g = env(\"SIX\");",
    "const n = (k: string) => env[k]; const names = [\"SEVEN_EIGHT\"];",
  ].join("\n");
  assert.deepEqual(envReads("x.ts", text).map((r) => r.split("::")[1]).toSorted(), ["FIVE", "FOUR", "ONE", "SEVEN_EIGHT", "SIX", "THREE", "TWO"]);
});

// @spec CFG-LOAD-007, CFG-SEC-010
test("a settings syntax error is reported by line, column and reason code only: no text of the source reaches the message, the issues or the log", () => {
  const MARKER = "sk-LEFTOVER-CREDENTIAL-MARKER";
  const broken = `${MINIMAL_YAML}\nnote: a: ${MARKER}\n`;
  const r = parseConfigText(broken);
  assert.equal(r.ok, false);
  const issues = JSON.stringify(!r.ok ? r.issues : []);
  assert.match(issues, /line \d+, column \d+/);
  assert.doesNotMatch(issues, /LEFTOVER|MARKER/);
  // A projection that is not JSON fails naming the file and who writes it, quoting none of its text.
  const dir = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  writeFileSync(join(dir, "settings.json"), `{"format": 1, "note": ${MARKER}`);
  let thrown = "";
  const warnings = captureWarnings(() => { try { loadConfig({ dir, force: true }); } catch (e) { thrown = (e as Error).message; } });
  assert.match(thrown, /settings\.json is not JSON: .*dashboard, cohostctl or the unit runner/);
  assert.doesNotMatch(thrown + warnings.join("\n"), /LEFTOVER|MARKER/);
});

// @spec CFG-ENV-011
test("the placeholder failure says ${...} is not supported and how to keep the text literal", () => {
  const m = message(MINIMAL_YAML.replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"say ${NAME} now\" } }"));
  assert.match(m, /chat\.twitch\.channel: /);
  assert.match(m, /\$\{\.\.\.\} is not supported/);
  assert.match(m, /no escape/);
  assert.match(m, /lower-case/);
});
