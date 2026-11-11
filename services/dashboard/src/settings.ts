import type http from "node:http";
import { readFileSync } from "node:fs";
import { applySection, etagOf, readSection, sectionJsonSchema, sectionSecrets, writeFileAtomic } from "@cohost/config";
import type { ServiceDef } from "@cohost/control";
import type { StackSnapshot } from "./stack.js";

export interface SettingsDeps {
  /** The path of config.yaml, seeded from the example when missing. */
  file: () => string;
  /** The environment placeholders are substituted from. */
  env: NodeJS.ProcessEnv;
  /** Replaces `file` with `text` atomically. */
  write: (file: string, text: string) => void;
  manifest: readonly ServiceDef[];
  /** The latest stack status. */
  stack: () => Pick<StackSnapshot, "docker" | "services">;
  /** False (and the response sent) when a gated request lacks the control token. */
  authorize: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  /** The request body as text, capped at 64 KiB (throws past the cap). */
  body: (req: http.IncomingMessage) => Promise<string>;
}

export const defaultWrite = writeFileAtomic;

const json = (res: http.ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

/** The declared sections, in manifest order, then `dashboard`. */
const declaredSections = (manifest: readonly ServiceDef[]): string[] => [...new Set(manifest.flatMap((s) => s.config)), "dashboard"];
const readers = (manifest: readonly ServiceDef[], section: string): string[] => manifest.filter((s) => s.config.includes(section)).map((s) => s.id);

/**
 * The settings editor's routes: `GET /config/schema`, `GET /config/:section`, `PUT /config/:section`. They read and write
 * `config.yaml` through `@cohost/config`'s editor, never touch `.env`, and never start, stop or restart a unit.
 */
// @spec MOD-CFG-001, MOD-CFG-003, MOD-CFG-007, MOD-CFG-016
export async function handleConfig(d: SettingsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/config/")) return false;
  const name = decodeURIComponent(url.pathname.slice("/config/".length));
  const sections = declaredSections(d.manifest);

  if (req.method === "GET" && name === "schema") {
    json(res, 200, {
      sections: sections.map((path) => ({ path, services: readers(d.manifest, path), schema: sectionJsonSchema(path), secrets: sectionSecrets(path) })),
    });
    return true;
  }
  if (req.method !== "GET" && req.method !== "PUT") return false;
  if (!sections.includes(name)) { json(res, 404, { ok: false, detail: "unknown section" }); return true; }

  if (req.method === "GET") {
    const text = readFileSync(d.file(), "utf8");
    json(res, 200, { section: name, etag: etagOf(text), ...readSection(text, name, d.env) });
    return true;
  }

  if (!d.authorize(req, res)) return true;
  const raw = await d.body(req); // over the cap this throws and nothing has been read or written
  let input: { etag?: unknown; values?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { json(res, 400, { ok: false, issues: [{ path: "", message: "the body is not JSON" }] }); return true; }
  const { etag, values } = input ?? {};
  if (typeof etag !== "string" || typeof values !== "object" || values === null || Array.isArray(values)) {
    json(res, 400, { ok: false, issues: [{ path: "", message: "the body must be { etag: string, values: object }" }] });
    return true;
  }

  // Everything from here to the write is synchronous, so no other request can change the file in between.
  const file = d.file();
  const text = readFileSync(file, "utf8");
  const current = etagOf(text);
  if (etag !== current) { json(res, 409, { ok: false, etag: current }); return true; }
  const edit = applySection(text, name, values as Record<string, unknown>, d.env);
  if (!edit.ok) { json(res, 400, { ok: false, issues: edit.issues }); return true; }
  const warnings = [...edit.warnings, ...(name === "dashboard" ? ["the dashboard reads this section at start: the change applies at the dashboard's next start"] : [])];
  if (url.searchParams.get("dryRun") === "1") { json(res, 200, { ok: true, dryRun: true, warnings }); return true; }
  try { d.write(file, edit.text); } catch (e) { res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end(String((e as Error).message ?? e)); return true; }

  const stack = d.stack();
  const running = new Set(stack.docker.ok ? stack.services.filter((s) => s.status === "running").map((s) => s.service) : []);
  json(res, 200, { ok: true, etag: etagOf(edit.text), restart: readers(d.manifest, name).filter((id) => running.has(id)), warnings });
  return true;
}
