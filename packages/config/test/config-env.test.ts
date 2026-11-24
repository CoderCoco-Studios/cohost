import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { loadConfig, parseConfigText } from "../src/index.js";
import * as api from "../src/index.js";
import { MINIMAL_YAML, isolateEnv, sandbox, captureWarnings, repo } from "./helpers/config-sandbox.js";

isolateEnv();

const message = (yaml: string): string => {
  sandbox({ "config.yaml": yaml });
  try { loadConfig(true); } catch (e) { return (e as Error).message; }
  return assert.fail("expected the load to fail");
};

// @spec CFG-ENV-011
test("a ${VAR} or ${VAR:-default} placeholder fails the load, naming the key (an array entry as path[index]), the variable and the literal to write", () => {
  const yaml = MINIMAL_YAML
    .replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"${TWITCH_CHANNEL}\" }, ignore_users: [ok, \"${BOT_NAME:-nightbot}\"] }")
    .replace("llm: { model: m, embed_model: e }", "llm: { model: \"${LLM_MODEL:-qwen}\", embed_model: e, openai: { api_key: \"${LLM_API_KEY}\" } }");
  const m = message(yaml);
  assert.ok(m.startsWith(`Invalid ${join(process.env.CONFIG_DIR!, "config.yaml")}:`));
  assert.match(m, /chat\.twitch\.channel: .*TWITCH_CHANNEL.*literal in config\.yaml/);
  assert.match(m, /chat\.ignore_users\[1\]: .*BOT_NAME.*literal in config\.yaml/);
  assert.match(m, /llm\.model: .*LLM_MODEL.*literal in config\.yaml/);
  assert.match(m, /llm\.openai\.api_key: .*LLM_API_KEY.*secrets\.yaml/, "a secret key says to use secrets.yaml");
});

// @spec CFG-ENV-011
test("a placeholder is never substituted, a placeholder in a comment is not checked, and lower-case or malformed ones are literal text", () => {
  process.env.TWITCH_CHANNEL = "from-env";
  sandbox({ "config.yaml": `# channel: \${TWITCH_CHANNEL}\n${MINIMAL_YAML.replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"literal-${lower_case}-${A-B}\" } } # \\${COMMENTED}")}` });
  const cfg = loadConfig(true);
  assert.equal(cfg.chat.twitch.channel, "literal-${lower_case}-${A-B}");
  const e = parseConfigText(MINIMAL_YAML.replace("brain: {}", "brain: { salience: { barge_in_sources: [\"${X}\"] } }"));
  assert.equal(e.ok, false);
  assert.ok(!e.ok && e.issues.some((i) => i.path === "brain.salience.barge_in_sources[0]" && /\bX\b/.test(i.message)));
});

// @spec CFG-ENV-001, CFG-ENV-002, CFG-ENV-003
test("no environment substitution remains: substituteEnv is gone and an environment variable named in a value changes nothing", () => {
  assert.equal("substituteEnv" in api, false);
  process.env.TWITCH_CHANNEL = "from-env";
  sandbox({ "config.yaml": MINIMAL_YAML.replace("chat: { twitch: {} }", "chat: { twitch: { channel: plain } }") });
  assert.equal(loadConfig(true).chat.twitch.channel, "plain");
});

// @spec CFG-LOAD-004
test("an invalid config.yaml adds no hint about a missing .env, and the helper that supplied it is gone", () => {
  const m = message(MINIMAL_YAML.replace("name: Coco", "name: ''"));
  assert.match(m, /cohost\.name:/);
  assert.doesNotMatch(m, /\.env/);
  assert.equal("missingDotEnv" in api, false);
});

// @spec CFG-LOAD-001
test("loadConfig seeds config.yaml from the example, validates, caches until forced and reads secrets in the same pass", () => {
  const dir = sandbox({ "config.example.yaml": MINIMAL_YAML });
  const warnings = captureWarnings(() => { const a = loadConfig(true); assert.equal(loadConfig(), a); });
  assert.ok(warnings.some((w) => /created .*config\.yaml from config\.example\.yaml/.test(w)));
  writeFileSync(join(dir, "config.yaml"), MINIMAL_YAML.replace("name: Coco", "name: Moco"));
  assert.equal(loadConfig().cohost.name, "Coco");
  assert.equal(loadConfig(true).cohost.name, "Moco");
});

// ---- CFG-ENV-012: cohost source reads only the permitted environment variables

const ALLOWED = new Set([
  "COHOST_ISOLATION", "CONFIG_DIR", "COHOST_ENV_FILE", "COHOST_DATA_DIR", "COHOST_DOCKER_BIN", "COHOST_VERSION", "LOG_LEVEL", "HEARTBEAT_INTERVAL_MS",
  "REDIS_URL", "DATABASE_URL", "OLLAMA_URL", "TTS_URL", "STT_URL", "VOICE_URL", "VOICE_PORT",
  "CONTROL_ENABLED", "CONTROL_TOKEN", "CONTROL_ADVANCED", "DASHBOARD_HOST", "VIEWERS_TOKEN", "PATH", "HOSTNAME", "WSLENV",
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
  assert.deepEqual(unexpected, [], "an environment variable that is not in the permitted set; operator settings are config.yaml or secrets.yaml keys");
  const stale = [...PENDING].filter((r) => !found.includes(r));
  assert.deepEqual(stale, [], "a pending read that no longer exists: delete it from PENDING");
});

// @spec CFG-ENV-012
test("the environment-read scan finds property, call, index and dynamic reads and ignores comments", () => {
  const text = [
    "// env.IN_LINE_COMMENT", "/* process.env.IN_BLOCK */",
    "const a = process.env.ONE; const b = env.TWO; const c = e?.THREE; const d = process.env[\"FOUR\"]; const f = envOr(\"FIVE\", \"x\"); const g = env(\"SIX\");",
    "const n = (k: string) => env[k]; const names = [\"SEVEN_EIGHT\"];",
  ].join("\n");
  assert.deepEqual(envReads("x.ts", text).map((r) => r.split("::")[1]).sort(), ["FIVE", "FOUR", "ONE", "SEVEN_EIGHT", "SIX", "THREE", "TWO"]);
});

// @spec CFG-LOAD-007, CFG-SEC-010
test("a config.yaml syntax error is reported by line, column and reason code only: no text of the source reaches the message, the issues or the log", () => {
  const MARKER = "sk-LEFTOVER-CREDENTIAL-MARKER";
  const broken = `${MINIMAL_YAML}\nnote: a: ${MARKER}\n`;
  const r = parseConfigText(broken);
  assert.equal(r.ok, false);
  const issues = JSON.stringify(!r.ok ? r.issues : []);
  assert.match(issues, /line \d+, column \d+/);
  assert.doesNotMatch(issues, /LEFTOVER|MARKER/);
  sandbox({ "config.yaml": broken });
  let thrown = "";
  const warnings = captureWarnings(() => { try { loadConfig(true); } catch (e) { thrown = (e as Error).message; } });
  assert.match(thrown, /^Invalid .*config\.yaml:/);
  assert.match(thrown, /line \d+, column \d+/);
  assert.doesNotMatch(thrown + warnings.join("\n"), /LEFTOVER|MARKER/);
});

// @spec CFG-ENV-011
test("the placeholder failure says ${...} is not supported in config.yaml and how to keep the text literal", () => {
  const m = message(MINIMAL_YAML.replace("chat: { twitch: {} }", "chat: { twitch: { channel: \"say ${NAME} now\" } }"));
  assert.match(m, /chat\.twitch\.channel: /);
  assert.match(m, /\$\{\.\.\.\} is not supported in config\.yaml/);
  assert.match(m, /no escape/);
  assert.match(m, /lower-case/);
});
