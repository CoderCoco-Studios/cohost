import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseConfigText } from "../../src/index.js";

/** Helpers of docs-guides.test.ts: the Extend pages' config fragments and the examples' Cargo lock. */

export interface Fence { line: number; lang: string; text: string }

/** The fenced blocks of a Markdown text (backtick or tilde), each with the 1-based line of its opening fence. */
export function fences(markdown: string): Fence[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: Fence[] = [];
  let open: { ch: string; len: number; fence: Fence; body: string[] } | null = null;
  lines.forEach((line, i) => {
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (open) {
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && /^\s{0,3}(`+|~+)\s*$/.test(line)) {
        open.fence.text = open.body.join("\n");
        open = null;
      } else open.body.push(line);
    } else if (m) {
      const fence: Fence = { line: i + 1, lang: m[2]!.split(/[{:[]/)[0]!.toLowerCase(), text: "" };
      out.push(fence);
      open = { ch: m[1]![0]!, len: m[1]!.length, fence, body: [] };
    }
  });
  return out;
}

const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** `over` laid on `base`: mappings merge key by key, any other value (scalar or list) of `over` replaces. */
export function layer(base: unknown, over: unknown): unknown {
  if (!isMap(base) || !isMap(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? layer(base[k], v) : v;
  return out;
}

/**
 * Lays a YAML fragment over `exampleYaml` and runs the result through the config loader's pipeline (no secrets, no override), so
 * a placeholder fails as it does in a real `config.yaml`. Returns null when it parses, otherwise the problem text.
 */
export function fragmentProblem(exampleYaml: string, fragment: string): string | null {
  let merged: unknown;
  try {
    merged = layer(parseYaml(exampleYaml), parseYaml(fragment));
  } catch (e) {
    return `not valid YAML: ${(e as Error).message}`;
  }
  const r = parseConfigText(stringifyYaml(merged));
  return r.ok ? null : r.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
}

/** Every `yaml` or `yml` fence of every Extend page (`docs/advanced/extend/*.md`): `{ page, line, text }`. */
export function extendYamlFences(root: string): { page: string; line: number; text: string }[] {
  const dir = join(root, "docs/advanced/extend");
  if (!existsSync(dir)) return [];
  const out: { page: string; line: number; text: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).toSorted()) {
    for (const fence of fences(readFileSync(join(dir, f), "utf8"))) {
      if (fence.lang === "yaml" || fence.lang === "yml") out.push({ page: `docs/advanced/extend/${f}`, line: fence.line, text: fence.text });
    }
  }
  return out;
}

/** `[[package]]` entries of a Cargo.lock: name to the set of versions it holds. */
export function lockVersions(lock: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name)!.add(version);
  }
  return out;
}

/** Packages both locks hold where the examples lock has a version the root lock does not: `name examples-version (root: versions)`. */
export function lockMismatches(rootLock: string, examplesLock: string): string[] {
  const root = lockVersions(rootLock);
  const out: string[] = [];
  for (const [name, versions] of lockVersions(examplesLock)) {
    const have = root.get(name);
    if (!have) continue;
    for (const v of versions) if (!have.has(v)) out.push(`${name} ${v} (root Cargo.lock: ${[...have].join(", ")})`);
  }
  return out;
}

/** The strings of `workspace.members` in a Cargo.toml text. */
export function workspaceMembers(toml: string): string[] {
  const text = toml.replace(/#.*$/gm, "");
  const section = /^\[workspace\]\s*\n([\s\S]*?)(?=^\s*\[[A-Za-z]|(?![\s\S]))/m.exec(text);
  const m = section ? /members\s*=\s*\[([\s\S]*?)\]/.exec(section[1]!) : null;
  return m ? [...m[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((x) => (x[1] ?? x[2])!) : [];
}

/** Every `.ts` file (not `.d.ts`) under `dir`, as POSIX paths relative to `root`, skipping build output and installed packages. */
export function tsFilesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = posix.join(rel, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "target") walk(next);
      } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && statSync(join(root, next)).isFile()) out.push(next);
    }
  };
  walk(dir);
  return out.toSorted();
}
