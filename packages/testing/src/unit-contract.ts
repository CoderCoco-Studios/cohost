/**
 * Per-unit contract checks shared by each service's `contract.test.ts` and the derived-lists test: the entry-file
 * check (MOD-MAN-009) and the declared-sections check (MOD-MAN-011). The manifest is loaded from the built control
 * package by path so no service needs a dependency on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseConfigText, schemaAt } from "@cohost/config";

const repoPath = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

/** The code of a source file with comments removed. */
const codeOf = (file: string): string => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();
const hasCall = (code: string, fn: string): boolean => new RegExp(`\\b${fn}\\s*(<[^>]*>)?\\(`).test(code);

export const OWN_BOOTSTRAP = /\bnew Bus\(|\bstartHeartbeat\(|\bonShutdown\(/;

/** Why the unit's entry file does not reach `runService`, or undefined when it does. */
// @spec MOD-MAN-009
export function entryProblem(id: string): string | undefined {
  const code = codeOf(repoPath(`services/${id}/src/index.ts`));
  if (OWN_BOOTSTRAP.test(code)) return "the entry builds its own bus, heartbeat or shutdown";
  if (hasCall(code, "runService")) return undefined;
  // otherwise its sole job is one call to a boot function whose module calls runService
  const imports = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+)\.js"/g)];
  const boot = imports.find(([, names]) => names!.split(",").some((n) => new RegExp(`\\b${n.trim().split(/\s+as\s+/)[0]}\\s*\\(`).test(code)));
  if (!boot) return "the entry neither calls runService nor calls a boot function";
  return hasCall(codeOf(repoPath(`services/${id}/src/${boot[2]}.ts`)), "runService") ? undefined : `${boot[2]}.ts does not call runService`;
}

interface Unit { id: string; config: readonly string[] }

async function manifestUnit(id: string): Promise<Unit> {
  const mod = (await import(pathToFileURL(repoPath("packages/control/dist/manifest.js")).href)) as { SERVICE_MANIFEST: (Unit & { pnpmFilter?: string })[] };
  const u = mod.SERVICE_MANIFEST.find((s) => s.id === id && s.pnpmFilter);
  assert.ok(u, `${id} is not a unit of the manifest`);
  return u;
}

const at = (raw: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((cur, seg) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined), raw);

/** Registers the two per-service contract tests for unit `id`. */
export function unitContractTests(id: string): void {
  test(`${id}: the entry reaches runService and builds no bus, heartbeat or shutdown of its own`, () => {
    assert.equal(entryProblem(id), undefined);
  });

  test(`${id}: every declared config section is a schema path and validates the example`, async () => {
    const unit = await manifestUnit(id);
    assert.ok(unit.config.length > 0, "a unit declares at least one section");
    const parsed = parseConfigText(readFileSync(repoPath("config/config.example.yaml"), "utf8"), {});
    assert.ok(parsed.ok, "the example validates as a whole");
    const example = parsed.config as unknown;
    for (const section of unit.config) {
      const schema = schemaAt(section);
      assert.ok(schema, `${section} is not a path of ConfigSchema`);
      const value = at(example, section);
      const r = schema.safeParse(value);
      assert.ok(r.success, `${section}: ${r.success ? "" : JSON.stringify(r.error.issues)}`);
    }
  });
}
