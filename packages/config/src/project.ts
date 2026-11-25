import { realpathSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Document, isMap } from "yaml";
import { secretPathMatches } from "./schema.js";
import { loadSecrets } from "./secrets.js";
import { writeFileAtomic } from "./atomic.js";
import { secretsPath } from "./index.js";

/** One unit of the projection: its Compose service name and the secret paths of its manifest entry (a path of `SECRET_PATHS`). */
export interface SecretUnit {
  composeName: string;
  secrets: readonly string[];
}

/** The real path of `p` with every link resolved; a path that does not exist yet resolves through its nearest existing parent. */
function realPathOf(p: string): string | undefined {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* not there: resolve the parent */ }
  const parent = dirname(abs);
  if (parent === abs) return undefined;
  const up = realPathOf(parent);
  return up === undefined ? undefined : join(up, basename(abs));
}

/** A Compose service name as the manifest spells one; anything else could name a path outside `secrets/units/`. */
const UNIT_NAME = /^[a-z0-9-]+$/;

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The text of a unit's projection: the declared paths the operator's file holds, nested as it is, and nothing else. */
function unitText(values: Readonly<Record<string, string>>, declared: readonly string[]): string {
  const doc = new Document({});
  let any = false;
  for (const [path, value] of Object.entries(values)) {
    if (declared.some((d) => secretPathMatches(path, d))) { doc.setIn(path.split("."), value); any = true; }
  }
  return any && isMap(doc.contents) ? doc.toString({ lineWidth: 0 }) : "{}\n";
}

/**
 * Writes `secrets/units/<composeName>/secrets.yaml` under `root` for every unit that declares a secret path: the operator's
 * file (`secretsPath()`, read with the loader's rules) cut down to exactly those paths. Each file is replaced by rename with
 * mode 0600 in a 0700 directory, a directory under `secrets/units/` that names no such unit is removed, and nothing is written
 * when the operator's file, a link or a directory is unusable. Rejects with an error that names a file, directory or path,
 * never a value.
 */
// @spec CFG-SEC-019, DEPLOY-SECRET-003, DEPLOY-SECRET-005, DEPLOY-SECRET-007, DEPLOY-SECRET-009, DEPLOY-SECRET-010
export async function projectSecrets(root: string, units: readonly SecretUnit[]): Promise<void> {
  for (const u of units) {
    if (!UNIT_NAME.test(u.composeName)) throw new Error(`Cannot project secrets: ${JSON.stringify(u.composeName)} is not a unit name (lower-case letters, digits and hyphens)`);
  }
  const secretsDir = join(root, "secrets");
  const unitsDir = join(secretsDir, "units");
  for (const dir of [secretsDir, unitsDir]) {
    if (isLink(dir)) throw new Error(`Cannot project secrets: ${dir} is a symbolic link`);
  }
  const declaring = units.filter((u) => u.secrets.length > 0);
  for (const u of declaring) {
    const dir = join(unitsDir, u.composeName);
    if (isLink(dir)) throw new Error(`Cannot project secrets: ${dir} is a symbolic link`);
  }

  const file = secretsPath();
  const real = realPathOf(file);
  for (const sub of ["config", "data", join("secrets", "units")]) {
    const dir = realPathOf(join(root, sub));
    if (dir !== undefined && real !== undefined && (real === dir || real.startsWith(dir + sep))) {
      throw new Error(`Cannot project secrets: ${file} resolves inside ${join(root, sub)}, which a container mounts`);
    }
  }
  const { values } = loadSecrets(file);

  mkdirSync(unitsDir, { recursive: true, mode: 0o700 });
  for (const u of declaring) {
    const dir = join(unitsDir, u.composeName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, "secrets.yaml"), unitText(values, u.secrets), { mode: 0o600 });
  }
  const keep = new Set(declaring.map((u) => u.composeName));
  for (const name of readdirSync(unitsDir)) {
    if (!keep.has(name)) rmSync(join(unitsDir, name), { recursive: true, force: true });
  }
}
