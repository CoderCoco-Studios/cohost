import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo } from "./helpers/config-sandbox.js";

// Behavioural checks of the installer's helpers. The functions between the `begin`/`end` markers in scripts/install.sh are
// extracted and run in bash against a temp directory, with `$MISE` a stub where a block runs mise; the rest of the installer
// (docker, apt) is not run.

const installPath = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const src = readFileSync(installPath, "utf8");
const block = (name: string) => {
  const m = src.match(new RegExp(`# begin ${name}\\n([\\s\\S]*?)# end ${name}\\n`));
  assert.ok(m, `install.sh has a ${name} block`);
  return m![1]!;
};

/** Runs one block of install.sh in bash from `cwd` with `ROOT` set, `log`/`warn`/`die` printing, and `env`; returns the exit status and both streams. */
const runBlock = (name: string, call: string, o: { cwd: string; root?: string; env?: Record<string, string>; path?: string }) => {
  const r = spawnSync("/bin/bash", ["-c", `set -euo pipefail\nROOT="${o.root ?? o.cwd}"\ncd "${o.cwd}"\nlog(){ echo "LOG $*"; }\nwarn(){ echo "WARN $*" >&2; }\ndie(){ echo "DIE $*" >&2; exit 1; }\n${block(name)}\n${call}`], {
    encoding: "utf8", env: { PATH: o.path ?? process.env.PATH!, HOME: process.env.HOME ?? "/", ...o.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** A stub `mise` in a directory of its own: it appends `<cwd> <args>` to its calls file, then runs `body`. */
const stubMise = (body: string): { mise: string; calls: () => string } => {
  const bin = mkdtempSync(join(tmpdir(), "cohost-mise-"));
  const mise = join(bin, "mise");
  const calls = join(bin, "calls");
  writeFileSync(mise, `#!/bin/sh\necho "$(pwd) $*" >> "${calls}"\n${body}\n`);
  chmodSync(mise, 0o755);
  return { mise, calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
};

/** Runs warn_env_token against a .env of the given text (none when undefined); returns the run and the .env afterwards. */
const warnToken = (env: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-inst-"));
  if (env !== undefined) writeFileSync(join(dir, ".env"), env);
  const r = runBlock("control-token", "warn_env_token", { cwd: dir });
  return { ...r, env: existsSync(join(dir, ".env")) ? readFileSync(join(dir, ".env"), "utf8") : undefined };
};

// @spec DEPLOY-INST-013
test("a .env with an empty, commented-out or absent CONTROL_TOKEN gives no warning and is left unchanged", () => {
  for (const env of ["CONTROL_TOKEN=\n", "A=1\nCONTROL_TOKEN=   \nB=2\n", "CONTROL_TOKEN= # fill me\n", 'CONTROL_TOKEN=""\n', "CONTROL_TOKEN=''\n", "# CONTROL_TOKEN=abc\n", "A=1\n", "", undefined]) {
    const r = warnToken(env);
    assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout + r.stderr, /WARN|DIE/, JSON.stringify(env));
    assert.equal(r.env, env, `${JSON.stringify(env)}: .env unchanged`);
  }
});

// @spec DEPLOY-INST-013
test("a non-empty CONTROL_TOKEN in .env is reported by its line number, never its value, and .env is left unchanged", () => {
  const cases: [string, number, string][] = [
    ["CONTROL_TOKEN=mine-secret-value\n", 1, "mine-secret-value"],
    ["A=1\n# a comment\nCONTROL_TOKEN=  spaced-secret  # note\nB=2\n", 3, "spaced-secret"],
    ['A=1\nexport CONTROL_TOKEN="quoted-secret"\n', 2, "quoted-secret"],
  ];
  for (const [env, line, value] of cases) {
    const r = warnToken(env);
    assert.equal(r.status, 0, `the installer carries on: ${r.stderr}`);
    const warning = r.stderr.split("\n").find((l) => l.startsWith("WARN")) ?? "";
    assert.match(warning, /CONTROL_TOKEN/, value);
    assert.match(warning, new RegExp(`\\bline ${line}\\b`), value);
    assert.match(warning, /mise run config:token -- --stdin/, "the way to keep the same token");
    assert.ok(!(r.stdout + r.stderr).includes(value), `${value}: the value is never printed`);
    assert.equal(r.env, env, "never changed");
  }
});

// @spec DEPLOY-INST-013
test("set_control_token runs mise run config:token -- --if-unset, its output reaching the terminal unchanged and nothing written", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-inst-"));
  writeFileSync(join(dir, ".env"), "A=1\n");
  const ok = stubMise('echo "control token: tok-123 (shown once)"');
  const r = runBlock("control-token", "set_control_token", { cwd: dir, env: { MISE: ok.mise } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ok.calls().trim(), `${dir} run config:token -- --if-unset`);
  assert.match(r.stdout, /^control token: tok-123 \(shown once\)$/m, "the task's output is not captured or rewritten");
  assert.deepEqual(readdirSync(dir), [".env"], "no file written");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "A=1\n", ".env never written");

  const failing = stubMise("echo 'store locked' >&2; exit 4");
  const bad = runBlock("control-token", "set_control_token", { cwd: dir, env: { MISE: failing.mise } });
  assert.notEqual(bad.status, 0, "a failing token task stops the installer");
  assert.match(bad.stderr, /^DIE mise run config:token failed/m);
});

/** A directory shaped like a fresh checkout: the example files and nothing else. */
const checkout = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-seed-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, ".env.example"), "COMPOSE_FILE=docker-compose.yml\n");
  for (const f of ["config.example.yaml", "secrets.example.yaml", "personality.example.md", "expressions.example.yaml"]) writeFileSync(join(dir, "config", f), `# ${f}\n`);
  return dir;
};

// @spec DEPLOY-INST-005
test("a missing .env is copied from .env.example, and no settings, personality, expressions or credentials file is created", () => {
  const dir = checkout();
  const first = runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "COMPOSE_FILE=docker-compose.yml\n");
  for (const f of ["config.yaml", "personality.md", "expressions.yaml", "secrets.yaml"]) assert.equal(existsSync(join(dir, "config", f)), false, `config/${f} is not created`);
  assert.equal(existsSync(join(dir, "secrets")), false, "no credentials directory");
  assert.deepEqual(readdirSync(dir).toSorted(), [".env", ".env.example", "config", "data"], "only .env and data/ are new");
  assert.deepEqual(readdirSync(join(dir, "data")), ["logs"]);
  assert.doesNotMatch(first.stdout, /Twitch|Discord|OBS/, "no instruction to fill operator values into .env");
});

// @spec DEPLOY-INST-005
test("an existing .env is never overwritten, even an empty one", () => {
  const dir = checkout();
  for (const text of ["MINE=1\n", ""]) {
    writeFileSync(join(dir, ".env"), text);
    const r = runBlock("seed-files", "seed_files", { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), text);
  }
  const code = block("seed-files").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /config\.yaml|personality|expressions|secrets/, "the block names no settings or credentials file");
});

// @spec DEPLOY-INST-017
test("seeding creates data/logs as the user running it, without sudo, and leaves an existing one alone", () => {
  const dir = checkout();
  const r = runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(statSync(join(dir, "data", "logs")).isDirectory());
  assert.equal(statSync(join(dir, "data", "logs")).uid, process.getuid!(), "owned by the user running the installer");
  writeFileSync(join(dir, "data", "logs", "chat.log"), "{}\n");
  assert.equal(runBlock("seed-files", "seed_files", { cwd: dir }).status, 0);
  assert.equal(readFileSync(join(dir, "data", "logs", "chat.log"), "utf8"), "{}\n");
  const block = readFileSync(join(repo, "scripts", "install.sh"), "utf8").split("# begin seed-files")[1]!.split("# end seed-files")[0]!;
  assert.match(block, /^\s*mkdir -p data\/logs\b/m);
  assert.doesNotMatch(block, /sudo/);
});

const PORT_QUERY = "run -q config:get -- dashboard.port";
/** print_next_steps with a stub mise whose `run -q config:get -- dashboard.port` runs `answer`; ROOT is a temp checkout. */
const nextSteps = (answer = "echo 3000", extraEnv: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cohost-next-"));
  const stub = stubMise(`if [ "$*" = "${PORT_QUERY}" ]; then ${answer}; else exit 3; fi`);
  const cwd = mkdtempSync(join(tmpdir(), "cohost-cwd-"));
  return { ...runBlock("next-steps", "print_next_steps", { cwd, root, env: { MISE: stub.mise, ...extraEnv } }), root, calls: stub.calls() };
};

// @spec DEPLOY-INST-008
test("next steps say open a new shell and mise run dashboard, build the URL from the port mise run config:get prints, and have no compose up step", () => {
  const out = nextSteps("echo 3100");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.calls.trim(), `${out.root} ${PORT_QUERY}`, "the store's own task, run from the checkout");
  assert.match(out.stdout, /http:\/\/localhost:3100\b/);
  const o = out.stdout;
  assert.match(o, /mise run dashboard/);
  assert.match(o, /new shell/i, "a new shell, so the mise activate line applies");
  assert.ok(o.indexOf("new shell") < o.indexOf("mise run dashboard"));
  assert.match(o, /recovery key/);
  assert.match(o, /password manager/);
  assert.match(o, /unlock link/);
  assert.match(o, /enter the control token/);
  assert.match(o, /Settings screen/);
  assert.match(o, /Launch/);
  assert.match(o, /startup log/);
  assert.match(o, /DASHBOARD_HOST/, "the startup log's URL differs when DASHBOARD_HOST is set");
  assert.doesNotMatch(o, /^\s*\d\. docker compose up -d\b/m);
  assert.match(o, /docker compose --profile eyes --profile ears --profile mouth --profile discord up -d/, "the optional profiles step names eyes, ears, mouth and discord");
  assert.match(o, /connections\.discord\.token/, "it names the one Discord bot");
  assert.match(o, /mise run config:secret/, "set on the Settings screen or with mise run config:secret");
  assert.match(o, /Discord connector/);
  assert.doesNotMatch(o, /secrets\.yaml|config\.yaml/, "no settings or credentials file is named");
  assert.doesNotMatch(o, /DISCORD_TOKEN|DASHBOARD_PORT|edit \.env/i, "no retired variable");
});

// @spec DEPLOY-INST-008
test("next steps name the engine profiles pocket, nemotron and kyutai, the engine key each is selected by, and the first-build warning", () => {
  const o = nextSteps().stdout;
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
test("next steps say a hand-run docker compose up starts services that wait for their credentials until the dashboard or mise run deliver delivers them", () => {
  const o = nextSteps().stdout;
  const at = o.indexOf("--profile eyes");
  assert.ok(at >= 0);
  const step = o.slice(at, o.indexOf("5. optional speech engines"));
  assert.match(step, /hand-run docker compose up/);
  assert.match(step, /wait for their credentials/);
  assert.match(step, /dashboard delivers them/);
  assert.match(step, /mise run deliver/, "the command that delivers them by hand");
  assert.match(step, /mise run config:project/, "and the command that refreshes the projections first");
  assert.doesNotMatch(o, /secrets:project/);
});

// @spec DEPLOY-INST-008
test("when mise run config:get fails its first error line goes to stderr and the URL has no port; the installer still finishes", () => {
  const bad = nextSteps("echo 'Error: the settings store is locked' >&2; echo 'second line' >&2; exit 1");
  assert.equal(bad.status, 0);
  assert.equal(bad.stderr.split("\n")[0], "Error: the settings store is locked");
  assert.doesNotMatch(bad.stderr, /second line/, "only the first error line");
  assert.match(bad.stdout, /http:\/\/localhost(?![:\d])/);
  assert.doesNotMatch(bad.stdout, /localhost:\d/);
  assert.match(bad.stdout, /start output/i, "the dashboard's own start output shows the address it listens on");
  assert.match(bad.stdout, /mise run dashboard/);
});

// @spec DEPLOY-INST-008
test("the installer reads the port only from the task's output: no file is parsed or imported, and a hostile output runs nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-next-"));
  const hostile = nextSteps(`echo '3100; $(touch ${dir}/pwned)'`);
  assert.equal(hostile.status, 0, hostile.stderr);
  assert.ok(!existsSync(join(dir, "pwned")));
  assert.doesNotMatch(hostile.stdout, /localhost:\d/, "an output that is not a port gives the URL without one");
  const steps = block("next-steps").split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.ok(steps.includes(`"$MISE" ${PORT_QUERY}`), "the port comes from mise run config:get");
  assert.doesNotMatch(steps, /packages\/(config|store)\/dist|\bnode\b|\b(sed|awk|source)\b|^\s*\.\s|config\.yaml|\.db\b/m, "no import, no file parsing, no sourcing");
});


// @spec DEPLOY-INST-011
test("the Docker-free dev loop is mise run infra:up then mise run dev or one service's watch, and doctor checks the host", () => {
  const out = nextSteps().stdout;
  const page = readFileSync(fileURLToPath(new URL("../../../docs/advanced/dev-setup.md", import.meta.url)), "utf8");
  const infra = "redis postgres ollama tts stt";
  assert.match(out, /mise run infra:up/);
  assert.ok(out.includes(infra), "the installer names the infrastructure containers");
  assert.ok(out.indexOf("mise run infra:up") < out.indexOf("mise run dev"));
  assert.match(out, /mise watch --restart dev:<service>/);
  assert.match(out, /mise run doctor/);
  assert.match(page, /mise run infra:up/, "the Developer setup page starts the same containers through the same task");
  assert.ok(page.includes(infra), "and lists the same ones");
  const toml = readFileSync(join(repo, "mise.toml"), "utf8");
  assert.ok(toml.includes(`run = "docker compose up -d ${infra}"`), "infra:up starts exactly those");
});

const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const at = (s: string, from = code) => {
  const i = from.indexOf(s);
  assert.ok(i >= 0, `install.sh runs ${s}`);
  return i;
};
/** The first docker compose command that is not the version check: the first to pull, create or start anything. */
const firstCompose = (): number => {
  const i = code.search(/^\s*docker compose (?!version\b)/m);
  assert.ok(i >= 0);
  return i;
};
/** The top-level call of set_control_token (its definition is in the control-token block, before the build). */
const setTokenCall = (): number => {
  const i = code.search(/^set_control_token$/m);
  assert.ok(i >= 0, "install.sh calls set_control_token");
  return i;
};

// Source checks of the installer's order and wording; the apt and docker steps themselves are exercised only by running the
// installer (a manual verification item of the segment).
// @spec DEPLOY-INST-007
test("install.sh builds through mise run build, writes the projections, then probes redis and postgres (and ollama when pulling) for 60 s", () => {
  assert.ok(at('"$MISE" run build') < at('"$MISE" run config:project'));
  assert.ok(at('"$MISE" run config:project') < at("docker compose pull --ignore-buildable"));
  assert.ok(at("docker compose pull --ignore-buildable") < at("docker compose up -d ollama models"));
  assert.ok(at("docker compose wait models") < at("docker compose up -d redis postgres"));
  for (const probe of ["redis-cli ping", "pg_isready", "/api/tags"]) at(probe);
  assert.match(src, /probe redis 60 /);
  assert.match(src, /probe postgres 60 /);
  assert.match(src, /if \[\[ \$PULL -eq 1 \]\]; then probe ollama 60 /);
  assert.match(src, /echo "  \$name ok"/);
  assert.match(src, /die "smoke probe failed: \$name did not pass within/);
  assert.match(code.slice(at('"$MISE" run build')).split("\n")[0]!, /\|\|\s*die\b/, "a failed build stops the installer");
});

// @spec DEPLOY-INST-012
test("the installer installs the workspace only through the build task's frozen install and stops on its failure", () => {
  assert.doesNotMatch(code, /\bpnpm\s+(install|i)\b/, "no pnpm install of its own, frozen or not");
  const toml = readFileSync(join(repo, "mise.toml"), "utf8");
  assert.match(toml, /\[tasks\.install\][\s\S]*?run = \["pnpm install --frozen-lockfile"/, "the install task is frozen");
  assert.match(code.slice(at('"$MISE" run build')).split("\n")[0]!, /\|\|\s*die\b/);
});

// @spec DEPLOY-INST-007, DEPLOY-INST-013
test("install.sh runs config:project, then the control token, after the build and before any docker compose command, and stops naming mise run config:check when the projection fails", () => {
  const proj = at('"$MISE" run config:project');
  assert.ok(at('"$MISE" run build') < proj, "after the workspace is built");
  assert.ok(proj < setTokenCall() && setTokenCall() < firstCompose(), "the token is set once the store exists, before any docker compose command");
  assert.ok(proj < firstCompose());
  const line = code.slice(proj).split("\n")[0]!;
  assert.match(line, /\|\|\s*die\b.*mise run config:check/, "a failing projection stops the installer, naming mise run config:check");
  assert.doesNotMatch(line, />\s*\/dev\/null|2>\s*\/dev\/null/, "the projection's message is not swallowed");
  const token = block("control-token").split("\n").find((l) => l.includes('"$MISE" run config:token'));
  assert.ok(token, "set_control_token runs the token task");
  assert.match(token!, /"\$MISE" run config:token -- --if-unset\s*\|\|\s*die\b/);
  assert.doesNotMatch(token!, />|\|\s*tee|\$\(/, "the token's output goes straight to the terminal");
  assert.doesNotMatch(src, /secrets:project/, "no secrets:project");
});

// @spec DEPLOY-INST-015
test("install.sh builds the docs after the workspace, and a docs failure is a warning naming mise run docs:build", () => {
  const docs = at('"$MISE" run docs:build');
  assert.ok(at('"$MISE" run build') < docs && at('"$MISE" run config:project') < docs && setTokenCall() < docs);
  assert.ok(docs < firstCompose());
  const line = code.slice(docs).split("\n")[0]!;
  assert.match(line, /\|\|\s*warn\s+"mise run docs:build failed/, "a warning naming the command, not a stop");
  assert.doesNotMatch(line, /\bdie\b|\bexit\b/);
});

// @spec DEPLOY-INST-014
test("install.sh installs no C toolchain, no rustup and no Rust toolchain, and names no Rust or Zig version", () => {
  for (const re of [/build-essential/, /sh\.rustup\.rs|rustup-init|\brustup\b/, /\bgcc\b|\bclang\b|command -v cc\b/, /--default-toolchain/]) assert.doesNotMatch(code, re);
  assert.doesNotMatch(code, /\bzig\b|\bcargo\b/i, "Zig and Rust come from mise install");
  assert.match(code, /"\$MISE" install --locked/);
});

/** Runs the mise-setup block with a fake ~/.local/bin/mise printing `have` and a fake fetch script recording its arguments. */
function ensureMise(have: string | undefined, want = "2026.11.14") {
  const home = mkdtempSync(join(tmpdir(), "cohost-home-"));
  const root = mkdtempSync(join(tmpdir(), "cohost-root-"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "mise.toml"), `min_version = "${want}"\n[tools]\nnode = "26.13.1"\n`);
  writeFileSync(join(root, "scripts", "fetch-mise.sh"), `#!/bin/sh\necho "FETCH $*" >> "${root}/calls"\n`);
  chmodSync(join(root, "scripts", "fetch-mise.sh"), 0o755);
  if (have !== undefined) {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "mise"), `#!/bin/sh\necho "${have} linux-x64 (2026-11-24)"\n`);
    chmodSync(join(home, ".local", "bin", "mise"), 0o755);
  }
  const r = runBlock("mise-setup", "ensure_mise", { cwd: root, env: { HOME: home } });
  let calls = "";
  try { calls = readFileSync(join(root, "calls"), "utf8"); } catch { /* none */ }
  return { ...r, calls, home };
}

// @spec DEPLOY-INST-004
test("the installer fetches the min_version release into ~/.local/bin/mise unless that release is already there", () => {
  const same = ensureMise("2026.11.14");
  assert.equal(same.status, 0, same.stderr);
  assert.equal(same.calls, "", "the pinned release is kept");
  for (const have of [undefined, "2026.1.1"]) {
    const r = ensureMise(have);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.trim(), `FETCH 2026.11.14 ${r.home}/.local/bin/mise`, `have ${have ?? "none"}`);
  }
});

// @spec DEPLOY-INST-004, DEPLOY-INST-009
test("every mise command runs ~/.local/bin/mise by its full path: trust, install --locked, then the shims first on the path before any build step", () => {
  assert.match(code, /^MISE="\$HOME\/\.local\/bin\/mise"$/m);
  // the messages log, warn and die print are text, not commands
  const commands = code.slice(0, code.indexOf("print_next_steps() {")).replace(/\b(log|warn|die)\s+"[^"]*"/g, '$1 ""');
  assert.doesNotMatch(commands, /(^\s*|&&\s*|\|\|\s*|;\s*|\$\(\s*)mise\s/m, "no bare mise from the path");
  const trust = at('"$MISE" trust "$ROOT/mise.toml"');
  const install = at('"$MISE" install --locked');
  const shims = at('eval "$("$MISE" activate bash --shims)"');
  assert.ok(trust < install && install < shims && shims < at('"$MISE" run build'));
  // nothing before the shims runs node, pnpm or cargo
  assert.doesNotMatch(code.slice(0, shims), /(^|[\s;&|(])(node|pnpm|cargo|npm|npx)\s/m);
});

// @spec DEPLOY-INST-009
test("the installer neither compares nor replaces the host's own Node", () => {
  assert.doesNotMatch(code, /nodesource|process\.versions\.node|node_is_recent|engines\.node|"engines"/i);
  assert.doesNotMatch(code, /apt-get install[^\n]*\bnodejs\b/);
});

/** Runs the shell-activate block with the given $SHELL and rc file content in a fresh HOME. */
function activate(shell: string, rc?: { file: string; text: string }) {
  const home = mkdtempSync(join(tmpdir(), "cohost-rc-"));
  if (rc) writeFileSync(join(home, rc.file), rc.text);
  const r = runBlock("shell-activate", "activate_shell", { cwd: home, env: { HOME: home, SHELL: shell } });
  const read = (f: string) => (existsSync(join(home, f)) ? readFileSync(join(home, f), "utf8") : undefined);
  return { ...r, zshrc: read(".zshrc"), bashrc: read(".bashrc") };
}

// @spec DEPLOY-INST-016
test("the installer appends the mise activate line to the login shell's rc file once, and prints it for any other shell", () => {
  const zsh = activate("/usr/bin/zsh");
  assert.equal(zsh.status, 0, zsh.stderr);
  assert.match(zsh.zshrc ?? "", /^eval "\$\(~\/\.local\/bin\/mise activate zsh\)"$/m);
  assert.equal(zsh.bashrc, undefined);
  const bash = activate("/bin/bash", { file: ".bashrc", text: "alias ll='ls -l'\n" });
  assert.match(bash.bashrc ?? "", /^alias ll='ls -l'\n[\s\S]*^eval "\$\(~\/\.local\/bin\/mise activate bash\)"$/m, "appended, the file kept");
  const already = 'eval "$(mise activate bash)"\n';
  assert.equal(activate("/bin/bash", { file: ".bashrc", text: already }).bashrc, already, "an rc file that activates mise is left unchanged");
  const fish = activate("/usr/bin/fish");
  assert.equal(fish.status, 0);
  assert.equal(fish.zshrc, undefined);
  assert.equal(fish.bashrc, undefined, "no file edited");
  assert.match(fish.stdout, /eval "\$\(~\/\.local\/bin\/mise activate <shell>\)"/, "the line is printed");
});

// @spec DEPLOY-INST-008, DEPLOY-INST-016
test("next steps also give the line that activates mise in the current shell", () => {
  assert.match(nextSteps(undefined, { SHELL: "/usr/bin/zsh" }).stdout, /eval "\$\(~\/\.local\/bin\/mise activate zsh\)"/);
  assert.match(nextSteps(undefined, { SHELL: "/usr/bin/fish" }).stdout, /eval "\$\(~\/\.local\/bin\/mise activate <shell>\)"/);
});

// @spec DEPLOY-TOOL-004
test("the installer installs libatomic1 when the dynamic loader does not find libatomic.so.1, as it does curl and gnupg", () => {
  const line = code.split("\n").find((l) => l.includes("need_apt+=(libatomic1)"));
  assert.ok(line, "libatomic1 joins the apt list");
  assert.ok(line!.includes("libatomic\\.so\\.1") && line!.includes("ldcache"), "only when the loader lacks it");
  assert.ok(code.split("\n").some((l) => l.startsWith("ldcache()") && l.includes("ldconfig -p")), "ldcache lists the loader's cache");
});

// @spec DEPLOY-TOOL-004
test("the libatomic check survives pipefail with a long loader cache: found when listed first, missing when absent", () => {
  const line = code.split("\n").find((l) => l.includes("need_apt+=(libatomic1)"))!;
  // A cache far larger than a pipe buffer, so a reader that stops at the first match would end the listing with SIGPIPE.
  const filler = 'for i in $(seq 1 50000); do printf "\\tlibfiller%s.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libfiller%s.so.1\\n" "$i" "$i"; done';
  const check = (cache: string) =>
    spawnSync("bash", ["-c", `set -euo pipefail\nneed_apt=()\nldcache() { ${cache}; }\n${line}\necho "need=\${need_apt[*]:-}"`], { encoding: "utf8" });
  const found = check(`printf "\\tlibatomic.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libatomic.so.1\\n"; ${filler}`);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), "need=", "a listed libatomic is not installed again");
  const missing = check(filler);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout.trim(), "need=libatomic1");
});

// ---------------------------------------------------------------------------------------------- the mise fetch (DEPLOY-TOOL-020)

const fetchScript = join(repo, "scripts", "fetch-mise.sh");
const V = "2026.11.14";
const TARBALL = `mise-v${V}-linux-x64.tar.gz`;

/** A signing key of the test's own, a release tarball holding mise/bin/mise, and its clearsigned checksums. */
function release(o: { sums?: (line: string) => string; signWith?: "own" | "other"; keyFileHolds?: "own" | "both"; tarball?: "ok" | "not-gzip" | "no-binary" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mise-release-"));
  const gnupg = join(dir, "gnupg");
  mkdirSync(gnupg, { mode: 0o700 });
  const gpg = (...args: string[]) => execFileSync("gpg", ["--batch", "--homedir", gnupg, "--pinentry-mode", "loopback", "--passphrase", "", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  gpg("--quick-gen-key", "release <release@example.invalid>", "ed25519", "sign", "never");
  gpg("--quick-gen-key", "other <other@example.invalid>", "ed25519", "sign", "never");
  const fpr = (uid: string) => gpg("--with-colons", "--list-keys", uid).split("\n").find((l) => l.startsWith("fpr:"))!.split(":")[9]!;
  const own = fpr("release@example.invalid");
  const keyFile = join(dir, "key.asc");
  writeFileSync(keyFile, o.keyFileHolds === "both" ? gpg("--armor", "--export", own, fpr("other@example.invalid")) : gpg("--armor", "--export", own));
  const files = join(dir, "files");
  mkdirSync(join(files, "mise", "bin"), { recursive: true });
  if (o.tarball === "no-binary") writeFileSync(join(files, "mise", "README"), "no binary\n");
  else writeFileSync(join(files, "mise", "bin", "mise"), "#!/bin/sh\necho mise\n");
  const dl = join(dir, "dl");
  mkdirSync(dl);
  if (o.tarball === "not-gzip") writeFileSync(join(dl, TARBALL), "this is not a gzip archive\n");
  else execFileSync("tar", ["-czf", join(dl, TARBALL), "-C", files, "mise"]);
  const sum = execFileSync("sha256sum", [TARBALL], { cwd: dl, encoding: "utf8" }).split(/\s+/)[0]!;
  const line = `${sum}  ./${TARBALL}`;
  writeFileSync(join(dir, "sums"), `${o.sums ? o.sums(line) : `deadbeef  ./mise-v${V}-macos-arm64.tar.gz\n${line}`}\n`);
  const signer = o.signWith === "other" ? fpr("other@example.invalid") : own;
  gpg("--local-user", signer, "--clearsign", "--output", join(dl, "SHASUMS256.asc"), join(dir, "sums"));
  return { dir, dl, keyFile, fingerprint: own };
}

/** Runs scripts/fetch-mise.sh with a fake curl that serves files from `dl` (or fails for the names in `missing`). */
function fetchMise(rel: ReturnType<typeof release>, o: { missing?: string[]; corrupt?: boolean } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "curl-bin-"));
  const log = join(bin, "urls");
  writeFileSync(join(bin, "curl"), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; -*) shift;; *) url=$1; shift;; esac; done
echo "$url" >> "${log}"
name=$(basename "$url")
case " ${(o.missing ?? []).join(" ")} " in *" $name "*) exit 22;; esac
cp "${rel.dl}/$name" "$out" || exit 22
${o.corrupt ? `[ "$name" = "${TARBALL}" ] && echo x >> "$out"` : ""}
exit 0
`);
  chmodSync(join(bin, "curl"), 0o755);
  const dest = join(mkdtempSync(join(tmpdir(), "mise-dest-")), "bin", "mise");
  const r = spawnSync(fetchScript, [V, dest, rel.keyFile, rel.fingerprint], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "/" } });
  return { status: r.status, stderr: r.stderr, installed: existsSync(dest), urls: readFileSync(log, "utf8").trim().split("\n") };
}

// @spec DEPLOY-TOOL-020
test("fetch-mise downloads only the tarball and SHASUMS256.asc, verifies the signature and the one checksum line, then unpacks", () => {
  const ok = fetchMise(release());
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.installed);
  assert.deepEqual(ok.urls, [`https://github.com/jdx/mise/releases/download/v${V}/${TARBALL}`, `https://github.com/jdx/mise/releases/download/v${V}/SHASUMS256.asc`]);
  assert.ok(!ok.urls.some((u) => u.endsWith("SHASUMS256.txt")), "the unsigned .txt is never fetched");
});

// @spec DEPLOY-TOOL-020
test("fetch-mise installs nothing and names the failed step for a failed download, a signature by another key, a tampered tarball or a checksum count other than one", () => {
  const cases: [string, () => ReturnType<typeof fetchMise>, RegExp][] = [
    ["tarball download", () => fetchMise(release(), { missing: [TARBALL] }), /downloading mise-v.*\.tar\.gz failed/],
    ["checksums download", () => fetchMise(release(), { missing: ["SHASUMS256.asc"] }), /downloading SHASUMS256\.asc failed/],
    ["another key's signature", () => fetchMise(release({ signWith: "other" })), /gpg could not verify|not signed by the mise release key/],
    ["tampered tarball", () => fetchMise(release(), { corrupt: true }), /sha256 of mise-v.* does not match/],
    ["no line", () => fetchMise(release({ sums: () => "deadbeef  ./other.tar.gz" })), /name mise-v.*\.tar\.gz 0 times, not once/],
    ["two lines", () => fetchMise(release({ sums: (l) => `${l}\n${l}` })), /name mise-v.*\.tar\.gz 2 times, not once/],
    ["a name that matches only as a pattern", () => fetchMise(release({ sums: (l) => l.replace(`./${TARBALL}`, `./${TARBALL.replace(/\./g, "X")}`) })), /name mise-v.*\.tar\.gz 0 times, not once/],
    ["a valid signature by another key in the key file", () => fetchMise(release({ keyFileHolds: "both", signWith: "other" })), /not signed by the mise release key/],
    ["a tarball tar cannot unpack", () => fetchMise(release({ tarball: "not-gzip" })), /unpacking mise-v.*\.tar\.gz failed/],
    ["a tarball with no mise/bin/mise", () => fetchMise(release({ tarball: "no-binary" })), /holds no mise\/bin\/mise/],
  ];
  for (const [name, run, re] of cases) {
    const r = run();
    assert.notEqual(r.status, 0, name);
    assert.equal(r.installed, false, `${name}: nothing installed`);
    assert.match(r.stderr, re, name);
  }
});

// @spec DEPLOY-TOOL-020
test("the installer and the Dockerfile fetch mise through fetch-mise with the committed key and the pinned fingerprint", () => {
  const script = readFileSync(fetchScript, "utf8");
  assert.match(script, /fingerprint=\$\{4:-24853EC9F655CE80B48E6C3A8B81C9D17413A06D\}/);
  assert.match(script, /key=\$\{3:-\$here\/mise-release-key\.asc\}/);
  assert.match(script, /--homedir "\$tmp\/gnupg"/, "a fresh temporary keyring, never the operator's");
  assert.match(script, /--status-fd 1 --output "\$tmp\/sums" --decrypt/);
  assert.match(code, /"\$ROOT\/scripts\/fetch-mise\.sh" "\$want" "\$MISE"(\s|$)/, "the installer passes no key or fingerprint of its own");
  const docker = readFileSync(join(repo, "Dockerfile"), "utf8");
  assert.match(docker, /fetch-mise\.sh "\$MISE_VERSION" \/usr\/local\/bin\/mise &&/, "nor does the Dockerfile");
});
