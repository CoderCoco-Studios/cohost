// Shared setup for the Settings and Personality screen tests: a runtime of fakes answering the settings routes.
import { afterEach } from "node:test";
import { act, makeApp, renderApp, type TestApp } from "./helpers/render";
import { Screen } from "../../ui/src/screens/settings";
import { disposeSettings } from "../../ui/src/screens/settings/store";
import { accountRead, demoRead, extraRead, plainRead, schemaPayload, type KeyRead } from "./settings-fixture";

const apps: TestApp[] = [];
afterEach(() => { for (const a of apps.splice(0)) disposeSettings(a.rt); });

export interface BootOptions {
  section?: string;
  /** Replace the schema answer. */
  schema?: unknown;
  app?: TestApp;
  /** Routes to answer before the screen mounts. */
  routes?: Record<string, Parameters<TestApp["fetch"]["on"]>[1]>;
  noRoutes?: boolean;
}

type Reply = { status: number; json: unknown };
type Props = Record<string, { type?: string; minimum?: number; maximum?: number; minLength?: number; enum?: unknown[] }>;

/**
 * The config file as the real server models it (services/dashboard/src/settings.ts): ONE etag for the whole config.yaml, returned
 * by every section read and by every write response. The etag is a hash of the file's text, so it changes when a write changes
 * the text and stays when the written text is byte-identical to what the file held. A write whose etag is not the current one is
 * a 409 that carries the current etag, answered before any validation; a body whose values do not satisfy the schema is a 400
 * with issues, answered after it and writing nothing; a dry run validates and writes nothing. A read after a write returns the
 * written values (as literals). `restart` is what a successful write to a section answers.
 */
export interface FileModel {
  etag: string;
  writes: number;
  restart: Record<string, string[]>;
  /** The values written so far (and by `otherClient`), by section, overlaid on the fixture's reads. */
  written: Record<string, Record<string, unknown>>;
  /** The section routes (`GET`/`PUT /config/<section>`) answer from this model; a test that replaces one keeps the rest. */
  put(section: string): (call: { body?: string; path: string }) => Reply;
  get(section: string): () => Reply;
  /** Another client writes `values` into `section`: the text changes, so the etag does. */
  otherClient(section: string, values: Record<string, unknown>): void;
  /** A PUT whose answer never arrives; the write reached the file first when `applied`. */
  lost(section: string, applied: boolean): (call: { body?: string; path: string }) => Promise<Reply>;
}

const REGISTRY: Record<string, { read: { keys: Record<string, KeyRead>; [k: string]: unknown }; props: Props }> = {};
for (const sec of schemaPayload.sections) {
  const read = [demoRead, extraRead, accountRead, plainRead].find((r) => r.section === sec.path);
  if (read) REGISTRY[sec.path] = { read, props: ((sec.schema as { properties?: Props }).properties ?? { [sec.path]: sec.schema as Props[string] }) };
}

/** The schema check the real editor makes (type, bounds, enum), for the top-level keys of a section. */
function issuesOf(section: string, values: Record<string, unknown>): { path: string; message: string }[] {
  const props = REGISTRY[section]?.props ?? {};
  const out: { path: string; message: string }[] = [];
  for (const [k, v] of Object.entries(values)) {
    const p = props[k] ?? (section === k ? props[k] : undefined);
    if (!p || !p.type) continue;
    const bad = (message: string): void => { out.push({ path: `${section}.${k}`, message }); };
    if (p.type === "integer" || p.type === "number") {
      if (typeof v !== "number" || (p.type === "integer" && !Number.isInteger(v))) bad(`expected ${p.type}`);
      else if (p.minimum !== undefined && v < p.minimum) bad(`must be at least ${p.minimum}`);
      else if (p.maximum !== undefined && v > p.maximum) bad(`must be at most ${p.maximum}`);
    } else if (p.type === "string") {
      if (typeof v !== "string") bad("expected string");
      else if (p.enum && !p.enum.includes(v)) bad(`must be one of ${p.enum.join(", ")}`);
      else if (p.minLength !== undefined && v.length < p.minLength) bad(`must have at least ${p.minLength} characters`);
    } else if (p.type === "boolean" && typeof v !== "boolean") bad("expected boolean");
  }
  return out;
}

function fileModel(): FileModel {
  const m: FileModel = {
    etag: "e1", writes: 0, restart: {}, written: {},
    get: (section) => () => {
      const reg = REGISTRY[section]!;
      const keys = { ...reg.read.keys };
      for (const [k, v] of Object.entries(m.written[section] ?? {})) keys[k] = { source: "literal", editable: true, value: v, raw: JSON.stringify(v) };
      return { status: 200, json: { ...reg.read, keys, etag: m.etag } };
    },
    put: (section) => (call) => {
      const sent = JSON.parse(call.body ?? "{}") as { etag?: string; values?: Record<string, unknown> };
      if (sent.etag !== m.etag) return { status: 409, json: { ok: false, etag: m.etag } };
      const values = sent.values ?? {};
      const issues = issuesOf(section, values);
      if (issues.length > 0) return { status: 400, json: { ok: false, issues } };
      if (call.path.includes("dryRun=1")) return { status: 200, json: { ok: true, dryRun: true, warnings: [] } }; // a dry run writes nothing
      const current = (m.get(section)().json as { keys: Record<string, KeyRead> }).keys;
      const identical = Object.entries(values).every(([k, v]) => current[k]?.source === "literal" && JSON.stringify(current[k]!.value) === JSON.stringify(v));
      if (!identical) { m.written[section] = { ...m.written[section], ...values }; m.etag = `f${++m.writes}`; }
      return { status: 200, json: { ok: true, etag: m.etag, restart: m.restart[section] ?? [], warnings: [] } };
    },
    otherClient: (section, values) => { m.written[section] = { ...m.written[section], ...values }; m.etag = `f${++m.writes}`; },
    lost: (section, applied) => async (call) => {
      if (applied) m.put(section)(call);
      throw new TypeError("network error");
    },
  };
  return m;
}

/** Mounts the Settings screen on a section with the fixture's routes answered. */
export function boot(opts: BootOptions = {}) {
  const app = opts.app ?? makeApp();
  apps.push(app);
  const f = app.fetch;
  const file = fileModel();
  f.on("GET /config/schema", { json: opts.schema ?? schemaPayload });
  for (const [path, read] of [["demo", demoRead], ["extra", extraRead], ["llm", accountRead], ["plain", plainRead]] as const) {
    void read;
    f.on(`GET /config/${path}`, file.get(path));
    f.on(`PUT /config/${path}`, file.put(path));
  }
  f.on("GET /services/control", { json: { runtime: "compose", advanced: false, unlocked: false } });
  f.on("GET /personality", { text: "# Coco\n" });
  f.on("GET /options/models", { json: { models: ["llama3.2:3b", "qwen2.5:7b"] } });
  f.on("GET /options/voices", { json: { voices: ["af_heart", "bm_george"] } });
  for (const [k, v] of Object.entries(opts.routes ?? {})) f.on(k, v);
  const r = renderApp(<Screen route={{ view: "settings", section: opts.section ?? "demo" }} />, app);
  return { ...r, app, file };
}

/** Lets pending promises (fetch answers, state updates) settle inside act. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
