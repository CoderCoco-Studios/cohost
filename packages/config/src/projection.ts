/**
 * The projection loader: a unit's settings read from its projection, `settings.json` in the config directory (settings-store
 * STORE-PROJ-002), with the credentials its process received in memory (STORE-DLV-004) set at their secret paths.
 *
 * A projection holds only the sections and documents the unit's manifest entry declares, so the configuration this loader
 * returns throws, naming the section and the unit, when the unit reads a section the projection does not hold. A unit that
 * forgot a declaration fails loudly at the first read instead of running on defaults.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema, ExpressionMapSchema, secretPathOf, type Config, type ExpressionMap } from "./schema.js";
import { SECTION_PATHS } from "./presentation.js";
import { applyIsolation, coerceEmptyNumbers, decodeIsolation, unknownKeys, ISOLATION_ENV, ISOLATION_OVERRIDES, type ConfigIssue, type IsolationName, type IsolationOverrides } from "./pipeline.js";
import { configDir } from "./paths.js";
import { diag } from "./diag.js";
import { ConfigError, bracketIndexes, invalidMessage } from "./errors.js";

/** The projection's file name in the config directory. */
export const PROJECTION_FILE = "settings.json";
/** The projection format this build reads. */
export const PROJECTION_FORMAT = 1;
/** The derived ears listener key: not a secret path, delivered to the `ears` unit alone (config CFG-SEC-020). */
export const EARS_VERIFIER_PATH = "ears.http.verifier";

/** A unit's projection as written by the settings store: `{format: 1, unit, revision, sections, documents}`. */
export interface Projection {
  format: 1;
  unit: string;
  revision: number;
  /** Each held section by its dotted path, as stored (sparse). */
  sections: Record<string, unknown>;
  /** The stored documents the unit declares. */
  documents: { personality?: unknown; expressions?: unknown };
}

export interface LoadOptions {
  /** The directory holding `settings.json` (default `configDir()`). */
  dir?: string;
  /** The calling unit: a projection written for another unit is refused (default: not checked). */
  unit?: string;
  /** The credentials the process received, by concrete secret path (default none). */
  credentials?: Readonly<Record<string, string>>;
  /** The `COHOST_ISOLATION` value to apply (default the process's own). */
  isolation?: string;
  /** Read the file again instead of returning the cached configuration. */
  force?: boolean;
}

/** What a cached configuration was loaded from: a call naming another directory, unit, isolation or credentials reloads. */
interface CacheKey { dir: string; unit: string | undefined; isolation: string; credentials: string }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

const notWritten = (file: string, why: string): ConfigError => {
  const message = `${file} ${why}: it is the unit's settings projection, written by the dashboard, cohostctl or the unit runner when they start the unit`;
  return new ConfigError(message, [{ file, path: "", message, kind: "syntax" }]);
};

/**
 * Reads and checks the projection in `dir`: a missing file, one that is not JSON, or one that is not an object with `format` 1,
 * a `unit`, a `revision` and a `sections` object fails with an error naming the file and who writes it.
 */
// @spec CFG-LOAD-007
export function readProjection(dir: string = configDir()): { file: string; projection: Projection } {
  const file = join(dir, PROJECTION_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw notWritten(file, "does not exist");
    throw e;
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw notWritten(file, "is not JSON"); }
  if (!isObj(raw) || raw.format !== PROJECTION_FORMAT) throw notWritten(file, `is not a projection of format ${PROJECTION_FORMAT}`);
  if (typeof raw.unit !== "string" || raw.unit === "" || !Number.isInteger(raw.revision) || !isObj(raw.sections) || (raw.documents !== undefined && !isObj(raw.documents))) {
    throw notWritten(file, "is not a whole projection (unit, revision, sections and documents)");
  }
  return { file, projection: { format: 1, unit: raw.unit, revision: raw.revision as number, sections: raw.sections, documents: (raw.documents ?? {}) as Projection["documents"] } };
}

/** The declared section (CFG-PRES) a dotted path lies in: the longest section path that is the path or a prefix of it. */
const sectionOf = (path: string): string | undefined =>
  SECTION_PATHS.filter((s) => path === s || path.startsWith(`${s}.`)).toSorted((a, b) => b.length - a.length)[0];

const BRAIN = "brain.";
const brainShape = ConfigSchema.shape.brain.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; message: string }[] } } }>;

/**
 * A refinement of the `brain` object that reads two sections, by the issue path it reports at: it is checked only where the
 * unit holds both (config CFG-LOAD-001); a refinement inside one section is checked with that section.
 */
const CROSS_SECTION: Readonly<Record<string, readonly string[]>> = {
  working_memory_own_lines: ["brain.working_memory_events", "brain.working_memory_own_lines"],
};

function setIn(root: Record<string, unknown>, segs: readonly string[], value: unknown): void {
  let cur = root;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(cur[seg])) cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]!] = value;
}
const getIn = (root: unknown, segs: readonly string[]): unknown => segs.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);

/** Wraps `target` so that reading a known section name it does not hold throws, naming the section and the unit. */
function guard<T extends object>(target: T, known: ReadonlySet<string>, held: ReadonlySet<string>, prefix: string, unit: string): T {
  return new Proxy(target, {
    get(t, p, r) {
      if (typeof p === "string" && known.has(p) && !held.has(p)) {
        throw new Error(`${unit} read the settings section ${prefix}${p}, which its projection does not hold: declare it in the unit's config list (UNIT_SETTINGS in @cohost/config)`);
      }
      return Reflect.get(t, p, r) as unknown;
    },
  });
}

let cached: { cfg: Config; key: CacheKey } | undefined;

/** Whether a call with `opts` may return the cached configuration: it names nothing the cache was not loaded from. */
function cacheFits(opts: LoadOptions, key: CacheKey): boolean {
  if (opts.dir !== undefined && opts.dir !== key.dir) return false;
  if (opts.unit !== undefined && opts.unit !== key.unit) return false;
  if (opts.isolation !== undefined && opts.isolation !== key.isolation) return false;
  if (opts.credentials !== undefined && JSON.stringify(opts.credentials) !== key.credentials) return false;
  return true;
}

/** Forget the cached configuration (tests that load several projections in one process). */
export function resetConfigCache(): void { cached = undefined; }

/**
 * The unit's configuration from its projection: each held section with nulls dropped, the isolation overrides that fall in a
 * held section applied, validated with that section's own schema (a refinement across sections only where every section it
 * reads is held, the store having validated the whole configuration on write), then the delivered credentials set at their
 * secret paths. Reading a section the projection does not hold throws. Cached: a later call returns the same object unless it
 * passes `force`, or names a directory, unit, isolation value or credentials other than the cached load's.
 */
// @spec CFG-LOAD-001, CFG-LOAD-003, CFG-LOAD-005, CFG-LOAD-008, CFG-SEC-002, CFG-SEC-003, CFG-SEC-016, CFG-SEC-017, CFG-SEC-020, CFG-SEC-021, CFG-ISO-007
export function loadConfig(opts: LoadOptions = {}): Config {
  if (cached && !opts.force && cacheFits(opts, cached.key)) return cached.cfg;
  const dir = opts.dir ?? configDir();
  const isolation = opts.isolation ?? process.env[ISOLATION_ENV] ?? "";
  const { file, projection } = readProjection(dir);
  const { unit } = projection;
  if (opts.unit !== undefined && unit !== opts.unit) {
    throw notWritten(file, `is the projection of ${unit}, not of ${opts.unit}`);
  }

  const held = new Set<string>();
  const stray: string[] = [];
  const tree: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(projection.sections)) {
    if (!SECTION_PATHS.includes(path)) { stray.push(path); continue; }
    held.add(path);
    if (value !== null) setIn(tree, path.split("."), coerceEmptyNumbers(value));
  }

  const overrides = decodeIsolation(isolation);
  const applicable: IsolationOverrides = Object.fromEntries(Object.entries(overrides).filter(([name]) => {
    const section = sectionOf(ISOLATION_OVERRIDES[name as IsolationName]);
    return section !== undefined && held.has(section);
  }));
  const raw = structuredClone(tree);
  applyIsolation(tree, applicable);

  const issues: ConfigIssue[] = [];
  const out: Record<string, unknown> = {};
  const topLevel = [...held].filter((s) => !s.startsWith(BRAIN));
  const shape = ConfigSchema.shape as unknown as Record<string, typeof brainShape[string]>;
  for (const name of topLevel) {
    const r = shape[name]!.safeParse(tree[name]);
    if (r.success) out[name] = r.data;
    else issues.push(...r.error!.issues.map((i) => ({ path: [name, ...i.path.map(String)].join("."), message: i.message })));
  }
  const heldBrain = [...held].filter((s) => s.startsWith(BRAIN)).map((s) => s.slice(BRAIN.length));
  const brain: Record<string, unknown> = {};
  if (heldBrain.length > 0) {
    const r = ConfigSchema.shape.brain.safeParse(tree.brain ?? {});
    if (r.success) {
      for (const sub of heldBrain) brain[sub] = (r.data as Record<string, unknown>)[sub];
    } else {
      const kept = r.error.issues.filter((i) => {
        const sub = String(i.path[0]);
        const reads = i.path.length === 1 ? CROSS_SECTION[sub] : undefined;
        return heldBrain.includes(sub) && (reads === undefined || reads.every((s) => held.has(s)));
      });
      issues.push(...kept.map((i) => ({ path: ["brain", ...i.path.map(String)].join("."), message: i.message })));
      // Only refinements across unheld sections failed: take each held section from its own parse.
      if (kept.length === 0) for (const sub of heldBrain) brain[sub] = brainShape[sub]!.safeParse(getIn(tree, ["brain", sub])).data;
    }
  }
  if (issues.length > 0) {
    const applied = Object.keys(applicable);
    throw new ConfigError(
      invalidMessage(file, issues) + (applied.length ? `\n\n(${ISOLATION_ENV} overrides applied: ${applied.join(", ")})` : ""),
      issues.map((i) => ({ file, path: bracketIndexes(i.path), message: i.message, kind: "schema" })),
    );
  }
  out.brain = brain;

  const unknown = [...stray, ...topLevel.flatMap((s) => unknownKeys(raw[s], out[s], s)), ...heldBrain.flatMap((s) => unknownKeys(getIn(raw, ["brain", s]), brain[s], `brain.${s}`))];
  if (unknown.length > 0) diag().warn(`[config] ${file}: ignoring unknown keys: ${unknown.join(", ")}`);

  // The delivered credentials, set after validation so a credential creates no section or entry the settings do not hold.
  for (const [path, value] of Object.entries(opts.credentials ?? {})) {
    if (path === EARS_VERIFIER_PATH) {
      if (!held.has("ears")) diag().warn(`[config] ignoring ${path}: it is delivered to ears alone, and the projection of ${unit} holds no ears section`);
      else if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) setIn(out, path.split("."), value);
      else diag().warn(`[config] ignoring ${path}: it is not 64 lowercase hex digits, so the ears audio listener has no key`);
      continue;
    }
    if (typeof value !== "string" || value === "") continue;
    const pattern = secretPathOf(path);
    const section = sectionOf(path);
    const segs = path.split(".");
    if (pattern === undefined || section === undefined || !held.has(section)) {
      diag().warn(`[config] ignoring the delivered credential ${path}: it is not a credential of a section ${unit} holds`);
      continue;
    }
    if (pattern.includes("*") && !isObj(getIn(out, segs.slice(0, -1)))) {
      diag().warn(`[config] ignoring the delivered credential ${path}: ${segs.slice(0, -1).join(".")} is not in the settings`);
      continue;
    }
    setIn(out, segs, value);
  }

  const knownTop = new Set(SECTION_PATHS.filter((s) => !s.includes(".")));
  const knownBrain = new Set(Object.keys(brainShape));
  out.brain = guard(brain, knownBrain, new Set(heldBrain), BRAIN, unit);
  const cfg = guard(out, knownTop, new Set(topLevel), "", unit) as Config;
  cached = { cfg, key: { dir, unit: opts.unit, isolation, credentials: JSON.stringify(opts.credentials ?? {}) } };
  return cfg;
}

/**
 * The ears listener key the loader set from ears' delivery (`ears.http.verifier`, CFG-SEC-020), or undefined when the delivery
 * carried none in its valid form. It is not a key of `ConfigSchema`: only ears' credentials message carries it.
 */
// @spec CFG-SEC-020
export function earsListenerVerifier(cfg: Config): string | undefined {
  const v = (cfg.ears.http as { verifier?: unknown }).verifier;
  return typeof v === "string" ? v : undefined;
}

/**
 * The `personality` document of the projection in `dir`, read on every call; throws naming the unit when the projection holds
 * none.
 */
// @spec CFG-USR-001
export function loadPersonality(dir?: string): string {
  const { file, projection } = readProjection(dir);
  const text = projection.documents.personality;
  if (typeof text !== "string") throw new Error(`${file}: the projection of ${projection.unit} holds no personality document; declare it in the unit's documents list`);
  return text;
}

/**
 * The `expressions` document of the projection in `dir`, read and validated on every call; an absent document is an empty map,
 * and one that fails validation throws `Invalid <file>:` with every failing key.
 */
// @spec CFG-USR-002
export function loadExpressions(dir?: string): ExpressionMap {
  const { file, projection } = readProjection(dir);
  const parsed = ExpressionMapSchema.safeParse(projection.documents.expressions ?? {});
  if (!parsed.success) throw new Error(invalidMessage(file, parsed.error.issues.map((i) => ({ path: ["expressions", ...i.path.map(String)].join("."), message: i.message }))));
  return parsed.data;
}
