import { randomBytes, scryptSync } from "node:crypto";
import { parseYaml, secretPathOf, stringifyYaml } from "@cohost/config";
import { StoreError, type StoreIssue } from "./errors.js";
import { open as openSealed, seal } from "./keys.js";
import { moveDamagedAside, openStore, splitSettings, type Store, type StoreChange, type StoreOptions, type WriteResult } from "./store.js";

/** The scrypt parameters of an export's passphrase key (STORE-IO-002): N 2^17 needs `maxmem` above Node's 32 MiB default. */
export const EXPORT_SCRYPT = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
/** The shortest passphrase an export of credentials takes. */
export const MIN_PASSPHRASE_LENGTH = 12;

type Doc = Record<string, unknown>;
const isObj = (x: unknown): x is Doc => !!x && typeof x === "object" && !Array.isArray(x);

/** The `secrets` block of an export: the key derivation and each credential sealed under it. */
export interface ExportSecrets { kdf: { alg: "scrypt"; N: number; r: number; p: number; maxmem: number; salt: string }; values: Record<string, string> }

const deriveKey = (passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Buffer =>
  scryptSync(passphrase, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: EXPORT_SCRYPT.maxmem });

/**
 * The export format (STORE-IO-001, -002): one YAML document with `cohost_export: 1`, the stored settings nested as the schema
 * nests them, the personality and the emotion map; with a passphrase also `secrets`, each value sealed with AES-256-GCM under a
 * scrypt key with the path as associated data, written `enc1:<nonce>.<ciphertext and tag>`. Without one, a comment lists the
 * secret paths that are set and no value. The token verifier and the generated keys are never exported.
 */
// @spec STORE-IO-001, STORE-IO-002
export function exportStore(store: Store, opts: { passphrase?: string } = {}): string {
  const doc: Doc = { cohost_export: 1, settings: store.settingsTree() };
  const personality = store.personality();
  if (personality !== undefined) doc.personality = personality;
  const expressions = store.expressionsRaw();
  if (expressions !== undefined) doc.expressions = expressions;
  if (opts.passphrase !== undefined) {
    if (opts.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new StoreError("usage", `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`);
    const salt = randomBytes(16);
    const key = deriveKey(opts.passphrase, salt, EXPORT_SCRYPT);
    const values: Record<string, string> = {};
    for (const [path, value] of Object.entries(store.secretValues())) {
      const s = seal(key, Buffer.from(path, "utf8"), Buffer.from(value, "utf8"));
      values[path] = `enc1:${s.nonce.toString("base64url")}.${Buffer.concat([s.ciphertext, s.tag]).toString("base64url")}`;
    }
    const secrets: ExportSecrets = { kdf: { alg: "scrypt", ...EXPORT_SCRYPT, salt: salt.toString("base64url") }, values };
    doc.secrets = secrets;
  }
  const text = stringifyYaml(doc, { lineWidth: 0 });
  if (opts.passphrase !== undefined) return text;
  const set = store.secretPaths();
  return `# Credentials set in the store, not exported (export them with --secrets): ${set.length > 0 ? set.join(", ") : "none"}\n${text}`;
}

/** What an import replaces: each part present is replaced whole; an absent part is left as it is. */
export interface ImportPlan {
  /** Every section, replacing the stored ones. */
  sections?: Record<string, unknown>;
  personality?: string | null;
  expressions?: unknown;
  /** Credentials in plaintext, replacing every stored one. */
  secrets?: Record<string, string>;
  /** Credentials still sealed under a passphrase (an export's `secrets`), opened by `openSecrets`. */
  sealed?: ExportSecrets;
  /** Notes that are not problems: values dropped from the settings, paths in a secrets part that are not credentials. */
  notes: string[];
}

/** The parse of a YAML text, or an issue naming where it fails (never quoting the source line, which may hold a credential). */
function yamlOf(text: string, what: string): { value: unknown } | { issue: StoreIssue } {
  try {
    return { value: parseYaml(text) };
  } catch (e) {
    const err = e as { linePos?: { line: number; col: number }[] };
    const pos = err.linePos?.[0];
    return { issue: { path: what, message: `not valid YAML${pos ? ` at line ${pos.line}, column ${pos.col}` : ""}` } };
  }
}

function settingsPart(tree: unknown, plan: ImportPlan, issues: StoreIssue[]): void {
  const split = splitSettings(tree);
  issues.push(...split.issues);
  plan.sections = split.sections;
  for (const p of split.credentials) plan.notes.push(`${p}: a credential in the settings, not imported as a setting (import it with --secrets)`);
}

/** Reads an export (STORE-IO-003): the whole store, so a part it does not hold is removed by the import. */
// @spec STORE-IO-003
export function readExport(text: string): { plan: ImportPlan; issues: StoreIssue[] } {
  const plan: ImportPlan = { notes: [] };
  const issues: StoreIssue[] = [];
  const y = yamlOf(text, "(file)");
  if ("issue" in y) return { plan, issues: [y.issue] };
  const doc = y.value;
  if (!isObj(doc) || doc.cohost_export !== 1) return { plan, issues: [{ path: "cohost_export", message: "not a cohost export (cohost_export: 1)" }] };
  for (const k of Object.keys(doc)) {
    if (!["cohost_export", "settings", "personality", "expressions", "secrets"].includes(k)) issues.push({ path: k, message: "not part of the export format" });
  }
  settingsPart(doc.settings ?? {}, plan, issues);
  if (doc.personality !== undefined && doc.personality !== null && typeof doc.personality !== "string") issues.push({ path: "personality", message: "must be text" });
  plan.personality = typeof doc.personality === "string" ? doc.personality : null;
  plan.expressions = doc.expressions ?? null;
  if (doc.secrets !== undefined && doc.secrets !== null) {
    const s = doc.secrets as Partial<ExportSecrets>;
    const kdf = s.kdf;
    if (!isObj(s) || !isObj(kdf) || kdf.alg !== "scrypt" || typeof kdf.salt !== "string" || !isObj(s.values)) {
      issues.push({ path: "secrets", message: "must hold kdf (scrypt with a salt) and values" });
    } else {
      plan.sealed = s as ExportSecrets;
    }
  }
  return { plan, issues };
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * Why an export's key derivation parameters cannot be used, or undefined: integers, `N` a power of two from 2^10 to 2^20, `r`
 * 1 to 16, `p` 1 to 4, scrypt's memory (128·r·(N + 2) + 128·r·p bytes) within the 256 MiB an export may take, and a salt of at least 16 bytes.
 */
function kdfProblem(kdf: ExportSecrets["kdf"]): string | undefined {
  const { N, r, p, salt } = kdf as Partial<Record<"N" | "r" | "p", unknown>> & { salt?: unknown };
  if (!isInt(N) || !isInt(r) || !isInt(p)) return "N, r and p must be integers";
  if (N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return "N must be a power of two from 1024 to 1048576";
  if (r < 1 || r > 16 || p < 1 || p > 4) return "r must be 1 to 16 and p 1 to 4";
  // OpenSSL's scrypt memory: 128·r·(N + 2) for V and the work buffer, plus 128·r·p for B.
  if (128 * r * (N + 2) + 128 * r * p > EXPORT_SCRYPT.maxmem) return `N, r and p ask for more than ${EXPORT_SCRYPT.maxmem} bytes of memory`;
  if (typeof salt !== "string" || !/^[A-Za-z0-9_-]+$/.test(salt) || Buffer.from(salt, "base64url").length < 16) return "the salt must be at least 16 bytes in base64url";
  return undefined;
}

/** Opens an export's sealed credentials with the passphrase; a value that does not open is an issue naming its path. */
export function openSecrets(sealed: ExportSecrets, passphrase: string): { values: Record<string, string>; issues: StoreIssue[] } {
  const problem = kdfProblem(sealed.kdf);
  if (problem) return { values: {}, issues: [{ path: "secrets.kdf", message: problem }] };
  const kdf = sealed.kdf;
  let key: Buffer;
  try {
    key = deriveKey(passphrase, Buffer.from(kdf.salt, "base64url"), kdf);
  } catch (e) {
    return { values: {}, issues: [{ path: "secrets.kdf", message: `the key cannot be derived: ${(e as Error).message}` }] };
  }
  const values: Record<string, string> = {};
  const issues: StoreIssue[] = [];
  for (const [path, text] of Object.entries(sealed.values)) {
    const m = typeof text === "string" ? /^enc1:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(text) : null;
    if (!m) { issues.push({ path, message: "is not an enc1: value" }); continue; }
    const body = Buffer.from(m[2]!, "base64url");
    const plain = body.length < 16 ? undefined : openSealed(key, Buffer.from(path, "utf8"), { nonce: Buffer.from(m[1]!, "base64url"), ciphertext: body.subarray(0, body.length - 16), tag: body.subarray(body.length - 16) });
    if (!plain) { issues.push({ path, message: "does not decrypt: a wrong passphrase, or the value was changed" }); continue; }
    values[path] = plain.toString("utf8");
  }
  return { values, issues };
}

/** Flattens a secrets part, a plain mapping nested by path, to dotted paths; empty values are unset and skipped. */
function flattenSecrets(node: unknown, plan: ImportPlan, issues: StoreIssue[], prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(node)) { if (node !== null && node !== undefined) issues.push({ path: prefix || "(secrets)", message: "must be a mapping" }); return out; }
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) { Object.assign(out, flattenSecrets(v, plan, issues, path)); continue; }
    if (v === null || v === undefined || v === "") continue;
    if (secretPathOf(path) === undefined) { plan.notes.push(`${path}: not a credential path, not imported`); continue; }
    if (typeof v !== "string") { issues.push({ path, message: "must be text" }); continue; }
    out[path] = v;
  }
  return out;
}

/** The texts of an import given as parts (STORE-IO-004): any of the settings, the personality, the expressions and the secrets. */
export interface ImportParts { settings?: string; personality?: string; expressions?: string; secrets?: string }

/**
 * Reads parts (STORE-IO-004): the settings as a mapping shaped like an export's `settings`, the personality as text, the
 * expressions as YAML and the secrets as a plain mapping nested by secret path. Only the parts given are replaced.
 */
// @spec STORE-IO-004
export function readParts(parts: ImportParts): { plan: ImportPlan; issues: StoreIssue[] } {
  const plan: ImportPlan = { notes: [] };
  const issues: StoreIssue[] = [];
  if (parts.settings !== undefined) {
    const y = yamlOf(parts.settings, "settings");
    if ("issue" in y) issues.push(y.issue);
    else settingsPart(y.value ?? {}, plan, issues);
  }
  if (parts.personality !== undefined) plan.personality = parts.personality;
  if (parts.expressions !== undefined) {
    const y = yamlOf(parts.expressions, "expressions");
    if ("issue" in y) issues.push(y.issue);
    else plan.expressions = y.value ?? {};
  }
  if (parts.secrets !== undefined) {
    const y = yamlOf(parts.secrets, "secrets");
    if ("issue" in y) issues.push(y.issue);
    else plan.secrets = flattenSecrets(y.value, plan, issues);
  }
  return { plan, issues };
}

/** What an import would change: sections and documents added, changed or removed, and the credential paths set or removed. */
export interface ImportSummary {
  added: string[];
  changed: string[];
  removed: string[];
  secretsSet: string[];
  secretsRemoved: string[];
}

/** The change a plan makes to `store`, and a summary of it, paths only. */
export function planChange(store: Store, plan: ImportPlan): { change: StoreChange; summary: ImportSummary } {
  const summary: ImportSummary = { added: [], changed: [], removed: [], secretsSet: [], secretsRemoved: [] };
  const change: StoreChange = {};
  const diff = (name: string, before: unknown, after: unknown): void => {
    if (before === undefined && after !== undefined) summary.added.push(name);
    else if (before !== undefined && after === undefined) summary.removed.push(name);
    else if (before !== undefined && JSON.stringify(before) !== JSON.stringify(after)) summary.changed.push(name);
  };
  if (plan.sections !== undefined) {
    const current = store.sections();
    change.sections = plan.sections;
    change.replaceSections = true;
    for (const p of new Set([...Object.keys(current), ...Object.keys(plan.sections)])) diff(p, current[p], plan.sections[p]);
  }
  if (plan.personality !== undefined) {
    change.personality = plan.personality;
    diff("personality", store.personality(), plan.personality ?? undefined);
  }
  if (plan.expressions !== undefined) {
    change.expressions = plan.expressions;
    diff("expressions", store.expressionsRaw(), plan.expressions ?? undefined);
  }
  if (plan.secrets !== undefined) {
    change.secrets = plan.secrets;
    change.replaceSecrets = true;
    summary.secretsSet = Object.keys(plan.secrets).toSorted();
    const keep = new Set(summary.secretsSet);
    summary.secretsRemoved = store.secretPaths().filter((p) => !keep.has(p));
  }
  return { change, summary };
}

/**
 * Imports a plan (STORE-IO-003): validated as a write is; with `dryRun` nothing is written; otherwise a backup is taken and the
 * plan applied in one write, so the revision becomes the previous one plus one (STORE-DB-011). A plan whose credentials are
 * still sealed must have been opened first.
 */
// @spec STORE-IO-003, STORE-DB-011
export async function importPlan(store: Store, plan: ImportPlan, opts: { dryRun?: boolean } = {}): Promise<{ result: WriteResult; summary: ImportSummary }> {
  if (plan.sealed !== undefined && plan.secrets === undefined) throw new StoreError("usage", "the export's credentials are sealed: open them with the passphrase first");
  const { change, summary } = planChange(store, plan);
  if (opts.dryRun) return { result: store.write(change, { dryRun: true }), summary };
  const check = store.write(change, { dryRun: true });
  if (!check.ok) return { result: check, summary };
  await store.backup();
  return { result: store.write(change), summary };
}

/**
 * Imports a plan into the store at `opts` (STORE-IO-003, STORE-TASK-006), as `config:import` and the dashboard's recovery import
 * do: a damaged store is never written, but moved aside (`moved` names where) for a new, unseeded store that takes the import;
 * a dry run never moves anything.
 */
// @spec STORE-IO-003, STORE-TASK-006
export async function importToStore(plan: ImportPlan, opts: StoreOptions = {}, o: { dryRun?: boolean } = {}): Promise<{ result: WriteResult; summary: ImportSummary; moved?: string; damaged?: string }> {
  let store: Store;
  let moved: string | undefined;
  let damaged: string | undefined;
  try {
    store = await openStore(opts);
  } catch (e) {
    if (!(e instanceof StoreError) || e.kind !== "damaged" || o.dryRun) throw e;
    damaged = e.message;
    moved = moveDamagedAside(opts.dataDir);
    store = await openStore({ ...opts, seed: false });
  }
  try {
    return { ...(await importPlan(store, plan, { dryRun: o.dryRun ?? false })), ...(moved ? { moved, damaged } : {}) };
  } finally {
    store.close();
  }
}
