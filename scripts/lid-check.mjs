#!/usr/bin/env node
/**
 * LID coherence check (deployment DEPLOY-CI-006): a deterministic, read-only pass over the repository that
 * keeps the arrow of intent honest. It reports, one line per offence:
 *   - a `@spec` ID cited outside the spec files that no `*-specs.md` file defines;
 *   - an ID defined twice;
 *   - an ID a spec file mentions that no spec file defines, unless the mentioning line says it is retired, moved or superseded;
 *   - a workflow `uses:` ref that is not an exact `vX.Y.Z` tag or a full commit SHA, one action pinned to two different refs
 *     across workflows, or a workflow or Compose `image:` whose tag is missing, `latest` or not an exact `x.y.z` version (DEPLOY-CI-009);
 * Exits 1 when there is any offence, 0 otherwise. Needs only Node.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /\b[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+-\d{3}\b/g;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "graphify-out", ".vitepress"]);
const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs|sh|yml|yaml|html)$|(?:^|\/)Dockerfile$/;

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
  problems.push(...checkPins(root, files));
  return { problems, defined: defined.size };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const { problems, defined } = check(root);
  for (const p of problems) console.error(p);
  console.log(`lid-check: ${defined} specs defined, ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  process.exit(problems.length ? 1 : 0);
}
