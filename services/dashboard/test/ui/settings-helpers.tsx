// Shared setup for the Settings and Personality screen tests: a runtime of fakes answering the settings routes.
import { afterEach } from "node:test";
import { act, makeApp, renderApp, type TestApp } from "./helpers/render";
import { Screen } from "../../ui/src/screens/settings";
import { disposeSettings } from "../../ui/src/screens/settings/store";
import { accountRead, demoRead, extraRead, plainRead, schemaPayload } from "./settings-fixture";

const apps: TestApp[] = [];
afterEach(() => { for (const a of apps.splice(0)) disposeSettings(a.rt); });

export interface BootOptions {
  section?: string;
  /** Replace the schema answer. */
  schema?: unknown;
  /** `GET /services/control`; default enabled. */
  control?: boolean;
  app?: TestApp;
  /** Routes to answer before the screen mounts. */
  routes?: Record<string, Parameters<TestApp["fetch"]["on"]>[1]>;
  noRoutes?: boolean;
}

/**
 * The file's etag as the real server models it (services/dashboard/src/settings.ts): ONE etag for the whole config.yaml, returned
 * by every section read and by every write response, changing on every successful write; a write whose etag is not the current
 * one is a 409 that carries the current etag. `restart` is what a successful write to a section answers.
 */
export interface FileModel {
  etag: string;
  writes: number;
  restart: Record<string, string[]>;
  /** The section routes (`GET`/`PUT /config/<section>`) answer from this model; a test that replaces one keeps the rest. */
  put(section: string): (call: { body?: string; path: string }) => { status: number; json: unknown };
}

function fileModel(): FileModel {
  const m: FileModel = {
    etag: "e1", writes: 0, restart: {},
    put: (section) => (call) => {
      const sent = (JSON.parse(call.body ?? "{}") as { etag?: string }).etag;
      if (sent !== m.etag) return { status: 409, json: { ok: false, etag: m.etag } };
      if (call.path.includes("dryRun=1")) return { status: 200, json: { ok: true, dryRun: true, warnings: [] } }; // a dry run writes nothing
      m.etag = `f${++m.writes}`;
      return { status: 200, json: { ok: true, etag: m.etag, restart: m.restart[section] ?? [], warnings: [] } };
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
    f.on(`GET /config/${path}`, () => ({ json: { ...read, etag: file.etag } }));
    f.on(`PUT /config/${path}`, file.put(path));
  }
  f.on("GET /services/control", { json: opts.control === false ? { enabled: false } : { enabled: true, runtime: "compose", advanced: false } });
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
