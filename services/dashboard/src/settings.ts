import type http from "node:http";
import { pass, type Gate } from "./access.js";
import { GROUPS, applySection, readSection, sectionJsonSchema, sectionPresentation, sectionSecrets, type RunningOverrides } from "@cohost/config";
import type { ServiceDef } from "@cohost/control";
import type { Store } from "@cohost/store";
import { modelIssue, type AppliedView, type Framing, type Loadable } from "./applied.js";
import type { ModelStore } from "./models.js";
import type { StackSnapshot } from "./stack.js";

export interface SettingsDeps {
  /** The settings store: the stored sections, the credentials set (never their values), the revision and the one write. */
  store: Pick<Store, "settingsTree" | "secretPaths" | "revision" | "write" | "writeWithRetry">;
  manifest: readonly ServiceDef[];
  /** The latest stack status. */
  stack: () => Pick<StackSnapshot, "docker" | "services">;
  /** The one lock: every `PUT /config/:section` but a dry run needs the token or a session cookie (DASH-CTRL-004). */
  gate: Gate;
  /** The request body as text, capped at 64 KiB (throws past the cap). */
  body: (req: http.IncomingMessage) => Promise<string>;
  /** The model store and the applied view a save of `renderer` checks and sets (DASH-MDL-037, DASH-AVR-024). */
  models?: { store: ModelStore; applied: AppliedView };
}

/** The `renderer` section as the store would hold it after an edit: its model and framing (DASH-AVR-024). */
function rendererFraming(tree: Record<string, unknown>): Framing {
  const keys = readSection(tree, "renderer").keys;
  const v = (k: string) => keys[k]?.value;
  const model = v("model");
  return { model: typeof model === "string" ? model : "", zoom: Number(v("zoom")), offset_y: Number(v("offset_y")), turn: Number(v("turn")) };
}

const json = (res: http.ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

/** The etag of every section read and write: the settings store's revision (settings-store STORE-DB-006), as text. */
const etagOf = (revision: number): string => String(revision);

/** The declared sections, in manifest order, then `dashboard` and `renderer` (host-run, read by no unit's start-up config). */
// @spec MOD-CFG-001
export const declaredSections = (manifest: readonly ServiceDef[]): string[] => [...new Set(manifest.flatMap((s) => s.config)), "dashboard", "renderer"];
const readers = (manifest: readonly ServiceDef[], section: string): string[] => manifest.filter((s) => s.config.includes(section)).map((s) => s.id);
/** The ids of the units that declare `section`, in manifest order. */
export const unitsReading = readers;

/**
 * The isolation overrides the running units that declare `section` were started with, from the latest stack status: override
 * name to unit ids, in manifest order. Nothing is reported while Docker is unavailable, for a container that is not running, or
 * for one whose overrides the probe could not read (control-plane CTRL-STACK-016, MOD-CFG-018).
 */
// @spec MOD-CFG-018
export function runningOverrides(d: Pick<SettingsDeps, "stack" | "manifest">, section: string): RunningOverrides {
  const stack = d.stack();
  if (!stack.docker.ok) return {};
  const byUnit = new Map(stack.services.filter((c) => c.status === "running" && c.overrides).map((c) => [c.service, c.overrides!] as const));
  const out: Record<string, string[]> = {};
  for (const id of readers(d.manifest, section)) {
    for (const name of Object.keys(byUnit.get(id) ?? {})) (out[name] ??= []).push(id);
  }
  return out;
}

type Body = { etag: string; values: Record<string, unknown>; remove: string[] };

/** The `{ etag, values, remove? }` body, `"notjson"` when the text is not JSON, undefined when it has another shape. */
function parseBody(raw: string): Body | "notjson" | undefined {
  let input: { etag?: unknown; values?: unknown; remove?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { return "notjson"; }
  const { etag, values, remove } = input ?? {};
  if (typeof etag !== "string" || typeof values !== "object" || values === null || Array.isArray(values)) return undefined;
  if (remove !== undefined && (!Array.isArray(remove) || remove.some((p) => typeof p !== "string"))) return undefined;
  return { etag, values: values as Record<string, unknown>, remove: (remove ?? []) as string[] };
}

/**
 * The settings editor's routes: `GET /config/schema`, `GET /config/:section`, `PUT /config/:section`. They read the settings
 * store's sections and write a section through the store's one write (settings-store STORE-SET-001), with the store's revision
 * as the etag compared inside the write's transaction (STORE-SET-003); they never touch `.env`, never write a credential and
 * never start, stop or restart a unit.
 */
// @spec MOD-CFG-001, MOD-CFG-003, MOD-CFG-007, MOD-CFG-008, MOD-CFG-009, MOD-CFG-010, MOD-CFG-012, MOD-CFG-014, MOD-CFG-015
// @spec MOD-CFG-016, MOD-CFG-017, MOD-CFG-018, MOD-CFG-019, MOD-CFG-020
export async function handleConfig(d: SettingsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/config/")) return false;
  let name: string;
  try { name = decodeURIComponent(url.pathname.slice("/config/".length)); } catch { json(res, 404, { ok: false, detail: "unknown section" }); return true; }
  const sections = declaredSections(d.manifest);

  if (req.method === "GET" && name === "schema") {
    json(res, 200, {
      groups: GROUPS,
      sections: sections.map((path) => ({ path, ...sectionPresentation(path), services: readers(d.manifest, path), schema: sectionJsonSchema(path), secrets: sectionSecrets(path) })),
    });
    return true;
  }
  if (req.method !== "GET" && req.method !== "PUT") return false;
  if (!sections.includes(name)) { json(res, 404, { ok: false, detail: "unknown section" }); return true; }

  if (req.method === "GET") {
    const revision = d.store.revision();
    json(res, 200, { section: name, etag: etagOf(revision), ...readSection(d.store.settingsTree(), name, d.store.secretPaths(), runningOverrides(d, name)) });
    return true;
  }

  // Every save passes the one gate, a change to a sensitive key included; a dry run (Check) writes nothing and is not gated.
  // @spec DASH-CTRL-004, MOD-CFG-007
  const dryRun = url.searchParams.get("dryRun") === "1";
  if (!dryRun && !(await pass(d.gate, req, res))) return true;
  const raw = await d.body(req); // over the cap this throws and nothing has been read or written
  const input = parseBody(raw);
  if (input === "notjson") { json(res, 400, { ok: false, issues: [{ path: "", message: "the body is not JSON" }] }); return true; }
  if (!input) {
    json(res, 400, { ok: false, issues: [{ path: "", message: "the body must be { etag: string, values: object, remove?: string[] }" }] });
    return true;
  }
  const { etag, values, remove } = input;
  const expected = /^\d+$/.test(etag) ? Number(etag) : -1;

  // A save of `renderer` holds the applied view's lock and reads the loadable models first, so the check sees the same store.
  const save = async (models: readonly Loadable[]): Promise<void> => {
    const tree = d.store.settingsTree();
    const revision = d.store.revision();
    if (expected !== revision) { json(res, 409, { ok: false, etag: etagOf(revision) }); return; }
    const edit = applySection(tree, name, values, remove, d.store.secretPaths(), runningOverrides(d, name));
    if (!edit.ok) { json(res, 400, { ok: false, issues: edit.issues }); return; }
    const warnings = edit.warnings;
    // @spec DASH-MDL-037, DASH-AVR-024, DASH-AVR-029
    const framing = name === "renderer" && d.models ? rendererFraming({ ...tree, renderer: edit.doc ?? undefined }) : undefined;
    const issue = framing && modelIssue(models, framing.model);
    if (issue) { json(res, 400, { ok: false, issues: [{ path: "renderer.model", message: issue }] }); return; }
    const change = { sections: { [name]: edit.doc } };
    let written;
    try {
      written = dryRun ? d.store.write(change, { expectedRevision: expected, dryRun: true }) : await d.store.writeWithRetry(change, { expectedRevision: expected });
    } catch (e) {
      json(res, 500, { ok: false, detail: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!written.ok) {
      if (written.conflict) json(res, 409, { ok: false, etag: etagOf(written.revision) });
      else json(res, 400, { ok: false, issues: written.issues });
      return;
    }
    if (dryRun) { json(res, 200, { ok: true, dryRun: true, warnings }); return; }
    if (framing && d.models) d.models.applied.apply(framing, models);

    const stack = d.stack();
    const running = new Set(stack.docker.ok ? stack.services.filter((s) => s.status === "running").map((s) => s.service) : []);
    json(res, 200, { ok: true, etag: etagOf(written.revision), restart: readers(d.manifest, name).filter((id) => running.has(id)), warnings });
  };
  if (name === "renderer" && d.models) {
    const { applied, store } = d.models;
    await applied.lock.run(async () => save(await store.loadable()));
  } else await save([]);
  return true;
}
