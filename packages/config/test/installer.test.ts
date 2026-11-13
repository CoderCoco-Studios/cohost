import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Behavioural checks of the installer's .env helpers. The functions between the `begin`/`end`
// markers in scripts/install.sh are extracted and run in bash against a temp .env; the rest of the
// installer (docker, apt) is not run.

const installPath = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const src = readFileSync(installPath, "utf8");
const block = (name: string) => {
  const m = src.match(new RegExp(`# begin ${name}\\n([\\s\\S]*?)# end ${name}\\n`));
  assert.ok(m, `install.sh has a ${name} block`);
  return m![1]!;
};
const run = (name: string, call: string, env: string, shellEnv: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-inst-"));
  writeFileSync(join(dir, ".env"), env);
  const stdout = execFileSync("bash", ["-c", `set -euo pipefail\ncd "${dir}"\nlog(){ echo "LOG $*"; }\n${block(name)}\n${call}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH!, ...shellEnv },
  });
  return { stdout, env: readFileSync(join(dir, ".env"), "utf8"), dir };
};
const tokenOf = (env: string) => env.match(/^CONTROL_TOKEN=(.*)$/m)?.[1];

// @spec DEPLOY-INST-013
test("an empty CONTROL_TOKEN (nothing, spaces, inline comment) gets a fresh 48-hex secret that is never printed", () => {
  for (const empty of ["CONTROL_TOKEN=", "CONTROL_TOKEN=   ", "CONTROL_TOKEN= # fill me", "CONTROL_TOKEN=#c"]) {
    const { stdout, env } = run("control-token", "fill_control_token", `A=1\n${empty}\nB=2\n`);
    const t = tokenOf(env)!;
    assert.match(t, /^[0-9a-f]{48}$/, empty);
    assert.ok(!stdout.includes(t), "token not printed");
    assert.match(env, /^A=1\n/);
    assert.match(env, /\nB=2\n$/);
  }
});

// @spec DEPLOY-INST-013
test("two runs generate different tokens; a non-empty token is untouched; no line adds none", () => {
  const a = tokenOf(run("control-token", "fill_control_token", "CONTROL_TOKEN=\n").env);
  const b = tokenOf(run("control-token", "fill_control_token", "CONTROL_TOKEN=\n").env);
  assert.notEqual(a, b);
  assert.equal(run("control-token", "fill_control_token", "CONTROL_TOKEN=mine\n").env, "CONTROL_TOKEN=mine\n");
  assert.equal(run("control-token", "fill_control_token", "A=1\n").env, "A=1\n");
});

// @spec DEPLOY-INST-008
test("next steps say pnpm dashboard, the URL from the shell then .env then 3000, and no compose up step", () => {
  const out = (env: string, sh: Record<string, string> = {}) => run("next-steps", "print_next_steps", env, sh);
  assert.match(out("DASHBOARD_PORT=3100\n").stdout, /http:\/\/localhost:3100/);
  assert.match(out("DASHBOARD_PORT=3100\n", { DASHBOARD_PORT: "3200" }).stdout, /http:\/\/localhost:3200/);
  assert.match(out("A=1\n").stdout, /http:\/\/localhost:3000/);
  const evil = out("DASHBOARD_PORT=$(touch pwned)\n");
  assert.match(evil.stdout, /http:\/\/localhost:3000/);
  assert.ok(!existsSync(join(evil.dir, "pwned")), ".env is never executed");
  const o = out("A=1\n").stdout;
  assert.match(o, /pnpm dashboard/);
  assert.match(o, /Launch/);
  assert.match(o, /startup log/);
  assert.doesNotMatch(o, /^\s*\d\. docker compose up -d\b/m);
  assert.match(o, /docker compose --profile eyes --profile ears --profile mouth --profile discord up -d/, "the optional profiles step names eyes, ears, mouth and discord");
  assert.match(o, /DISCORD_TOKEN/, "it names the one Discord bot");
  assert.match(o, /Discord connector/);
});
