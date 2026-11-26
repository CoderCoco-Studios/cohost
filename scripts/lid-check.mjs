#!/usr/bin/env node
/**
 * LID coherence check (deployment DEPLOY-CI-006): a deterministic, read-only pass over the repository that
 * keeps the arrow of intent honest. It reports, one line per offence:
 *   - a `@spec` ID cited outside the spec files that no `*-specs.md` file defines;
 *   - an ID defined twice;
 *   - an ID a spec file mentions that no spec file defines, unless the mentioning line says it is retired, moved or superseded;
 *   - a workflow `uses:` ref that is not an exact `vX.Y.Z` tag or a full commit SHA, one action pinned to two different refs
 *     across workflows, or a workflow or Compose `image:` whose tag is missing, `latest` or not an exact `x.y.z` version (DEPLOY-CI-009);
 *   - a Compose `build:` context that is a Git URL whose ref after `#` is not a full commit SHA (DEPLOY-CI-010);
 *   - under `docker/`, a `cargo install` without an exact `=x.y.z` version or without `--locked`, a `FROM` whose tag is
 *     missing, `latest` or not an exact version, and a `git clone` or an `ADD` of a Git URL not pinned to a full commit SHA (DEPLOY-CI-011);
 *   - a workflow step that is neither a `uses:` action nor a `run:` of exactly one `mise run <task>` (DEPLOY-CI-012);
 * Exits 1 when there is any offence, 0 otherwise. Needs only Node.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+-\d{3}\b/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "worktrees", "graphify-out", ".vitepress", "target"]);
const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs|sh|yml|yaml|html|rs|toml)$|(?:^|\/)Dockerfile$|^scripts\/[^/.]+$/;

/** Every file under `root`, as repo-relative POSIX paths, in sorted order. */
function walk(root, dir = root, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** The ID a spec line defines: `- [x] **ID**:`, with the marker `x`, space or D. */
const DEFINITION = /^\s*- \[[ xD]\] \*\*([A-Z0-9-]+-\d{3})\*\*/;

const LINEAGE = /retire|moved from|supersed|replac|formerly/i;

const EXACT_TAG = /^v\d+\.\d+\.\d+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const IMAGE_FILE = /^(?:\.github\/workflows\/[^/]+\.ya?ml|docker-compose[^/]*\.ya?ml)$/;

/** The default of a `${VAR:-default}` reference, or the text itself. Null when it has no default to judge. */
function imageDefault(ref) {
  const m = /^\$\{[A-Z0-9_]+(?::?-(.*))?\}$/.exec(ref);
  if (!m) return ref;
  return m[1] ?? null;
}

// @spec DEPLOY-CI-009
export function checkPins(root, files) {
  const problems = [];
  const actionRefs = new Map(); // action -> { ref, where }
  for (const f of files.filter((x) => IMAGE_FILE.test(x))) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    lines.forEach((raw, i) => {
      const text = raw.replace(/\s+#.*$/, "");
      const where = `${f}:${i + 1}`;
      const use = /^\s*(?:-\s+)?uses:\s*(\S+)\s*$/.exec(text);
      if (use && !use[1].startsWith("./")) {
        const [action, ref] = use[1].split("@");
        if (!ref || !(EXACT_TAG.test(ref) || FULL_SHA.test(ref))) {
          problems.push(`${where}: ${use[1]} is not pinned to an exact vX.Y.Z tag or a full commit SHA`);
        } else {
          const seen = actionRefs.get(action);
          if (seen && seen.ref !== ref) problems.push(`${where}: ${action} is pinned to ${ref} but ${seen.where} pins ${seen.ref}`);
          else if (!seen) actionRefs.set(action, { ref, where });
        }
      }
      const img = /^\s*(?:-\s+)?image:\s*(\S+)\s*$/.exec(text);
      if (img) {
        const resolved = imageDefault(img[1].replace(/^["']|["']$/g, ""));
        if (resolved === null) return;
        const name = resolved.slice(resolved.lastIndexOf("/") + 1);
        const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : "";
        if (!/\d+\.\d+\.\d+/.test(tag) || /^latest$/i.test(tag)) {
          problems.push(`${where}: image ${resolved} is not pinned to an exact x.y.z tag`);
        }
      }
    });
  }
  return problems;
}

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** One `mise run <task>` command: optional leading NAME=value assignments, `mise run`, its flags, one task, the task's arguments. */
const ONE_MISE_RUN = /^(?:[A-Z_][A-Z0-9_]*=[^\s;&|<>`$()]*\s+)*mise\s+run\s+(?:-\S+\s+)*[A-Za-z0-9][\w:.-]*(?:\s+[^\s;&|<>`$()]+)*$/;

/** The steps of every `steps:` list in a workflow: their keys and the line each starts on. Reads YAML as text (no install). */
function workflowSteps(text) {
  const lines = text.split("\n");
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)steps:\s*$/.exec(lines[i]);
    if (!head) continue;
    const base = head[1].length;
    let item = -1;
    let step = null;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
      const indent = raw.length - raw.trimStart().length;
      if (indent <= base) break;
      const dash = /^(\s*)-\s+(.*)$/.exec(raw);
      if (dash && (item < 0 || dash[1].length === item)) {
        item = dash[1].length;
        step = { line: j + 1, keys: {} };
        steps.push(step);
        const kv = /^([\w-]+):\s*(.*)$/.exec(dash[2]);
        if (kv) step.keys[kv[1]] = blockValue(lines, j, item + 2, kv[2]);
        continue;
      }
      if (!step) continue;
      const kv = new RegExp(`^\\s{${item + 2}}([\\w-]+):\\s*(.*)$`).exec(raw);
      if (kv) step.keys[kv[1]] = blockValue(lines, j, item + 2, kv[2]);
    }
  }
  return steps;
}

/** A key's value; for a `|` or `>` block scalar, its lines (indented deeper than the key) joined with newlines. */
function blockValue(lines, at, keyIndent, inline) {
  const v = inline.replace(/\s+#.*$/, "").trim();
  if (!/^[|>][-+]?$/.test(v)) return v.replace(/^(["'])(.*)\1$/, "$2");
  const out = [];
  for (let k = at + 1; k < lines.length; k++) {
    const raw = lines[k];
    if (raw.trim() && raw.length - raw.trimStart().length <= keyIndent) break;
    out.push(raw.trim());
  }
  return out.filter(Boolean).join("\n");
}

// @spec DEPLOY-CI-012
export function checkWorkflowSteps(root, files) {
  const problems = [];
  for (const f of files.filter((x) => WORKFLOW.test(x))) {
    for (const step of workflowSteps(readFileSync(join(root, f), "utf8"))) {
      const { uses, run } = step.keys;
      if (uses !== undefined && run === undefined) continue;
      if (run !== undefined && uses === undefined) {
        if (!run.includes("\n") && ONE_MISE_RUN.test(run)) continue;
      }
      problems.push(`${f}:${step.line}: a workflow step must be a uses: action or a run: of exactly one mise run <task>`);
    }
  }
  return problems;
}

const GIT_URL = /^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)/;
const FULL_SHA_TEXT = /^[0-9a-f]{40}$/;
const CHECKOUT_SHA = /\bgit\b[^&;|]*\bcheckout\s+[0-9a-f]{40}(?![0-9a-f])/;
const DIGEST_PIN = /@sha256:[0-9a-f]{64}$/;
const EXACT_VERSION_TAG = /^\d+\.\d+\.\d+(?:[-.][\w.-]*)?$/;
const COMPOSE_FILE = /^docker-compose[^/]*\.ya?ml$/;
const DOCKERFILE = /^docker\/(?:[^/]+\/)*Dockerfile$/;

/** The ref of a Git URL (the text after `#`, up to a `:subdir`), or an empty string when the URL has no fragment. */
function gitRef(url) {
  const hash = url.indexOf("#");
  return hash < 0 ? "" : url.slice(hash + 1).split(":")[0];
}

// @spec DEPLOY-CI-010
export function checkBuildContexts(root, files) {
  const problems = [];
  for (const f of files.filter((x) => COMPOSE_FILE.test(x))) {
    readFileSync(join(root, f), "utf8").split("\n").forEach((raw, i) => {
      const text = raw.replace(/\s+#.*$/, "");
      const build = /\b(?:context|build)\s*:\s*([^\s,}\]]+)/.exec(text);
      if (!build) return;
      const value = build[1].replace(/^["']|["']$/g, ""); // a quoted value is the same value
      if (!GIT_URL.test(value)) return;
      if (!FULL_SHA_TEXT.test(gitRef(value))) {
        problems.push(`${f}:${i + 1}: Git build context ${value} does not name a full commit SHA after its #`);
      }
    });
  }
  return problems;
}

// @spec DEPLOY-CI-011
export function checkDockerfiles(root, files) {
  const problems = [];
  for (const f of files.filter((x) => DOCKERFILE.test(x))) {
    const stages = new Set();
    readFileSync(join(root, f), "utf8").split("\n").forEach((raw, i) => {
      if (raw.trimStart().startsWith("#")) return;
      const where = `${f}:${i + 1}`;
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(raw);
      if (from) {
        const image = from[1];
        // A digest (`image@sha256:<64 hex>`) is a full pin on its own; otherwise the tag must be an exact version.
        if (!stages.has(image.toLowerCase()) && image.toLowerCase() !== "scratch" && !DIGEST_PIN.test(image)) {
          const name = image.slice(image.lastIndexOf("/") + 1);
          const tag = name.includes(":") ? name.slice(name.indexOf(":") + 1) : undefined;
          if (tag === undefined || /^latest/i.test(tag) || !EXACT_VERSION_TAG.test(tag)) {
            problems.push(`${where}: FROM ${image} is not pinned to an exact version tag`);
          }
        }
        if (from[2]) stages.add(from[2].toLowerCase());
      }
      if (/\bcargo\s+install\b/.test(raw) && (!/\s--locked(?=\s|$)/.test(raw) || !/\s--version\s+=\d+\.\d+\.\d+(?=\s|$)/.test(raw))) {
        problems.push(`${where}: cargo install must pin an exact version as =x.y.z and pass --locked`);
      }
      // The clone's ref is the commit it checks out: a full SHA as the argument of `git ... checkout`, not any 40-hex text.
      if (/\bgit\s+clone\b/.test(raw) && !CHECKOUT_SHA.test(raw)) {
        problems.push(`${where}: git clone is not pinned to a full commit SHA checked out by git checkout`);
      }
      const add = /^\s*ADD\s+(\S+)/.exec(raw);
      if (add && GIT_URL.test(add[1]) && /\.git(?:#|$)/.test(add[1]) && !FULL_SHA_TEXT.test(gitRef(add[1]))) {
        problems.push(`${where}: ADD of a Git URL is not pinned to a full commit SHA after its #`);
      }
    });
  }
  return problems;
}

// @spec DEPLOY-CI-006
export function check(root) {
  const files = walk(root);
  const specFiles = files.filter((f) => f.endsWith("-specs.md"));
  const problems = [];
  const defined = new Map(); // id -> "file:line"
  const mentions = []; // { id, file, line, text }

  for (const f of specFiles) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    lines.forEach((text, i) => {
      const def = DEFINITION.exec(text);
      if (def) {
        const id = def[1];
        if (defined.has(id)) problems.push(`${f}:${i + 1}: ${id} is defined twice (first at ${defined.get(id)})`);
        else defined.set(id, `${f}:${i + 1}`);
      }
      for (const m of text.matchAll(ID)) mentions.push({ id: m[0], file: f, line: i + 1, text });
    });
  }

  // A spec file may name an ID it does not define only to say it is retired.
  for (const m of mentions) {
    if (defined.has(m.id)) continue;
    if (LINEAGE.test(m.text)) continue;
    problems.push(`${m.file}:${m.line}: ${m.id} is mentioned but defined in no spec file (and the line does not say it is retired)`);
  }

  for (const f of files) {
    if (specFiles.includes(f) || !CODE_EXT.test(f)) continue;
    if (f === "scripts/lid-check.mjs") continue;
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    lines.forEach((text, i) => {
      const at = text.indexOf("@spec ");
      if (at < 0) return;
      for (const m of text.slice(at).matchAll(ID)) {
        if (!defined.has(m[0])) problems.push(`${f}:${i + 1}: @spec ${m[0]} is defined in no spec file`);
      }
    });
  }
  problems.push(...checkPins(root, files), ...checkWorkflowSteps(root, files), ...checkBuildContexts(root, files), ...checkDockerfiles(root, files));
  return { problems, defined: defined.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, defined } = check(root);
  for (const p of problems) console.error(p);
  console.log(`lid-check: ${defined} specs defined, ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(problems.length ? 1 : 0);
}
