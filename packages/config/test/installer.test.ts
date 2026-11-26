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
test("a missing .env or config file is copied from its example, secrets/secrets.yaml with mode 0600 in a 0700 directory, and an existing file is never overwritten", () => {
  const dir = checkout();
  const secrets = join(dir, "secrets", "secrets.yaml");
  const first = runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "CONTROL_TOKEN=\n");
  for (const [f, ex] of [["config.yaml", "config.example.yaml"], ["personality.md", "personality.example.md"], ["expressions.yaml", "expressions.example.yaml"]] as const) {
    assert.equal(readFileSync(join(dir, "config", f), "utf8"), `# ${ex}\n`, f);
  }
  assert.equal(readFileSync(secrets, "utf8"), "# secrets.example.yaml\n", "copied from config/secrets.example.yaml");
  assert.equal(mode(secrets), 0o600);
  assert.equal(mode(join(dir, "secrets")), 0o700);
  assert.equal(existsSync(join(dir, "config", "secrets.yaml")), false, "the credentials file is not seeded into ./config");
  assert.doesNotMatch(first.stdout, /Twitch|Discord|OBS/, "no instruction to fill operator values into .env");

  // the operator's edits survive a second run, and a loose-mode secrets file is not touched (it is not ours to rewrite)
  writeFileSync(join(dir, ".env"), "MINE=1\n");
  writeFileSync(join(dir, "config", "config.yaml"), "mine: 1\n");
  writeFileSync(secrets, "mine: 2\n");
  chmodSync(secrets, 0o640);
  assert.equal(runBlock("seed-files", "seed_files", { cwd: dir }).status, 0);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "MINE=1\n");
  assert.equal(readFileSync(join(dir, "config", "config.yaml"), "utf8"), "mine: 1\n");
  assert.equal(readFileSync(secrets, "utf8"), "mine: 2\n");
  assert.equal(mode(secrets), 0o640);
});

// @spec DEPLOY-INST-005
test("only the missing files are seeded, and an existing secrets directory keeps its mode", () => {
  const dir = checkout();
  writeFileSync(join(dir, "config", "config.yaml"), "mine: 1\n");
  mkdirSync(join(dir, "secrets"), { mode: 0o750 });
  runBlock("seed-files", "seed_files", { cwd: dir });
  assert.equal(readFileSync(join(dir, "config", "config.yaml"), "utf8"), "mine: 1\n");
  assert.ok(existsSync(join(dir, "secrets", "secrets.yaml")));
  assert.equal(mode(join(dir, "secrets", "secrets.yaml")), 0o600);
  assert.equal(mode(join(dir, "secrets")), 0o750, "an existing directory is not re-moded");
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
test("next steps say open a new shell and mise run dashboard, build the URL from the dashboard.port the config loader returns, and have no compose up step", () => {
  assert.ok(existsSync(join(repo, "packages", "config", "dist", "index.js")), "run `mise run build` first");
  const out = nextSteps(MINIMAL_YAML.replace("dashboard: {}", "dashboard: { port: 3100, lan_port: 3101 }"));
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /http:\/\/localhost:3100\b/);
  assert.equal(nextSteps(MINIMAL_YAML).stdout.match(/http:\/\/localhost:(\d+)/)?.[1], "3000", "the schema default");
  const o = out.stdout;
  assert.match(o, /mise run dashboard/);
  assert.match(o, /new shell/i, "a new shell, so the mise activate line applies");
  assert.ok(o.indexOf("new shell") < o.indexOf("mise run dashboard"));
  assert.match(o, /Launch/);
  assert.match(o, /startup log/);
  assert.match(o, /DASHBOARD_HOST/, "the startup log's URL differs when DASHBOARD_HOST is set");
  assert.doesNotMatch(o, /^\s*\d\. docker compose up -d\b/m);
  assert.match(o, /docker compose --profile eyes --profile ears --profile mouth --profile discord up -d/, "the optional profiles step names eyes, ears, mouth and discord");
  assert.match(o, /connections\.discord\.token/, "it names the one Discord bot");
  assert.match(o, /secrets\/secrets\.yaml/, "the credentials file is named by its new path");
  assert.doesNotMatch(o, /config\/secrets\.yaml/, "no step names the retired ./config location");
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
test("next steps warn that a hand-run docker compose up skips the secrets projection and name the command that refreshes it", () => {
  const o = nextSteps(MINIMAL_YAML).stdout;
  const at = o.indexOf("--profile eyes");
  assert.ok(at >= 0);
  const step = o.slice(at, o.indexOf("5. optional speech engines"));
  assert.match(step, /mise run secrets:project/, "the step names the projection command");
  assert.match(step, /skips|does not (run|refresh)|not refresh/i, "and says that a hand-run compose up does not run it");
});

// @spec DEPLOY-INST-008
test("when the loader fails the first error line goes to stderr and the URL has no port; the installer still finishes", () => {
  const bad = nextSteps(MINIMAL_YAML.replace("name: Coco", "name: ''"));
  assert.equal(bad.status, 0);
  assert.match(bad.stderr.split("\n")[0]!, /^Invalid .*config\.yaml:/);
  assert.match(bad.stdout, /http:\/\/localhost(?![:\d])/);
  assert.doesNotMatch(bad.stdout, /localhost:\d/);
  assert.match(bad.stdout, /start output/i, "the dashboard's own start output shows the address it listens on");
  assert.match(bad.stdout, /mise run dashboard/);
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
test("the Docker-free dev loop is mise run infra:up then mise run dev or one service's watch, and doctor checks the host", () => {
  const out = nextSteps(MINIMAL_YAML).stdout;
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

// Source checks of the installer's order and wording; the apt and docker steps themselves are exercised only by running the
// installer (a manual verification item of the segment).
// @spec DEPLOY-INST-007
test("install.sh builds through mise run build, projects the secrets, then probes redis and postgres (and ollama when pulling) for 60 s", () => {
  assert.ok(at('"$MISE" run build') < at('"$MISE" run secrets:project'));
  assert.ok(at('"$MISE" run secrets:project') < at("docker compose pull --ignore-buildable"));
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

// @spec DEPLOY-SECRET-006
test("install.sh runs the secrets projection after the build and before any docker compose command, and stops with the projection's message on failure", () => {
  const proj = at('"$MISE" run secrets:project');
  assert.ok(at('"$MISE" run build') < proj, "after the workspace is built");
  assert.ok(proj < code.indexOf("docker compose pull") && proj < code.indexOf("docker compose up"), "before the first docker compose command that creates a container");
  const line = code.slice(proj).split("\n")[0]!;
  assert.match(line, /\|\|\s*die\b|\|\|\s*exit\b/, "a failing projection stops the installer");
  assert.doesNotMatch(line, />\s*\/dev\/null|2>\s*\/dev\/null/, "the projection's message is not swallowed");
});

// @spec DEPLOY-INST-015
test("install.sh builds the docs after the workspace, and a docs failure is a warning naming mise run docs:build", () => {
  const docs = at('"$MISE" run docs:build');
  assert.ok(at('"$MISE" run build') < docs && at('"$MISE" run secrets:project') < docs);
  assert.ok(docs < code.indexOf("docker compose pull"));
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
  const commands = code.slice(0, code.indexOf("print_next_steps() {"));
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
  assert.match(nextSteps(MINIMAL_YAML, { SHELL: "/usr/bin/zsh" }).stdout, /eval "\$\(~\/\.local\/bin\/mise activate zsh\)"/);
  assert.match(nextSteps(MINIMAL_YAML, { SHELL: "/usr/bin/fish" }).stdout, /eval "\$\(~\/\.local\/bin\/mise activate <shell>\)"/);
});

// @spec DEPLOY-TOOL-004
test("the installer installs libatomic1 when the dynamic loader does not find libatomic.so.1, as it does curl and gnupg", () => {
  const line = code.split("\n").find((l) => l.includes("need_apt+=(libatomic1)"));
  assert.ok(line, "libatomic1 joins the apt list");
  assert.ok(line!.includes("ldconfig -p") && line!.includes("libatomic\\.so\\.1"), "only when the loader lacks it");
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
