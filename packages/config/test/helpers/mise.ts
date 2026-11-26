/**
 * The repository's mise.toml as the tests read it. Task definitions come from mise itself (`mise tasks ls --json`), so a
 * test sees what `mise run` runs; text checks read the file. mise is on the path whenever the suite runs: the suite runs
 * as a mise task.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const readRepo = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

export interface MiseTask {
  name: string;
  run: string[];
  depends: string[];
  sources: string[];
  outputs: string[] | { auto: boolean };
  dir: string | null;
  env: unknown;
  shell: string | null;
}

let cached: Map<string, MiseTask> | undefined;

/** Every task mise.toml defines, by name. */
export function miseTasks(): Map<string, MiseTask> {
  if (cached) return cached;
  const out = execFileSync("mise", ["tasks", "ls", "--json", "--hidden"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, MISE_QUIET: "1" } });
  const list = JSON.parse(out) as MiseTask[];
  cached = new Map(list.map((t) => [t.name, t]));
  return cached;
}

export function task(name: string): MiseTask {
  const t = miseTasks().get(name);
  if (!t) throw new Error(`mise.toml defines no task ${name}`);
  return t;
}

/** The tasks `name` runs first, transitively (its dependency closure, without itself). */
export function dependencyClosure(name: string): Set<string> {
  const seen = new Set<string>();
  const walk = (n: string) => {
    for (const d of task(n).depends) {
      if (seen.has(d)) continue;
      seen.add(d);
      walk(d);
    }
  };
  walk(name);
  return seen;
}

/** A path mise reports, relative to the repository root (mise resolves `{{config_root}}`). */
export const rel = (p: string): string => (p.startsWith(repoRoot) ? p.slice(repoRoot.length) : p);
