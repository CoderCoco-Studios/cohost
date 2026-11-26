// The project's toolchains and commands (deployment design, "Toolchains and commands"): mise.toml's pins and tasks, the one
// source of each toolchain version, the Zig wrappers, the doctor checks and the mise release key. Task definitions are read
// through mise itself (helpers/mise.ts); the checks over build files are pure functions over text, exercised against the
// repository and against fixtures that break them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { dependencyClosure, miseTasks, readRepo, rel, repoRoot, task } from "./helpers/mise.js";

const miseToml = readRepo("mise.toml");
const workflowFiles = readdirSync(join(repoRoot, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));
const workflows = Object.fromEntries(workflowFiles.map((f) => [`.github/workflows/${f}`, readRepo(`.github/workflows/${f}`)]));
const services = readdirSync(join(repoRoot, "services"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const devServices = services.filter((s) => s !== "dashboard").sort();

/** The value of a top-level `key = "value"` line, or of `key = "value"` under `[table]`. */
function tomlString(text: string, key: string, table?: string): string | undefined {
  let section = "";
  for (const line of text.split("\n")) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (h) { section = h[1]!.trim(); continue; }
    const m = new RegExp(`^\\s*${key.replace(/[.]/g, "\\.")}\\s*=\\s*"([^"]*)"`).exec(line);
    if (m && section === (table ?? "")) return m[1];
  }
  return undefined;
}
const tableText = (text: string, table: string): string => {
  const at = text.indexOf(`[${table}]\n`);
  if (at < 0) return "";
  const rest = text.slice(at + table.length + 3);
  const next = rest.search(/^\[/m);
  return next < 0 ? rest : rest.slice(0, next);
};
const nonComment = (text: string, marker = "#"): string => text.split("\n").filter((l) => !l.trimStart().startsWith(marker)).join("\n");
const EXACT = /^\d+\.\d+\.\d+$/;

// ---------------------------------------------------------------------------------------------- pins (DEPLOY-TOOL-001)

// @spec DEPLOY-TOOL-001
test("mise.toml pins Node, Zig, Python and watchexec exactly, takes pnpm and Rust from their own files, and locks every install", () => {
  for (const tool of ["node", "zig", "python", "watchexec"]) assert.match(tomlString(miseToml, tool, "tools") ?? "", EXACT, `[tools] ${tool}`);
  const tools = tableText(miseToml, "tools");
  assert.doesNotMatch(tools, /^\s*(pnpm|rust)\s*=/m, "no pnpm or Rust version of its own");
  assert.match(tomlString(miseToml, "min_version") ?? "", /^\d{4}\.\d{1,2}\.\d+$/, "min_version is an exact mise release");
  const settings = tableText(miseToml, "settings");
  assert.match(settings, /^lockfile = true$/m);
  const idiomatic = /^idiomatic_version_file_enable_tools = \[(.*)\]$/m.exec(settings)?.[1] ?? "";
  assert.deepEqual(idiomatic.split(",").map((s) => s.trim().replace(/"/g, "")).sort(), ["pnpm", "rust"]);
  assert.equal(tomlString(miseToml, "rustup_home", "settings.rust"), "~/.local/share/mise/rustup");
  assert.equal(tomlString(miseToml, "cargo_home", "settings.rust"), "~/.local/share/mise/cargo");
  const lock = readRepo("mise.lock");
  for (const tool of ["node", "zig", "python", "watchexec"]) {
    assert.match(lock, new RegExp(`\\[\\[tools\\.${tool}\\]\\]\\nversion = "${tomlString(miseToml, tool, "tools")!.replace(/\./g, "\\.")}"`), `mise.lock records ${tool}`);
  }
  const pnpm = (JSON.parse(readRepo("package.json")) as { packageManager: string }).packageManager.replace(/^pnpm@/, "");
  assert.match(lock, new RegExp(`\\[\\[tools\\.pnpm\\]\\]\\nversion = "${pnpm.replace(/\./g, "\\.")}"`), "mise.lock records the packageManager pnpm");
  const rust = /channel\s*=\s*"([^"]+)"/.exec(readRepo("rust-toolchain.toml"))![1]!;
  assert.match(lock, new RegExp(`\\[\\[tools\\.rust\\]\\]\\nversion = "${rust.replace(/\./g, "\\.")}"`), "mise.lock records the rust-toolchain.toml Rust");
  assert.match(lock, /\[tools\.node\."platforms\.linux-x64"\]\nchecksum = "sha256:[0-9a-f]{64}"/, "a checksum for every download");
});

// ---------------------------------------------------------------------------------------------- one source per version (DEPLOY-TOOL-002)

interface BuildFiles { miseToml: string; dockerfile: string; workflows: Record<string, string>; installSh: string; rootPackageJson: string; rootFiles: string[] }

/** Every place a build file names a toolchain version or installer other than its one source; each problem names the file. */
function versionSourceProblems(f: BuildFiles): string[] {
  const out: string[] = [];
  const min = tomlString(f.miseToml, "min_version");
  const node = tomlString(f.miseToml, "node", "tools");
  const docker = nonComment(f.dockerfile);
  const arg = /^ARG MISE_VERSION=(\S+)$/m.exec(docker)?.[1];
  if (arg !== min) out.push(`Dockerfile: ARG MISE_VERSION is ${arg ?? "missing"}, mise.toml min_version is ${min}`);
  const froms = [...docker.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
  const nodeFrom = froms.filter((i) => i.startsWith("node:"));
  if (nodeFrom.length !== 1 || nodeFrom[0] !== `node:${node}-trixie-slim`) out.push(`Dockerfile: the runtime image is ${nodeFrom.join(", ") || "missing"}, expected node:${node}-trixie-slim`);
  const debian = froms.filter((i) => i.startsWith("debian:"));
  if (debian.length !== 1 || !/^debian:13\.\d+-slim$/.test(debian[0]!)) out.push(`Dockerfile: the toolchain image is ${debian.join(", ") || "missing"}, expected an exact debian:13.<n>-slim (trixie, the node: tag's codename)`);
  for (const [file, text] of Object.entries(f.workflows)) {
    const wf = parseYaml(text) as { jobs?: Record<string, { steps?: { uses?: string; with?: Record<string, unknown> }[] }> };
    for (const job of Object.values(wf.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("jdx/mise-action@")) continue;
        const v = step.with?.version === undefined ? undefined : String(step.with.version as string | number);
        if (v !== min) out.push(`${file}: jdx/mise-action version is ${v ?? "unset"}, mise.toml min_version is ${min}`);
        if (step.with && "sha256" in step.with) out.push(`${file}: jdx/mise-action is given a sha256 input`);
      }
    }
  }
  const forbidden: [RegExp, string][] = [
    [/node-version:/, "a node-version: input"],
    [/"engines"\s*:/, "an engines field"],
    [/^FROM\s+rust:/m, "a FROM rust: image"],
    [/\bcorepack\b/, "corepack"],
    [/pnpm\/action-setup/, "pnpm/action-setup"],
    [/actions\/setup-node/, "actions/setup-node"],
    [/rustup toolchain install/, "rustup toolchain install"],
  ];
  const scanned: [string, string][] = [["Dockerfile", docker], ["scripts/install.sh", nonComment(f.installSh)], ["package.json", f.rootPackageJson], ...Object.entries(f.workflows).map(([k, t]) => [k, nonComment(t)] as [string, string])];
  for (const [file, text] of scanned) for (const [re, what] of forbidden) if (re.test(text)) out.push(`${file}: names ${what}`);
  for (const name of [".nvmrc", ".node-version", ".tool-versions"]) if (f.rootFiles.includes(name)) out.push(`${name}: a version file outside mise.toml`);
  return out;
}
const repoBuildFiles = (): BuildFiles => ({
  miseToml, dockerfile: readRepo("Dockerfile"), workflows, installSh: readRepo("scripts/install.sh"), rootPackageJson: readRepo("package.json"), rootFiles: readdirSync(repoRoot),
});

// @spec DEPLOY-TOOL-002
test("the Dockerfile, the installer, the workflows and package.json name no toolchain version outside its one source", () => {
  assert.deepEqual(versionSourceProblems(repoBuildFiles()), []);
});

// @spec DEPLOY-TOOL-002
test("the one-source check fails, naming the file, for each kind of second source", () => {
  const base = repoBuildFiles();
  const wf = Object.keys(base.workflows).find((k) => base.workflows[k]!.includes("jdx/mise-action"))!;
  const cases: [Partial<BuildFiles>, RegExp][] = [
    [{ dockerfile: base.dockerfile.replace(/ARG MISE_VERSION=\S+/, "ARG MISE_VERSION=2020.1.1") }, /^Dockerfile: ARG MISE_VERSION is 2020\.1\.1/],
    [{ workflows: { ...base.workflows, [wf]: base.workflows[wf]!.replace(/version: \S+/, "version: 2020.1.1") } }, new RegExp(`^${wf.replace(/\./g, "\\.")}: jdx/mise-action version`)],
    [{ workflows: { ...base.workflows, [wf]: base.workflows[wf]!.replace(/(version: \S+)/, "$1\n          sha256: abc") } }, /sha256 input/],
    [{ dockerfile: base.dockerfile.replace(/FROM node:\S+/, "FROM node:26-slim") }, /^Dockerfile: the runtime image is node:26-slim/],
    [{ dockerfile: base.dockerfile.replace(/FROM debian:\S+/, "FROM debian:trixie-slim") }, /^Dockerfile: the toolchain image/],
    [{ dockerfile: base.dockerfile.replace(/FROM debian:\S+/, "FROM debian:12.9-slim") }, /^Dockerfile: the toolchain image/],
    [{ dockerfile: `${base.dockerfile}\nFROM rust:1.100.0-slim AS x\n` }, /^Dockerfile: names a FROM rust: image/],
    [{ dockerfile: `${base.dockerfile}\nRUN corepack enable\n` }, /^Dockerfile: names corepack/],
    [{ installSh: `${base.installSh}\nrustup toolchain install\n` }, /^scripts\/install\.sh: names rustup toolchain install/],
    [{ rootPackageJson: base.rootPackageJson.replace('"private": true,', '"private": true,\n  "engines": { "node": ">=26" },') }, /^package\.json: names an engines field/],
    [{ workflows: { ...base.workflows, [wf]: `${base.workflows[wf]}\n      - uses: actions/setup-node@v7.1.0\n        with:\n          node-version: 26\n` } }, /node-version: input|actions\/setup-node/],
    [{ workflows: { ...base.workflows, [wf]: `${base.workflows[wf]}\n      - uses: pnpm/action-setup@v6.1.1\n` } }, /pnpm\/action-setup/],
    [{ rootFiles: [...base.rootFiles, ".nvmrc"] }, /^\.nvmrc: /],
  ];
  for (const [patch, re] of cases) {
    const problems = versionSourceProblems({ ...base, ...patch });
    assert.ok(problems.some((p) => re.test(p)), `${re}: ${JSON.stringify(problems)}`);
  }
});

// ---------------------------------------------------------------------------------------------- linking through Zig (DEPLOY-TOOL-003)

/** Compares dotted versions. */
const cmp = (a: string, b: string): number => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
const RUNTIME_GLIBC = "2.41"; // Debian 13, the runtime image's release
const HOST_FLOOR_GLIBC = "2.35"; // Ubuntu 22.04, the oldest supported host
const glibcProblems = (glibc: string | undefined): string[] => {
  if (!glibc || !/^\d+\.\d+$/.test(glibc)) return [`mise.toml: ZIG_GLIBC is ${glibc ?? "unset"}, not a glibc version`];
  const out: string[] = [];
  if (cmp(glibc, RUNTIME_GLIBC) > 0) out.push(`mise.toml: ZIG_GLIBC ${glibc} is newer than the runtime image's glibc ${RUNTIME_GLIBC}`);
  if (cmp(glibc, HOST_FLOOR_GLIBC) > 0) out.push(`mise.toml: ZIG_GLIBC ${glibc} is newer than the supported host floor's glibc ${HOST_FLOOR_GLIBC}`);
  return out;
};

// @spec DEPLOY-TOOL-003
test("mise.toml [env] links every x86_64-unknown-linux-gnu build through the Zig wrappers, with ZIG_GLIBC no newer than the image or the host floor", () => {
  const want: Record<string, string> = {
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER: "{{config_root}}/scripts/zig-cc",
    CC_x86_64_unknown_linux_gnu: "{{config_root}}/scripts/zig-cc",
    CXX_x86_64_unknown_linux_gnu: "{{config_root}}/scripts/zig-cxx",
    AR_x86_64_unknown_linux_gnu: "{{config_root}}/scripts/zig-ar",
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: "-Clinker-features=-lld",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(tomlString(miseToml, k, "env"), v, k);
  for (const k of ["ZIG_GLOBAL_CACHE_DIR", "ZIG_LOCAL_CACHE_DIR"]) assert.match(tomlString(miseToml, k, "env") ?? "", /^\{\{env\.HOME\}\}\/\.local\/share\/mise\/zig-cache\//, k);
  assert.deepEqual(glibcProblems(tomlString(miseToml, "ZIG_GLIBC", "env")), []);
  assert.equal(glibcProblems("2.36").length, 1, "newer than the host floor fails");
  assert.equal(glibcProblems("2.42").length, 2, "newer than the image fails");
  assert.equal(glibcProblems(undefined).length, 1, "unset fails");
});

// ---------------------------------------------------------------------------------------------- the installer installs only prerequisites (DEPLOY-TOOL-004)

const ALLOWED_SYSTEM = new Set(["docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin", "nvidia-container-toolkit", "ca-certificates", "curl", "gnupg", "libatomic1"]);
function systemInstallProblems(installSh: string): string[] {
  const code = nonComment(installSh);
  const out: string[] = [];
  const packages = new Set<string>();
  for (const m of code.matchAll(/apt-get install([^\n]*)/g)) for (const t of m[1]!.split(/\s+/)) if (t && !t.startsWith("-") && !t.startsWith('"$') && !t.startsWith("$") && !/^(&&|\|\||;)$/.test(t)) packages.add(t);
  for (const m of code.matchAll(/need_apt\+=\(([^)]*)\)/g)) for (const t of m[1]!.split(/\s+/)) if (t) packages.add(t);
  for (const p of packages) if (!ALLOWED_SYSTEM.has(p)) out.push(`scripts/install.sh: installs ${p} system-wide`);
  for (const [re, what] of [[/build-essential/, "build-essential"], [/npm (install|i) -g/, "a global npm install"], [/\bcorepack\b/, "corepack"], [/cargo install/, "cargo install"], [/pip3? install/, "pip install"], [/nodesource/i, "a NodeSource setup"], [/sh\.rustup\.rs|rustup-init/, "the rustup installer"], [/mise\.run/, "the mise.run script"]] as [RegExp, string][]) {
    if (re.test(code)) out.push(`scripts/install.sh: names ${what}`);
  }
  return out;
}

// @spec DEPLOY-TOOL-004
test("the installer installs system-wide only Docker, the NVIDIA container toolkit, ca-certificates, curl, gnupg and libatomic1", () => {
  const sh = readRepo("scripts/install.sh");
  assert.deepEqual(systemInstallProblems(sh), []);
  assert.match(systemInstallProblems(`${sh}\nsudo apt-get install -y build-essential\n`).join("\n"), /installs build-essential.*\n.*names build-essential/);
  assert.match(systemInstallProblems(`${sh}\nneed_apt+=(pkg-config)\n`).join("\n"), /installs pkg-config/);
  for (const bad of ["sudo npm install -g corepack@0.36.0", "curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -", "curl https://sh.rustup.rs | sh", "curl https://mise.run | sh", "pip install x", "cargo install x"]) {
    assert.ok(systemInstallProblems(`${sh}\n${bad}\n`).length > 0, bad);
  }
});

// ---------------------------------------------------------------------------------------------- the task surface (DEPLOY-TOOL-005 to -016)

// @spec DEPLOY-TOOL-005
test("mise.toml defines every task of the command surface, one dev:<service> per service but the dashboard", () => {
  const names = new Set(miseTasks().keys());
  for (const n of ["install", "build:native", "build:ts", "build:ui", "build", "typecheck", "lint:ts", "lint:rust", "lint", "test:rust", "test", "test:only", "test:file", "test:launch", "test:rust-example", "dev", "infra:up", "infra:down", "dashboard", "dashboard:ui", "cohostctl", "secrets:project", "reflect", "consolidate", "reembed", "bus:pub", "bus:tail", "bus:bench", "perf:baseline", "perf:connector", "stub:llm", "stub:tts", "hooks:schemas", "docs:build", "docs:dev", "docs:preview", "clean", "smoke", "lid-check", "doctor", "doctor:docker", "doctor:gpu", "doctor:fetch", "doctor:libatomic", "doctor:glibc"]) {
    assert.ok(names.has(n), `task ${n}`);
  }
  for (const s of devServices) assert.ok(names.has(`dev:${s}`), `dev:${s}`);
  assert.ok(!names.has("dev:dashboard"), "the dashboard is a task of its own");
});

/** A run line's problem when it is not a direct tool call: a package.json script, pnpm run/exec/--filter/-r. */
function runLineProblems(name: string, line: string): string[] {
  const out: string[] = [];
  for (const seg of line.split(/&&|\|\||;|\n/)) {
    const words = seg.trim().replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, "").split(/\s+/);
    if (words[0] === "pnpm" && !(words[1] === "install" && words.includes("--frozen-lockfile"))) out.push(`task ${name}: runs "${seg.trim()}"; pnpm is only the installer (pnpm install --frozen-lockfile)`);
    if (words[0] === "npm" || words[0] === "npx" || words[0] === "yarn") out.push(`task ${name}: runs ${words[0]}`);
    if (/\bpnpm\s+(run|exec|--filter|-r|-C|--dir)\b/.test(seg)) out.push(`task ${name}: runs a pnpm script`);
  }
  return out;
}

// @spec DEPLOY-TOOL-006
test("every task runs its tool directly, never a package.json script, and vite runs in the dashboard package", () => {
  const problems = [...miseTasks().values()].flatMap((t) => t.run.flatMap((l) => runLineProblems(t.name, l)));
  assert.deepEqual(problems, []);
  assert.ok(runLineProblems("x", "pnpm run build").length > 0);
  assert.ok(runLineProblems("x", "pnpm --filter @cohost/dashboard build:ui").length > 0);
  assert.ok(runLineProblems("x", "pnpm build").length > 0);
  assert.ok(runLineProblems("x", "tsc -b && pnpm -r build").length > 0);
  assert.deepEqual(runLineProblems("install", "pnpm install --frozen-lockfile"), []);
  for (const name of ["build:ui", "dashboard:ui"]) {
    const t = task(name);
    assert.equal(rel(t.dir ?? ""), "services/dashboard", `${name} runs in services/dashboard`);
    assert.match(t.run.join("\n"), /^node_modules\/\.bin\/vite\b/m, `${name} runs the package's vite`);
  }
  const dash = JSON.parse(readRepo("services/dashboard/package.json")) as { devDependencies?: Record<string, string> };
  assert.ok(dash.devDependencies?.vite, "vite is the dashboard package's devDependency");
});

// @spec DEPLOY-TOOL-007
test("install runs the frozen pnpm install over the manifests; build:native builds and copies the addon over the Rust sources", () => {
  const install = task("install");
  assert.deepEqual(install.run, ["pnpm install --frozen-lockfile", "touch node_modules/.modules.yaml"]);
  assert.deepEqual(install.sources, ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "packages/*/package.json", "services/*/package.json"]);
  assert.deepEqual(install.outputs, ["node_modules/.modules.yaml"]);
  const native = task("build:native");
  assert.equal(native.run[0], "cargo build --release -p cohost-bus-node");
  assert.equal(native.run.at(-1), "cp target/release/libcohost_bus_node.so packages/bus/native/cohost-bus.linux-x64-gnu.node");
  assert.deepEqual(native.sources, ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates/**"]);
  assert.deepEqual(native.outputs, ["packages/bus/native/cohost-bus.linux-x64-gnu.node"]);
});

// @spec DEPLOY-TOOL-008
test("docs:build declares the docs, the docs check, the examples and the README as sources and the built index as its output", () => {
  const docs = task("docs:build");
  assert.deepEqual(docs.sources, ["docs/**", "!docs/.vitepress/dist/**", "!docs/.vitepress/cache/**", "scripts/docs-check.mjs", "examples/**", "README.md"]);
  assert.deepEqual(docs.outputs, ["docs/.vitepress/dist/index.html"]);
});

// @spec DEPLOY-TOOL-009
test("the task dependencies are exactly the specified graph", () => {
  const want: Record<string, string[]> = {
    "build:ts": ["install"], "build:ui": ["build:ts"], typecheck: ["install"], "dashboard:ui": ["build:ts"], "secrets:project": ["install"],
    "stub:llm": ["install"], "stub:tts": ["install"], "docs:build": ["install"], "docs:dev": ["install"], "docs:preview": ["install"],
    build: ["build:native", "build:ts", "build:ui"], "lint:ts": ["typecheck"], lint: ["lint:rust", "lint:ts"], test: ["build", "test:rust"],
    "test:launch": ["build", "doctor:docker"], reflect: ["build:native", "build:ts"], consolidate: ["build:native", "build:ts"], reembed: ["build:native", "build:ts"],
    "bus:pub": ["build:native", "build:ts"], "bus:tail": ["build:native", "build:ts"], "bus:bench": ["build:native", "build:ts"], "perf:connector": ["build:native", "build:ts"],
    "perf:baseline": ["build:native", "build:ts", "doctor:docker"], "hooks:schemas": ["build:ts"], cohostctl: ["build:native", "install"], dashboard: ["build:native", "build:ui"],
    "infra:up": ["doctor:docker"], "infra:down": ["doctor:docker"], smoke: ["doctor:docker"],
    "test:file": ["build"], "doctor:libatomic": [], install: [], "build:native": [], "lint:rust": [], "test:rust": [], "test:only": [], "lid-check": [], doctor: [], "doctor:docker": [],
  };
  for (const s of devServices) want[`dev:${s}`] = ["build:native", "build:ts"];
  for (const [name, deps] of Object.entries(want)) assert.deepEqual([...task(name).depends].sort(), [...deps].sort(), name);
  // The UI bundles @cohost/shared from its dist/, so a change to the shared sources must rebuild it.
  assert.deepEqual(task("build:ui").sources.map(rel), ["services/dashboard/ui/**", "packages/shared/src/**"]);
});

// @spec DEPLOY-TOOL-010
test("lint:rust checks formatting, then runs Clippy with warnings denied", () => {
  assert.deepEqual(task("lint:rust").run, ["cargo fmt --check", "cargo clippy --workspace --all-targets -- -D warnings"]);
});

// @spec DEPLOY-TOOL-011
test("lint:ts runs oxlint --type-aware --deny-warnings after typecheck, with oxlint and oxlint-tsgolint as workspace devDependencies", () => {
  assert.deepEqual(task("lint:ts").run, ["oxlint --type-aware --deny-warnings"]);
  assert.deepEqual(task("lint:ts").depends, ["typecheck"]);
  const dev = (JSON.parse(readRepo("package.json")) as { devDependencies: Record<string, string> }).devDependencies;
  assert.ok(dev.oxlint && dev["oxlint-tsgolint"], "oxlint and oxlint-tsgolint are root devDependencies");
});

// @spec DEPLOY-TOOL-012
test("test:rust runs the Rust tests and the Windows check; test and test:only run the TypeScript suite with the test tsconfig", () => {
  assert.deepEqual(task("test:rust").run, ["cargo test --workspace", "cargo check --target x86_64-pc-windows-msvc -p cohost-desktop-audio"]);
  const suite = 'scripts/test-env.sh node --import tsx --test "packages/*/test/*.test.ts" "services/*/test/*.test.ts" "services/*/test/ui/*.test.tsx"';
  for (const name of ["test", "test:only"]) {
    assert.deepEqual(task(name).run, [suite], name);
    assert.match(JSON.stringify(task(name).env), /TSX_TSCONFIG_PATH\W+tsconfig\.test\.json/, name);
  }
  assert.deepEqual(task("test:only").depends, []);
  assert.deepEqual(task("test:file").run, ["scripts/test-env.sh node --import tsx --test"], "the files given after the task name are its arguments");
  assert.match(JSON.stringify(task("test:file").env), /TSX_TSCONFIG_PATH\W+tsconfig\.test\.json/);
});

// ---------------------------------------------------------------------------------------------- task names in build files (DEPLOY-TOOL-013)

/** The task names `mise run …` / `mise watch …` name on one line (a `:::` list included). */
export function taskRefs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?:\bmise|\$\{?MISE\}?"?)\s+(run|watch)\b([^\n]*)/g)) {
    const words = m[2]!.split(/\s+/).filter(Boolean);
    let expectTask = true;
    for (const w of words) {
      if (w === "--" || /^(\|\||&&|;|\||#|\)|>|2>)/.test(w)) break;
      if (w === ":::") { expectTask = true; continue; }
      if (w.startsWith("-")) continue;
      if (expectTask) { out.push(/^[A-Za-z0-9:_.-]*(<[a-z-]+>)?/.exec(w)![0]); expectTask = false; }
    }
  }
  return out;
}
const taskDefined = (names: Set<string>, ref: string): boolean => {
  if (names.has(ref)) return true;
  const ph = /^([^<]*)<[^>]+>$/.exec(ref);
  return ph !== null && [...names].some((n) => n.startsWith(ph[1]!) && n.length > ph[1]!.length);
};
/** Unknown task names and direct pnpm/cargo commands in the shell scripts, the workflows, the Dockerfile and the dashboard's sources. */
function commandProblems(files: [string, string][], names: Set<string>): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    text.split("\n").forEach((line, i) => {
      for (const ref of taskRefs(line)) if (!taskDefined(names, ref)) out.push(`${file}:${i + 1}: mise.toml defines no task ${ref}`);
      const t = line.trimStart();
      if (t.startsWith("#") || t.startsWith("//") || t.startsWith("*")) return;
      const m = /(?:^|[\s;&|(`$"'])(pnpm|cargo)\s+([a-z-]+)/.exec(line);
      if (m) out.push(`${file}:${i + 1}: runs ${m[1]} ${m[2]} directly; use a mise task`);
    });
  }
  return out;
}
/** Every `*.sh` under `scripts/`, the installer among them. */
const shellScripts = (): [string, string][] => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(join(repoRoot, "scripts")).filter((f) => f.endsWith(".sh")).map((f) => [rel(f), readFileSync(f, "utf8")]);
};
const dashboardSources = (): [string, string][] => {
  const dir = join(repoRoot, "services/dashboard/src");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  return walk(dir).filter((f) => /\.(ts|tsx|html)$/.test(f)).map((f) => [rel(f), readFileSync(f, "utf8")]);
};

// @spec DEPLOY-TOOL-013
test("every task the shell scripts, the workflows, the Dockerfile and the dashboard name exists, and none runs pnpm or cargo directly", () => {
  const names = new Set(miseTasks().keys());
  const scripts = shellScripts();
  for (const f of ["scripts/install.sh", "scripts/dev/perf-baseline.sh"]) assert.ok(scripts.some(([p]) => p === f), `${f} is scanned`);
  const files: [string, string][] = [...scripts, ["Dockerfile", readRepo("Dockerfile")], ...Object.entries(workflows), ...dashboardSources()];
  assert.deepEqual(commandProblems(files, names), []);
  assert.deepEqual(taskRefs('"$MISE" run build || die'), ["build"]);
  assert.deepEqual(taskRefs("run: MISE_TASK_RUN_AUTO_INSTALL=false mise run docs:build"), ["docs:build"]);
  assert.deepEqual(taskRefs("MISE_JOBS=2 mise watch --restart dev:a ::: dev:b"), ["dev:a", "dev:b"]);
  assert.deepEqual(taskRefs("mise run -q cohostctl latency --count 5"), ["cohostctl"]);
  const bad = commandProblems([["scripts/install.sh", "x\nmise run buidl\n"], [".github/workflows/x.yml", "      - run: pnpm install --frozen-lockfile\n      - run: cargo test\n"], ["Dockerfile", "RUN mise watch --restart dev:nope\n"]], names);
  assert.deepEqual(bad, [
    "scripts/install.sh:2: mise.toml defines no task buidl",
    ".github/workflows/x.yml:1: runs pnpm install directly; use a mise task",
    ".github/workflows/x.yml:2: runs cargo test directly; use a mise task",
    "Dockerfile:1: mise.toml defines no task dev:nope",
  ]);
  assert.deepEqual(commandProblems([["scripts/install.sh", "mise watch --restart dev:<service>\n"]], names), [], "a placeholder matches the tasks it stands for");
});

// @spec DEPLOY-TOOL-014
test("each dev:<service> runs the built service from its directory over its and the packages' sources, never up to date; dev watches them all", () => {
  for (const s of devServices) {
    const t = task(`dev:${s}`);
    assert.deepEqual(t.run, ["node dist/index.js"], s);
    assert.equal(rel(t.dir ?? ""), `services/${s}`);
    assert.deepEqual(t.sources.map(rel), [`services/${s}/src/**`, "packages/*/src/**"]);
    assert.deepEqual(t.outputs, [], `dev:${s} declares outputs = []`);
  }
  assert.match(miseToml, /^\[tasks\."dev:affect"\][\s\S]*?^outputs = \[\]$/m, "outputs = [] is written, not left to mise's default");
  const dev = task("dev").run.join("\n");
  const m = /^MISE_JOBS=(\d+) mise watch --restart (.*)$/.exec(dev);
  assert.ok(m, dev);
  const listed = m![2]!.split(" ::: ");
  assert.deepEqual([...listed].sort(), devServices.map((s) => `dev:${s}`), "every dev:<service>, separated by :::");
  assert.equal(Number(m![1]), listed.length, "one job slot per service");
  for (const n of miseTasks().keys()) if (n.startsWith("dev:")) assert.ok(devServices.includes(n.slice(4)), `${n} is a service's dev task`);
});

// @spec DEPLOY-TOOL-015
test("the infra, smoke, lid-check, hooks, bus, perf and stub tasks run their programs, last, so arguments after the task name reach them", () => {
  assert.deepEqual(task("infra:up").run, ["docker compose up -d redis postgres ollama tts stt"]);
  assert.deepEqual(task("infra:down").run, ["docker compose stop redis postgres ollama tts stt"]);
  assert.deepEqual(task("smoke").run, ["scripts/compose-smoke.sh"]);
  assert.deepEqual(task("lid-check").run, ["node scripts/lid-check.mjs"]);
  assert.deepEqual(task("hooks:schemas").run, ["node scripts/gen-hook-schemas.mjs"]);
  for (const [name, file] of [["bus:bench", "bus-bench"], ["perf:connector", "perf-connector"], ["bus:pub", "bus-pub"], ["bus:tail", "bus-tail"], ["stub:llm", "stub-llm"], ["stub:tts", "stub-tts"]]) {
    assert.deepEqual(task(name!).run, [`tsx scripts/dev/${file}.ts`], name);
  }
  assert.deepEqual(task("perf:baseline").run, ["scripts/dev/perf-baseline.sh"]);
  // mise appends the arguments after the task name to the task's last command: the program is that command.
  assert.match(task("cohostctl").run.at(-1)!, /^node packages\/control\/dist\/cli\.js$/);
  for (const name of [...miseTasks().keys()].filter((n) => /^(bus|perf|stub|example):/.test(n))) {
    const last = task(name).run.at(-1)!;
    assert.doesNotMatch(last, /[|;&]|\|\|/, `${name}: the program is the last command, so it gets the arguments`);
    assert.equal(task(name).shell, null, `${name} runs its command through the default shell`);
  }
});

// @spec DEPLOY-TOOL-015
test("mise passes the arguments after the task name to the last command (checked against the installed mise)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mise-args-"));
  writeFileSync(join(dir, "mise.toml"), '[tasks.t]\nrun = ["echo first", "echo last"]\n');
  const env = { ...process.env, MISE_TRUSTED_CONFIG_PATHS: dir, MISE_QUIET: "1" };
  const out = execFileSync("mise", ["run", "t", "--", "a", "--flag"], { cwd: dir, encoding: "utf8", env });
  assert.deepEqual(out.trim().split("\n"), ["first", "last a --flag"]);
});

const EXAMPLE_TOOLS = /^(python3 examples\/|node (--import tsx )?examples\/|cargo run --manifest-path examples\/Cargo\.toml -p |sh examples\/|tsc -p examples\/)/;

// @spec DEPLOY-TOOL-016
test("every in-repository example a page runs has an example:* task that runs it with its tool from mise.toml", () => {
  const examples = [...miseTasks().values()].filter((t) => t.name.startsWith("example:"));
  for (const t of examples) assert.match(t.run.at(-1)!, EXAMPLE_TOOLS, t.name);
  const run = examples.map((t) => t.run.join("\n")).join("\n");
  for (const program of ["examples/modules/server.py", "examples/modules/server.ts", "cohost-example-hook-server", "examples/modules/try.sh", "examples/model-stub/stub.py", "examples/model-stub/stub.ts", "examples/model-stub/try.sh", "examples/audio-in/send.sh", "examples/audio-in/send_clip.py", "examples/audio-in/send-clip.ts", "examples/audio-in/to-wav-sox.sh", "examples/audio-in/to-wav-ffmpeg.sh", "cohost-example-bus", "examples/service/now-playing.ts", "examples/tsconfig.json"]) {
    assert.ok(run.includes(program), `an example:* task runs ${program}`);
  }
  for (const t of examples) {
    if (/now-playing|typecheck/.test(t.name)) assert.ok(dependencyClosure(t.name).has("build:ts"), `${t.name} builds the packages it imports`);
  }
});

// ---------------------------------------------------------------------------------------------- doctor (DEPLOY-TOOL-017)

/** Runs scripts/doctor.sh with only the given fake commands (plus the shell basics) on PATH. */
function doctor(args: string[], fakes: Record<string, string>): { status: number | null; stdout: string } {
  const bin = mkdtempSync(join(tmpdir(), "doctor-bin-"));
  for (const tool of ["sh", "grep", "awk", "sort", "head", "printf", "cat", "dirname"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) { writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${found} "$@"\n`); chmodSync(join(bin, tool), 0o755); }
  }
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const r = spawnSync("/bin/sh", [join(repoRoot, "scripts/doctor.sh"), ...args], { encoding: "utf8", env: { PATH: bin } });
  return { status: r.status, stdout: r.stdout };
}
const healthy = {
  docker: 'case "$1" in compose) exit 0;; info) echo "Runtimes: io.containerd.runc.v2 nvidia runc"; exit 0;; esac',
  "nvidia-smi": 'echo "GPU 0: NVIDIA (UUID: x)"',
  git: "exit 0", curl: "exit 0",
  getconf: 'echo "glibc 2.39"',
  ldconfig: 'echo "	libatomic.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libatomic.so.1"',
};

// @spec DEPLOY-TOOL-017
test("doctor prints one ✓ line per passing check and exits 0 when every prerequisite is there", () => {
  const r = doctor([], healthy);
  assert.equal(r.status, 0, r.stdout);
  const lines = r.stdout.trim().split("\n");
  assert.ok(lines.every((l) => l.startsWith("✓")), r.stdout);
  for (const what of [/libatomic\.so\.1 is installed/, /docker is on the path/, /docker compose works/, /daemon answers/, /NVIDIA runtime/, /git is on the path/, /curl is on the path/, /glibc 2\.39/]) assert.match(r.stdout, what);
});

// @spec DEPLOY-TOOL-017
test("each failing check prints ✗ and the command that fixes it, installs nothing, and the run exits non-zero", () => {
  const noCompose = doctor(["docker"], { ...healthy, docker: 'case "$1" in compose) exit 1;; info) exit 0;; esac' });
  assert.notEqual(noCompose.status, 0);
  assert.match(noCompose.stdout, /^✗ docker compose version failed\n {4}fix: .*(docker-compose-plugin|Docker Desktop)/m);
  const noDaemon = doctor(["docker"], { ...healthy, docker: 'case "$1" in compose) exit 0;; info) echo "Cannot connect to the Docker daemon" >&2; exit 1;; esac' });
  assert.match(noDaemon.stdout, /^✗ the Docker daemon does not answer\n {4}fix: /m);
  const noDocker = doctor(["docker"], { git: "exit 0" });
  assert.match(noDocker.stdout, /^✗ docker is not on the path\n {4}fix: .*(install\.sh|Docker Desktop)/m);
  const gpu = doctor(["gpu"], { ...healthy, docker: 'case "$1" in info) echo "Runtimes: runc"; exit 0;; esac' });
  assert.notEqual(gpu.status, 0);
  assert.match(gpu.stdout, /^✗ nvidia-smi reports a GPU but Docker lists no NVIDIA runtime\n {4}fix: .*nvidia/m);
  const noGpu = doctor(["gpu"], { docker: "exit 0" });
  assert.equal(noGpu.status, 0, "no GPU needs no runtime");
  const fetch = doctor(["fetch"], { git: "exit 0" });
  assert.notEqual(fetch.status, 0);
  assert.match(fetch.stdout, /^✗ curl is not on the path\n {4}fix: sudo apt-get install -y curl$/m);
  const noAtomic = doctor(["libatomic"], { ldconfig: 'echo "	libc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6"' });
  assert.notEqual(noAtomic.status, 0);
  assert.match(noAtomic.stdout, /^✗ libatomic\.so\.1 is not installed.*\n {4}fix: sudo apt install libatomic1$/m);
  const src = readRepo("scripts/doctor.sh").split("\n").filter((l) => !/^\s*(#|fail |.*fail ")/.test(l)).join("\n");
  assert.doesNotMatch(src, /apt-get install|sudo |systemctl start|usermod/, "doctor only prints fixes, it runs none");
});

// @spec DEPLOY-TOOL-017
test("a glibc below the supported floor is a warning, not a failure", () => {
  const old = doctor(["glibc"], { getconf: 'echo "glibc 2.31"' });
  assert.equal(old.status, 0);
  assert.match(old.stdout, /^! .*glibc 2\.31.*floor 2\.35/m);
  assert.doesNotMatch(old.stdout, /✗/);
});

// @spec DEPLOY-TOOL-017
test("doctor:<check> runs one check of doctor with the same output, and the tasks that need Docker depend on doctor:docker", () => {
  assert.deepEqual(task("doctor").run, ["scripts/doctor.sh"]);
  for (const c of ["docker", "gpu", "fetch", "libatomic", "glibc"]) assert.deepEqual(task(`doctor:${c}`).run, [`scripts/doctor.sh ${c}`]);
  const all = doctor([], healthy).stdout;
  for (const c of ["docker", "gpu", "fetch", "libatomic", "glibc"]) assert.ok(all.includes(doctor([c], healthy).stdout), c);
});

// ---------------------------------------------------------------------------------------------- partial installs (DEPLOY-TOOL-018)

// @spec DEPLOY-TOOL-018
test("a build that installs only some tools on purpose runs its task with auto-install off", () => {
  const docker = nonComment(readRepo("Dockerfile"));
  const runs = docker.split("\n").filter((l) => /mise run /.test(l));
  assert.ok(runs.length >= 2);
  for (const l of runs) assert.match(l, /MISE_TASK_RUN_AUTO_INSTALL=false mise run /, l);
  for (const [file, text] of Object.entries(workflows)) {
    const wf = parseYaml(text) as { jobs?: Record<string, { steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[] }> };
    for (const job of Object.values(wf.jobs ?? {})) {
      const partial = (job.steps ?? []).some((s) => s.uses?.startsWith("jdx/mise-action@") && s.with?.install_args !== undefined);
      if (!partial) continue;
      for (const s of job.steps ?? []) if (s.run?.includes("mise run")) assert.match(s.run, /^MISE_TASK_RUN_AUTO_INSTALL=false mise run /, file);
    }
  }
});

// ---------------------------------------------------------------------------------------------- the Zig wrappers (DEPLOY-TOOL-019)

/** Runs a wrapper with a fake `zig` that prints its arguments one per line. */
function wrapper(name: string, args: string[], glibc: string | undefined) {
  const bin = mkdtempSync(join(tmpdir(), "zig-bin-"));
  writeFileSync(join(bin, "zig"), '#!/bin/sh\nfor a do printf "%s\\n" "$a"; done\n');
  chmodSync(join(bin, "zig"), 0o755);
  const env: Record<string, string> = { PATH: `${bin}:/usr/bin:/bin` };
  if (glibc !== undefined) env.ZIG_GLIBC = glibc;
  const r = spawnSync(join(repoRoot, "scripts", name), args, { encoding: "utf8", env });
  return { status: r.status, argv: r.stdout === "" ? [] : r.stdout.replace(/\n$/, "").split("\n"), stderr: r.stderr };
}

// @spec DEPLOY-TOOL-019
test("zig-cc and zig-cxx map the caller's arguments exactly and target the pinned glibc", () => {
  const args = ["-m64", "--target=x86_64-unknown-linux-gnu", "a.o", "-target", "x86_64-unknown-linux-gnu", "-fuse-ld=lld", "-B/rust/gcc-ld", "-lgcc_s", "-Wl,-znostart-stop-gc", "-Wl,--as-needed", "with space", "-o", "out"];
  const kept = ["-m64", "a.o", "-lunwind", "-Wl,--as-needed", "with space", "-o", "out"];
  const cc = wrapper("zig-cc", args, "2.35");
  assert.equal(cc.status, 0, cc.stderr);
  assert.deepEqual(cc.argv, ["cc", "-target", "x86_64-linux-gnu.2.35", ...kept]);
  const cxx = wrapper("zig-cxx", args, "2.35");
  assert.deepEqual(cxx.argv, ["c++", "-target", "x86_64-linux-gnu.2.35", ...kept]);
  assert.deepEqual(wrapper("zig-cc", ["-lgcc_s", "-lgcc_s"], "2.35").argv, ["cc", "-target", "x86_64-linux-gnu.2.35", "-lunwind", "-lunwind"], "every -lgcc_s");
});

// @spec DEPLOY-TOOL-019
test("outside the mise environment (no ZIG_GLIBC) the wrappers run nothing and say to use mise; zig-ar passes its arguments unchanged", () => {
  for (const name of ["zig-cc", "zig-cxx"]) {
    for (const glibc of [undefined, ""]) {
      const r = wrapper(name, ["a.o"], glibc);
      assert.notEqual(r.status, 0, name);
      assert.deepEqual(r.argv, [], `${name} runs nothing`);
      assert.match(r.stderr, /mise run|mise exec/);
    }
  }
  assert.deepEqual(wrapper("zig-ar", ["crs", "--target=x", "-lgcc_s", "lib.a", "b.o"], undefined).argv, ["ar", "crs", "--target=x", "-lgcc_s", "lib.a", "b.o"]);
});

// ---------------------------------------------------------------------------------------------- the release key (DEPLOY-TOOL-021)

export const MISE_RELEASE_FINGERPRINT = "24853EC9F655CE80B48E6C3A8B81C9D17413A06D";
/** The primary key's fingerprint and expiry (seconds since the epoch, 0 = none) of an armored key file. */
function keyInfo(file: string): { fingerprint: string; expires: number } {
  const home = mkdtempSync(join(tmpdir(), "gpg-show-"));
  const out = execFileSync("gpg", ["--homedir", home, "--batch", "--with-colons", "--show-keys", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const lines = out.split("\n");
  const pub = lines.findIndex((l) => l.startsWith("pub:"));
  const fpr = lines.slice(pub + 1).find((l) => l.startsWith("fpr:"))!.split(":")[9]!;
  return { fingerprint: fpr, expires: Number(lines[pub]!.split(":")[6] || 0) };
}
const keyProblems = (info: { fingerprint: string; expires: number }, now: number): string[] => {
  const out: string[] = [];
  if (info.fingerprint !== MISE_RELEASE_FINGERPRINT) out.push(`scripts/mise-release-key.asc: primary key ${info.fingerprint}, expected ${MISE_RELEASE_FINGERPRINT}`);
  if (info.expires !== 0 && info.expires - now < 90 * 86400) out.push(`scripts/mise-release-key.asc: the key expires ${new Date(info.expires * 1000).toISOString().slice(0, 10)}, within 90 days; refresh it from mise's documentation or keys.openpgp.org`);
  return out;
};

// @spec DEPLOY-TOOL-021
test("the committed mise release key is the pinned key and does not expire within 90 days", () => {
  const now = Math.floor(Date.now() / 1000);
  const info = keyInfo(join(repoRoot, "scripts/mise-release-key.asc"));
  assert.deepEqual(keyProblems(info, now), []);
  assert.equal(keyProblems({ ...info, fingerprint: "0".repeat(40) }, now).length, 1, "another key fails");
  assert.equal(keyProblems(info, info.expires - 89 * 86400).length, 1, "expiring within 90 days fails");
  assert.equal(keyProblems(info, info.expires - 91 * 86400).length, 0);
});

// ---------------------------------------------------------------------------------------------- package.json (DEPLOY-REPO-002)

const workspacePackageJsons = (): string[] => ["package.json", ...["packages", "services"].flatMap((d) => readdirSync(join(repoRoot, d)).map((p) => `${d}/${p}/package.json`).filter((f) => existsSync(join(repoRoot, f))))];
const packageJsonProblems = (files: [string, string][]): string[] => {
  const out: string[] = [];
  for (const [file, text] of files) {
    const p = JSON.parse(text) as Record<string, unknown>;
    if ("scripts" in p) out.push(`${file}: has a scripts key; commands are mise.toml tasks`);
    if (file === "package.json") {
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(String(p.packageManager))) out.push(`${file}: packageManager is not an exact pnpm@x.y.z`);
      if ("engines" in p) out.push(`${file}: has an engines field; mise.toml decides the Node version`);
    }
  }
  return out;
};

// @spec DEPLOY-REPO-002
test("no workspace package.json has scripts; the root pins pnpm exactly through packageManager and has no engines", () => {
  const files = workspacePackageJsons().map((f) => [f, readRepo(f)] as [string, string]);
  assert.ok(files.length > 10);
  assert.deepEqual(packageJsonProblems(files), []);
  assert.deepEqual(packageJsonProblems([["services/x/package.json", '{"name":"x","scripts":{"dev":"tsx"}}']]), ["services/x/package.json: has a scripts key; commands are mise.toml tasks"]);
  assert.equal(packageJsonProblems([["package.json", '{"packageManager":"pnpm@12","engines":{"node":">=26"}}']]).length, 2);
});

// ---------------------------------------------------------------------------------------------- the image (DEPLOY-IMG-001, DEPLOY-IMG-006)

// @spec DEPLOY-IMG-006
test("the Dockerfile runs no cargo, pnpm, npm, corepack or tsc of its own and builds through mise tasks", () => {
  const code = nonComment(readRepo("Dockerfile"));
  const runs = code.split(/\n(?=[A-Z]+\s)/).filter((i) => i.startsWith("RUN "));
  for (const r of runs) assert.doesNotMatch(r.replace(/MISE_[A-Z_]+=\S+\s+/g, ""), /(^|[\s;&|])(cargo|pnpm|npm|npx|corepack|tsc)\s/, r);
  assert.match(code, /mise run build:native/);
  assert.match(code, /mise run build:ts/);
  // versions: only ARG MISE_VERSION and the runtime node: tag (both held by DEPLOY-TOOL-002)
  const versions = [...code.matchAll(/\b\d+\.\d+\.\d+\b/g)].map((m) => m[0]);
  const min = tomlString(miseToml, "min_version"), node = tomlString(miseToml, "node", "tools");
  assert.deepEqual([...new Set(versions)].sort(), [min, node].sort(), "no other toolchain version");
});

// @spec DEPLOY-IMG-001
test("the Dockerfile's stages: toolchain from debian with mise, native with Rust and Zig only, build with Node and pnpm, runtime from node", () => {
  const code = nonComment(readRepo("Dockerfile"));
  const stage = (name: string) => {
    const at = code.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"));
    assert.ok(at >= 0, `stage ${name}`);
    const rest = code.slice(at + 1);
    const next = rest.search(/^FROM /m);
    return next < 0 ? code.slice(at) : code.slice(at, at + 1 + next);
  };
  const toolchain = stage("toolchain");
  assert.match(toolchain, /^FROM debian:13\.\d+-slim AS toolchain$/m);
  assert.match(toolchain, /apt-get install -y --no-install-recommends ca-certificates curl gnupg libatomic1/);
  assert.match(toolchain, /fetch-mise\.sh "\$MISE_VERSION" \/usr\/local\/bin\/mise/);
  assert.doesNotMatch(toolchain, /build-essential|gcc|clang/);
  const native = stage("native");
  assert.match(native, /^FROM toolchain AS native$/m);
  assert.match(native, /^RUN mise install --locked rust zig$/m);
  // mise install reads Zig's version and the locked downloads from mise.toml and mise.lock, so they are copied first.
  const install = native.search(/^RUN mise install --locked rust zig$/m);
  for (const f of ["rust-toolchain.toml", "mise.toml", "mise.lock"]) {
    const copy = native.search(new RegExp(`^COPY [^\\n]*(?<=\\s)${f.replace(/\./g, "\\.")}(?=\\s)[^\\n]*$`, "m"));
    assert.ok(copy >= 0 && copy < install, `the native stage copies ${f} before mise install --locked rust zig`);
  }
  assert.match(native, /COPY scripts\/zig-cc scripts\/zig-cxx scripts\/zig-ar/);
  for (const c of ["/root/.local/share/mise/cargo/registry", "/root/.local/share/mise/zig-cache", "/app/target"]) assert.ok(native.includes(`--mount=type=cache,target=${c}`), c);
  assert.doesNotMatch(native, /package\.json|install --locked node|napi/);
  const build = stage("build");
  assert.match(build, /^FROM toolchain AS build$/m);
  assert.match(build, /^RUN mise install --locked node pnpm$/m);
  assert.match(build, /COPY --from=native \/app\/packages\/bus\/native\/cohost-bus\.linux-x64-gnu\.node \.\/packages\/bus\/native\//);
  const runtime = stage("runtime");
  assert.match(runtime, /^FROM node:\S+-trixie-slim AS runtime$/m);
  assert.match(runtime, /COPY --from=build \/app \/app/);
  assert.doesNotMatch(runtime, /mise|cargo|zig/i);
});

// @spec DEPLOY-TOOL-022
test("the test tasks run through test-env.sh, which gives the run temporary data and config directories and removes them", () => {
  for (const name of ["test", "test:only", "test:file", "test:launch"]) {
    for (const line of task(name).run) assert.match(line, /^scripts\/test-env\.sh node /, `${name}: ${line}`);
  }
  const script = join(repoRoot, "scripts", "test-env.sh");
  const probe = "for k in COHOST_DATA_DIR CONFIG_DIR COHOST_ENV_FILE COHOST_SECRETS_FILE; do printf '%s=%s\\n' \"$k\" \"${!k}\"; done; ls \"$CONFIG_DIR\"; exit 3";
  const r = spawnSync(script, ["bash", "-c", probe], { encoding: "utf8", cwd: repoRoot, env: { PATH: process.env.PATH!, COHOST_DATA_DIR: "/owner/data", CONFIG_DIR: "/owner/config" } });
  assert.equal(r.status, 3, `the command's status is the run's status: ${r.stderr}`);
  const vars = Object.fromEntries(r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=") as [string, string]));
  const data = vars.COHOST_DATA_DIR!;
  const conf = vars.CONFIG_DIR!;
  assert.ok(data && conf && data !== conf, r.stdout);
  for (const dir of [data, conf]) assert.ok(dir.startsWith(tmpdir()) || dir.startsWith("/tmp"), `${dir} is a temporary directory`);
  assert.ok(!data.startsWith(repoRoot) && !conf.startsWith(repoRoot));
  assert.equal(vars.COHOST_ENV_FILE, join(conf, ".env"));
  assert.equal(vars.COHOST_SECRETS_FILE, join(conf, "secrets", "secrets.yaml"));
  const examples = readdirSync(join(repoRoot, "config")).filter((f) => f.includes(".example.")).sort();
  for (const f of examples) assert.ok(r.stdout.split("\n").includes(f), `${f} copied`);
  assert.equal(existsSync(data), false, "the data directory is removed");
  assert.equal(existsSync(conf), false, "the config directory is removed");
});
