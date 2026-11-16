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

/** Mounts the Settings screen on a section with the fixture's routes answered. */
export function boot(opts: BootOptions = {}) {
  const app = opts.app ?? makeApp();
  apps.push(app);
  const f = app.fetch;
  f.on("GET /config/schema", { json: opts.schema ?? schemaPayload });
  f.on("GET /config/demo", { json: demoRead });
  f.on("GET /config/extra", { json: extraRead });
  f.on("GET /config/llm", { json: accountRead });
  f.on("GET /config/plain", { json: plainRead });
  f.on("GET /services/control", { json: opts.control === false ? { enabled: false } : { enabled: true, runtime: "compose", advanced: false } });
  f.on("GET /personality", { text: "# Coco\n" });
  f.on("GET /options/models", { json: { models: ["llama3.2:3b", "qwen2.5:7b"] } });
  f.on("GET /options/voices", { json: { voices: ["af_heart", "bm_george"] } });
  for (const [k, v] of Object.entries(opts.routes ?? {})) f.on(k, v);
  const r = renderApp(<Screen route={{ view: "settings", section: opts.section ?? "demo" }} />, app);
  return { ...r, app };
}

/** Lets pending promises (fetch answers, state updates) settle inside act. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
