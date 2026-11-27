/**
 * Projections (settings-store STORE-PROJ-*): what a unit may read of the settings, written as plain JSON for the unit's
 * container to mount read-only at `/app/config` and for a host-run unit to read through `CONFIG_DIR`. A projection holds the
 * stored sections the unit's manifest entry declares and the documents it declares, never a credential, a key or a verifier.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OLLAMA_MODEL_SECTIONS, PROJECTION_FILE, PROJECTION_FORMAT, UNIT_SETTINGS, writeFileAtomic, type DocumentName, type Projection, type UnitSettings } from "@cohost/config";
import type { Store } from "./store.js";

/** The projection of the `models` container (STORE-PROJ-005): the sections `ollamaModels` reads, no document. */
export const MODELS_PROJECTION = { id: "models", composeName: "models", config: OLLAMA_MODEL_SECTIONS, documents: [] as readonly DocumentName[] } as const;

/** What a projection is written for: a unit's id and Compose name, and the sections and documents it declares. */
export type ProjectionUnit = Pick<UnitSettings, "id" | "composeName" | "config" | "documents">;

/** The directory every projection is written under: `data/projections` under the workspace root `root` (STORE-PROJ-002). */
export const projectionsDir = (root: string): string => join(root, "data", "projections");
/** One unit's projection directory, the one its container mounts at `/app/config`. */
export const projectionDir = (root: string, composeName: string): string => join(projectionsDir(root), composeName);

/** A Compose service name as the manifest spells one; anything else could name a path outside `data/projections/`. */
const UNIT_NAME = /^[a-z0-9-]+$/;

const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** The units that get a projection: every unit that declares a section or a document, then the `models` container. */
export function projectedUnits(units: readonly UnitSettings[] = UNIT_SETTINGS): ProjectionUnit[] {
  return [...units.filter((u) => u.config.length > 0 || u.documents.length > 0), MODELS_PROJECTION];
}

/**
 * The projection of `unit` from the store (STORE-PROJ-001): each declared section as stored (sparse; `null` for a declared
 * section the store does not hold, so its schema default applies), each declared document the store holds, and the revision.
 * Call inside `store.snapshot` so every unit sees one revision.
 */
// @spec STORE-PROJ-001
export function projectionOf(store: Store, unit: ProjectionUnit): Projection {
  const stored = store.sections();
  const sections: Record<string, unknown> = {};
  for (const path of unit.config) sections[path] = stored[path] ?? null;
  const documents: Projection["documents"] = {};
  for (const name of unit.documents) {
    const value = name === "personality" ? store.personality() : store.expressionsRaw();
    if (value !== undefined) documents[name] = value;
  }
  return { format: PROJECTION_FORMAT, unit: unit.id, revision: store.revision(), sections, documents };
}

/**
 * Writes the projections of `only` (default every projected unit, STORE-PROJ-003) under the workspace root `root`, from one
 * read transaction: `data/projections/<composeName>/settings.json`, the directory created with mode 0700, the file written
 * with mode 0600 through a temporary file in the same directory and a rename (STORE-PROJ-002). When `only` is not given,
 * each directory under `data/projections/` that names none of them is removed. A Compose name outside lower-case letters,
 * digits and hyphens, or a directory that is a symbolic link, fails before anything is written, naming it.
 */
// @spec STORE-PROJ-002, STORE-PROJ-003, STORE-PROJ-005, DEPLOY-SECRET-010
export function writeProjections(store: Store, root: string, only?: readonly ProjectionUnit[]): void {
  const units = only ?? projectedUnits();
  const base = projectionsDir(root);
  for (const u of units) {
    if (!UNIT_NAME.test(u.composeName)) throw new Error(`cannot write the projection of ${JSON.stringify(u.composeName)}: not a unit name (lower-case letters, digits and hyphens)`);
  }
  for (const dir of [join(root, "data"), base, ...units.map((u) => projectionDir(root, u.composeName))]) {
    if (isLink(dir)) throw new Error(`cannot write the projections: ${dir} is a symbolic link`);
  }
  const all = store.snapshot(() => units.map((u) => [u, projectionOf(store, u)] as const));
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const [u, projection] of all) {
    const dir = projectionDir(root, u.composeName);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(dir, PROJECTION_FILE), `${JSON.stringify(projection)}\n`, { mode: 0o600 });
  }
  if (only === undefined) {
    const keep = new Set(units.map((u) => u.composeName));
    for (const name of readdirSync(base)) if (!keep.has(name)) rmSync(join(base, name), { recursive: true, force: true });
  }
}

/** The projections of every unit that declares the `personality` document (STORE-PROJ-006, STORE-OUT-002). */
export function personalityUnits(): ProjectionUnit[] {
  return projectedUnits().filter((u) => u.documents.includes("personality"));
}
