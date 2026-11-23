import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo, MINIMAL_YAML } from "./helpers/config-sandbox.js";

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

/** Runs one block of install.sh in bash from `cwd` with `ROOT` set, `log`/`warn` printing, and `env`; returns the exit status and both streams. */
const runBlock = (name: string, call: string, o: { cwd: string; root?: string; env?: Record<string, string>; path?: string }) => {
  const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail\nROOT="${o.root ?? o.cwd}"\ncd "${o.cwd}"\nlog(){ echo "LOG $*"; }\nwarn(){ echo "WARN $*" >&2; }\n${block(name)}\n${call}`], {
    encoding: "utf8", env: { PATH: o.path ?? process.env.PATH!, HOME: process.env.HOME ?? "/", ...o.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A directory shaped like a fresh checkout: the example files and nothing else. */
const checkout = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-seed-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, ".env.example"), "CONTROL_TOKEN=\n");
  for (const f of ["config.example.yaml", "secrets.example.yaml", "personality.example.md", "expressions.example.yaml"]) writeFileSync(join(dir, "config", f), `# ${f}\n`);
  return dir;
};
const mode = (file: string): number => statSync(file).mode & 0o777;

// @spec DEPLOY-INST-005
test("a missing .env or config file is copied from its example, secrets.yaml with mode 0600, and an existing file is never overwritten", () => {
  const dir = checkout();
  const first = runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "CONTROL_TOKEN=\n");
  for (const [f, ex] of [["config.yaml", "config.example.yaml"], ["secrets.yaml", "secrets.example.yaml"], ["personality.md", "personality.example.md"], ["expressions.yaml", "expressions.example.yaml"]] as const) {
    assert.equal(readFileSync(join(dir, "config", f), "utf8"), `# ${ex}\n`, f);
  }
  assert.equal(mode(join(dir, "config", "secrets.yaml")), 0o600);
  assert.doesNotMatch(first.stdout, /Twitch|Discord|OBS/, "no instruction to fill operator values into .env");

  // the operator's edits survive a second run, and a loose-mode secrets.yaml is not touched (it is not ours to rewrite)
  writeFileSync(join(dir, ".env"), "MINE=1\n");
  writeFileSync(join(dir, "config", "config.yaml"), "mine: 1\n");
  writeFileSync(join(dir, "config", "secrets.yaml"), "mine: 2\n");
  chmodSync(join(dir, "config", "secrets.yaml"), 0o640);
  assert.equal(runBlock("seed-files", "seed_files", { cwd: dir }).status, 0);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "MINE=1\n");
  assert.equal(readFileSync(join(dir, "config", "config.yaml"), "utf8"), "mine: 1\n");
  assert.equal(readFileSync(join(dir, "config", "secrets.yaml"), "utf8"), "mine: 2\n");
  assert.equal(mode(join(dir, "config", "secrets.yaml")), 0o640);
});

// @spec DEPLOY-INST-005
test("only the missing files are seeded", () => {
  const dir = checkout();
  writeFileSync(join(dir, "config", "config.yaml"), "mine: 1\n");
  runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(readFileSync(join(dir, "config", "config.yaml"), "utf8"), "mine: 1\n");
  assert.ok(existsSync(join(dir, "config", "secrets.yaml")));
  assert.equal(mode(join(dir, "config", "secrets.yaml")), 0o600);
});

/** The repository's own loader reads `dashboard.port` from a config directory of the given text, run as the installer runs it. */
const nextSteps = (configYaml: string | undefined, extraEnv: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cohost-next-"));
  const cfg = join(root, "config");
  mkdirSync(cfg);
  if (configYaml !== undefined) writeFileSync(join(cfg, "config.yaml"), configYaml);
  return runBlock("next-steps", "print_next_steps", { cwd: root, root: repo, env: { CONFIG_DIR: cfg, COHOST_ENV_FILE: join(root, ".env"), ...extraEnv } });
};

// @spec DEPLOY-INST-008
test("next steps say pnpm dashboard, build the URL from the dashboard.port the config loader returns, and have no compose up step", () => {
  assert.ok(existsSync(join(repo, "packages", "config", "dist", "index.js")), "run `pnpm build` first");
  const out = nextSteps(MINIMAL_YAML.replace("dashboard: {}", "dashboard: { port: 3100, lan_port: 3101 }"));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /http:\/\/localhost:3100\b/);
  assert.equal(nextSteps(MINIMAL_YAML).stdout.match(/http:\/\/localhost:(\d+)/)?.[1], "3000", "the schema default");
  const o = out.stdout;
  assert.match(o, /pnpm dashboard/);
  assert.match(o, /Launch/);
  assert.match(o, /startup log/);
  assert.match(o, /DASHBOARD_HOST/, "the startup log's URL differs when DASHBOARD_HOST is set");
  assert.doesNotMatch(o, /^\s*\d\. docker compose up -d\b/m);
  assert.match(o, /docker compose --profile eyes --profile ears --profile mouth --profile discord up -d/, "the optional profiles step names eyes, ears, mouth and discord");
  assert.match(o, /connections\.discord\.token/, "it names the one Discord bot");
  assert.match(o, /config\/secrets\.yaml/);
  assert.match(o, /Discord connector/);
  assert.doesNotMatch(o, /DISCORD_TOKEN|DASHBOARD_PORT|edit \.env/i, "no retired variable");
});

// @spec DEPLOY-INST-008
test("next steps name the engine profiles pocket, nemotron and kyutai, the engine key each is selected by, and the first-build warning", () => {
  const o = nextSteps(MINIMAL_YAML).stdout;
  const at = o.search(/\bpocket\b/);
  assert.ok(at >= 0, "the engine profiles step exists");
  const step = o.slice(at - 200 > 0 ? at - 200 : 0);
  for (const profile of ["pocket", "nemotron", "kyutai"]) assert.match(step, new RegExp(`\\b${profile}\\b`), profile);
  assert.match(step, /COMPOSE_PROFILES/, "enabled in COMPOSE_PROFILES");
  assert.match(step, /voice\.engine/, "pocket is selected by voice.engine");
  assert.match(step, /ears\.stt_engine/, "nemotron and kyutai are selected by ears.stt_engine");
  assert.match(step, /first build[^\n]*(minutes|several)|(minutes|several)[^\n]*first build/i, "the first build of an enabled profile takes minutes");
  assert.match(o, /docker compose --profile eyes --profile ears --profile mouth --profile discord up -d/, "the optional profiles step is kept");
  assert.doesNotMatch(o, /^\s*\d\. docker compose up -d\b/m);
});

// @spec DEPLOY-INST-008
test("when the loader fails the first error line goes to stderr and the URL has no port; the installer still finishes", () => {
  const bad = nextSteps(MINIMAL_YAML.replace("name: Coco", "name: ''"));
  assert.equal(bad.status, 0);
  assert.match(bad.stderr.split("\n")[0]!, /^Invalid .*config\.yaml:/);
  assert.match(bad.stdout, /http:\/\/localhost(?![:\d])/);
  assert.doesNotMatch(bad.stdout, /localhost:\d/);
  assert.match(bad.stdout, /start output/i, "the dashboard's own start output shows the address it listens on");
  assert.match(bad.stdout, /pnpm dashboard/);
});

// @spec DEPLOY-INST-008
test("config.yaml is never parsed as text or executed by the installer: a hostile value changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-next-"));
  const out = nextSteps(MINIMAL_YAML.replace("dashboard: {}", `dashboard: { port: 3100 }\n# port: $(touch ${dir}/pwned)`));
  assert.match(out.stdout, /localhost:3100\b/);
  assert.ok(!existsSync(join(dir, "pwned")));
  assert.match(src.slice(src.indexOf("# begin next-steps")), /packages\/config\/dist\/index\.js/);
  const steps = src.slice(src.indexOf("# begin next-steps"), src.indexOf("# end next-steps")).split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(steps, /\b(sed|grep|awk|source)\b|\. config/, "no text parsing and no execution of config.yaml");
});

// @spec DEPLOY-INST-011
test("the Docker-free dev loop lists the infrastructure containers the Developer setup page lists", () => {
  const out = nextSteps(MINIMAL_YAML).stdout;
  const page = readFileSync(fileURLToPath(new URL("../../../docs/advanced/dev-setup.md", import.meta.url)), "utf8");
  const infra = "redis postgres ollama tts stt";
  assert.ok(out.includes(`docker compose up -d ${infra}`), "the installer lists the infrastructure containers");
  assert.ok(page.includes(`docker compose up -d ${infra}`), "the Developer setup page lists the same ones");
});

// Source checks of the installer's order and wording; the apt, rustup and docker steps themselves are exercised
// only by running the installer (a manual verification item of the segment).
// @spec DEPLOY-INST-007
test("install.sh installs, builds the addon, typechecks, then probes redis and postgres (and ollama when pulling) for 60 s", () => {
  const at = (s: string) => {
    const i = src.indexOf(s);
    assert.ok(i >= 0, `install.sh contains ${s}`);
    return i;
  };
  assert.ok(at("pnpm install --frozen-lockfile") < at("pnpm build:native"));
  assert.ok(at("pnpm build:native") < at("pnpm typecheck"));
  assert.ok(at("pnpm typecheck") < at("docker compose pull --ignore-buildable"));
  assert.ok(at("docker compose pull --ignore-buildable") < at("docker compose up -d ollama models"));
  assert.ok(at("docker compose wait models") < at("docker compose up -d redis postgres"));
  for (const probe of ["redis-cli ping", "pg_isready", "/api/tags"]) at(probe);
  assert.match(src, /probe redis 60 /);
  assert.match(src, /probe postgres 60 /);
  assert.match(src, /if \[\[ \$PULL -eq 1 \]\]; then probe ollama 60 /);
  assert.match(src, /echo "  \$name ok"/);
  assert.match(src, /die "smoke probe failed: \$name did not pass within/);
});

// @spec DEPLOY-INST-014
test("install.sh installs rustup without a default toolchain, then the pinned toolchain, and names no Rust version", () => {
  const from = src.indexOf("# ---------------------------------------------------------------- rust toolchain");
  const to = src.indexOf("# ---------------------------------------------------------------- deps + build");
  const section = src.slice(from, to);
  assert.match(section, /sh\.rustup\.rs/);
  assert.match(section, /--default-toolchain none/);
  assert.match(section, /^rustup toolchain install\b/m, "the pinned toolchain is installed on every run");
  assert.match(section, /command -v cc /);
  assert.match(section, /build-essential/);
  assert.doesNotMatch(section.replace(/^\s*#.*$/gm, ""), /\b\d+\.\d+(\.\d+)?\b|stable|nightly/, "no Rust version or channel of its own");
});

/** A `node` on PATH that reports the given version and fails for any other use, so only the installer's version probe is exercised. */
const fakeNode = (version: string): string => {
  const bin = mkdtempSync(join(tmpdir(), "cohost-node-"));
  writeFileSync(join(bin, "node"), `#!/bin/sh\ncase "$*" in *process.versions.node*) echo ${version};; *) exit 1;; esac\n`);
  chmodSync(join(bin, "node"), 0o755);
  return `${bin}:${process.env.PATH}`;
};
const needsNode = (version: string, engines: string): { needed: boolean; major: string } => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-eng-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", engines: { node: engines } }, null, 2));
  const r = runBlock("node-version", 'if node_is_recent; then echo KEEP; else echo REPLACE; fi; echo "MAJOR=$(node_min_major)"', { cwd: dir, path: fakeNode(version) });
  assert.equal(r.status, 0, r.stderr);
  return { needed: r.stdout.includes("REPLACE"), major: /MAJOR=(\d+)/.exec(r.stdout)![1]! };
};

// @spec DEPLOY-INST-009
test("Node is compared with the full engines.node minimum (major, then minor, then patch), not the major alone", () => {
  assert.equal(needsNode("26.0.0", ">=26").needed, false);
  assert.equal(needsNode("26.0.0", ">=26.2").needed, true, "same major, older minor");
  assert.equal(needsNode("26.2.0", ">=26.2").needed, false);
  assert.equal(needsNode("26.10.1", ">=26.2").needed, false, "minor compared as a number, not text");
  assert.equal(needsNode("26.2.0", ">=26.2.4").needed, true, "same minor, older patch");
  assert.equal(needsNode("26.2.4", ">=26.2.4").needed, false);
  assert.equal(needsNode("25.9.9", ">=26").needed, true);
  assert.equal(needsNode("28.0.0", ">=26.2").needed, false, "a Node at or above the minimum of any major is kept");
  assert.equal(needsNode("30.0.0", ">=26.2").needed, false);
});

// @spec DEPLOY-INST-009
test("the NodeSource setup for a replacement is for the minimum's major, and the installer names no Node major of its own", () => {
  assert.equal(needsNode("20.0.0", ">=26.2").major, "26");
  assert.equal(needsNode("20.0.0", ">=27").major, "27");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(code, /setup_\$\{?NODE_MAJOR\}?\.x/);
  assert.doesNotMatch(code, /setup_\d+\.x|Installing Node \d+/);
  const missing = runBlock("node-version", "node_is_recent && echo KEEP || echo REPLACE", { cwd: mkdtempSync(join(tmpdir(), "cohost-eng-")), path: "/nonexistent" });
  assert.match(missing.stdout, /REPLACE/, "a missing node is replaced");
});
