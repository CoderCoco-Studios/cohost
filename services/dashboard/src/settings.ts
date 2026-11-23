import type http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GROUPS, applySection, etagOf, readSection, sectionJsonSchema, sectionPresentation, sectionSecrets, setSecretPaths, writeFileAtomic, type RunningOverrides } from "@cohost/config";
import { bearerOk, type ServiceDef } from "@cohost/control";
import { changedSensitiveKeys, noTokenDetail } from "./sensitive.js";
import type { StackSnapshot } from "./stack.js";

export interface SettingsDeps {
  /** The path of config.yaml, seeded from the example when missing. */
  file: () => string;
  /** Replaces `file` with `text` atomically. */
  write: (file: string, text: string) => void;
  manifest: readonly ServiceDef[];
  /** The latest stack status. */
  stack: () => Pick<StackSnapshot, "docker" | "services">;
  /** True when `CONTROL_ENABLED=1`: every `PUT /config/:section` then needs the control token (DASH-CTRL-004). */
  controlMode?: boolean;
  /** The control token whenever one is configured (`CONTROL_TOKEN`, in either control mode); undefined when none is. */
  controlToken?: string;
  /** The request body as text, capped at 64 KiB (throws past the cap). */
  body: (req: http.IncomingMessage) => Promise<string>;
}

export const defaultWrite = writeFileAtomic;

const json = (res: http.ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

/** The secret paths `secrets.yaml` (beside `config.yaml`) holds a value for. */
const secretsSet = (d: SettingsDeps): string[] => setSecretPaths(join(dirname(d.file()), "secrets.yaml"));

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
export function runningOverrides(d: SettingsDeps, section: string): RunningOverrides {
  const stack = d.stack();
  if (!stack.docker.ok) return {};
  const byUnit = new Map(stack.services.filter((c) => c.status === "running" && c.overrides).map((c) => [c.service, c.overrides!] as const));
  const out: Record<string, string[]> = {};
  for (const id of readers(d.manifest, section)) {
    for (const name of Object.keys(byUnit.get(id) ?? {})) (out[name] ??= []).push(id);
  }
  return out;
}

type Body = { etag: string; values: Record<string, unknown> };

/** The `{ etag, values }` body, `"notjson"` when the text is not JSON, undefined when it has another shape. */
function parseBody(raw: string): Body | "notjson" | undefined {
  let input: { etag?: unknown; values?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { return "notjson"; }
  const { etag, values } = input ?? {};
  if (typeof etag !== "string" || typeof values !== "object" || values === null || Array.isArray(values)) return undefined;
  return { etag, values: values as Record<string, unknown> };
}

/** The sensitive keys a gated request's body would change; never throws, so the refusal it informs is always answered. */
async function sensitiveInBody(d: SettingsDeps, req: http.IncomingMessage, section: string): Promise<string[]> {
  try {
    const body = parseBody(await d.body(req));
    return body && body !== "notjson" ? changedSensitiveKeys(readFileSync(d.file(), "utf8"), section, body.values) : [];
  } catch { return []; }
}

/** 401 for a missing or wrong token, 403 when no control token is configured at all; the paths, never the values. */
function refuseSensitive(res: http.ServerResponse, token: string | undefined, sensitive: string[]): void {
  const keys = sensitive.join(", ");
  if (token === undefined) {
    json(res, 403, { ok: false, detail: noTokenDetail(keys), sensitive });
    return;
  }
  res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" });
  res.end(JSON.stringify({ ok: false, detail: `changing ${keys} needs the control token (Authorization: Bearer)`, sensitive }));
}

/**
 * The settings editor's routes: `GET /config/schema`, `GET /config/:section`, `PUT /config/:section`. They read and write
 * `config.yaml` through `@cohost/config`'s editor, never touch `.env`, and never start, stop or restart a unit.
 */
// @spec MOD-CFG-001, MOD-CFG-003, MOD-CFG-007, MOD-CFG-015, MOD-CFG-016, MOD-CFG-018, MOD-CFG-019, MOD-CFG-020
export async function handleConfig(d: SettingsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/config/")) return false;
  const name = decodeURIComponent(url.pathname.slice("/config/".length));
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
    const text = readFileSync(d.file(), "utf8");
    json(res, 200, { section: name, etag: etagOf(text), ...readSection(text, name, secretsSet(d), runningOverrides(d, name)) });
    return true;
  }

  // @spec DASH-CTRL-004, DASH-CTRL-009, DASH-CTRL-010
  const dryRun = url.searchParams.get("dryRun") === "1";
  const tokenOk = d.controlToken !== undefined && bearerOk(req.headers.authorization, d.controlToken);
  if (d.controlMode && !tokenOk) {
    // The ordinary refusal; it names the sensitive keys when the body shows a change to one.
    const sensitive = dryRun ? [] : await sensitiveInBody(d, req, name);
    if (sensitive.length) refuseSensitive(res, d.controlToken, sensitive);
    else { res.writeHead(401, { "www-authenticate": "Bearer" }); res.end("unauthorized"); }
    return true;
  }
  const raw = await d.body(req); // over the cap this throws and nothing has been read or written
  const input = parseBody(raw);
  if (input === "notjson") { json(res, 400, { ok: false, issues: [{ path: "", message: "the body is not JSON" }] }); return true; }
  if (!input) {
    json(res, 400, { ok: false, issues: [{ path: "", message: "the body must be { etag: string, values: object }" }] });
    return true;
  }
  const { etag, values } = input;
  if (!dryRun && !tokenOk) {
    const sensitive = changedSensitiveKeys(readFileSync(d.file(), "utf8"), name, values);
    if (sensitive.length) { refuseSensitive(res, d.controlToken, sensitive); return true; }
  }

  // Everything from here to the write is synchronous, so no other request can change the file in between.
  const file = d.file();
  const text = readFileSync(file, "utf8");
  const current = etagOf(text);
  if (etag !== current) { json(res, 409, { ok: false, etag: current }); return true; }
  const edit = applySection(text, name, values as Record<string, unknown>, secretsSet(d), runningOverrides(d, name));
  if (!edit.ok) { json(res, 400, { ok: false, issues: edit.issues }); return true; }
  const warnings = edit.warnings;
  if (dryRun) { json(res, 200, { ok: true, dryRun: true, warnings }); return true; }
  try { d.write(file, edit.text); } catch (e) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end(String((e as Error).message ?? e)); return true; }

  const stack = d.stack();
  const running = new Set(stack.docker.ok ? stack.services.filter((s) => s.status === "running").map((s) => s.service) : []);
  json(res, 200, { ok: true, etag: etagOf(edit.text), restart: readers(d.manifest, name).filter((id) => running.has(id)), warnings });
  return true;
}
