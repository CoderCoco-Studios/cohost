import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { createDashboardHandler } from "../src/routes.js";
import { lanHandler } from "../src/host.js";
import type { StackService } from "../src/stack.js";
import { configDir, configText } from "./config-fixture.js";

interface Entry { service: string; data: string; engine: string; host?: string; hosted?: string; offLan: boolean }

async function boot(dir: string) {
  process.env["CONFIG_DIR"] = dir;
  process.env["COHOST_ENV_FILE"] = join(dir, "no.env");
  after(() => { delete process.env["CONFIG_DIR"]; delete process.env["COHOST_ENV_FILE"]; });
  const handler = createDashboardHandler({ tokenRequired: false,
    bus: new FakeBus(), log: recordingLog().log, cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services: () => [], stack: {} as unknown as StackService,
  });
  const full = http.createServer(handler);
  const lan = http.createServer(lanHandler(handler));
  await Promise.all([full, lan].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  after(() => { full.close(); lan.close(); });
  const at = (s: http.Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  return { get: (p = "/egress") => fetch(at(full) + p), lanGet: (p = "/egress") => fetch(at(lan) + p), dir };
}

const MIXED = configText({
  network: { lan: ["corp.example.com"] },
  voice: { engine: "openai", "openai.base_url": "https://api.example.com/v1" },
  llm: { provider: "anthropic" },
});

// @spec DASH-EGR-001
test("GET /egress answers {destinations} from egressDestinations over the loaded config, ungated, with network.lan applied", async () => {
  const t = await boot(configDir(MIXED));
  const r = await t.get();
  assert.equal(r.status, 200);
  const { destinations } = (await r.json()) as { destinations: Entry[] };
  const voice = destinations.find((d) => d.service === "voice")!;
  assert.deepEqual(voice, { service: "voice", data: "text", engine: "openai", host: "api.example.com", offLan: true });
  const cortex = destinations.find((d) => d.service === "cortex")!;
  assert.deepEqual(cortex, { service: "cortex", data: "text", engine: "anthropic", hosted: "anthropic", offLan: true });
  assert.ok(destinations.some((d) => d.service === "ears" && d.data === "audio"), "ears audio entry present");
  for (const d of destinations) assert.equal(typeof d.offLan, "boolean");
});

// @spec DASH-EGR-001
test("a host named in network.lan, and a bare Compose service name, read as the LAN", async () => {
  const t = await boot(configDir(configText({
    network: { lan: ["corp.example.com"] },
    voice: { engine: "pocket", "pocket.url": "http://corp.example.com:8000" },
    ears: { stt_engine: "openai", "openai.base_url": "http://stt-box:9000/v1" },
  })));
  const { destinations } = (await (await t.get()).json()) as { destinations: Entry[] };
  assert.equal(destinations.find((d) => d.service === "voice")!.offLan, false);
  const ears = destinations.find((d) => d.service === "ears")!;
  assert.equal(ears.host, "stt-box");
  assert.equal(ears.offLan, false);
});

// @spec DASH-EGR-001
test("the answer follows the saved file: it is read afresh on every request, not held from the first", async () => {
  const dir = configDir(configText({ voice: { engine: "openai", "openai.base_url": "https://one.example.com/v1" } }));
  const t = await boot(dir);
  const host = async () => ((await (await t.get()).json()) as { destinations: Entry[] }).destinations.find((d) => d.service === "voice")!.host;
  assert.equal(await host(), "one.example.com");
  writeFileSync(join(dir, "config.yaml"), configText({ voice: { engine: "openai", "openai.base_url": "https://two.example.com/v1" } }));
  assert.equal(await host(), "two.example.com");
});

// @spec DASH-EGR-002
test("GET /egress is not served on the LAN listener: 404", async () => {
  const t = await boot(configDir(MIXED));
  assert.equal((await t.get()).status, 200);
  assert.equal((await t.lanGet()).status, 404);
});

// @spec DASH-EGR-003
test("no answer carries a secret value: not a key in secrets.yaml, not credentials inside a configured URL", async () => {
  const t = await boot(configDir(
    configText({ voice: { engine: "openai", "openai.base_url": "https://user:pw-URL-SECRET@api.example.com/v1" } }),
    `voice:\n  openai:\n    api_key: sk-SECRET-KEY-123\nllm:\n  claude:\n    api_key: sk-SECRET-CLAUDE\n`,
  ));
  const r = await t.get();
  assert.equal(r.status, 200);
  const text = await r.text();
  for (const s of ["sk-SECRET-KEY-123", "sk-SECRET-CLAUDE", "pw-URL-SECRET"]) assert.ok(!text.includes(s), `the answer holds ${s}`);
});

// @spec DASH-EGR-004
test("a config that fails to load answers 500 {ok: false, detail} naming the loader's error, no-store, and the next request re-reads", async () => {
  const dir = configDir(configText().replace('engine: "kokoro"', 'engine: "nonsense"'));
  const t = await boot(dir);
  const r = await t.get();
  assert.equal(r.status, 500);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = (await r.json()) as { ok: boolean; detail: string };
  assert.equal(body.ok, false);
  assert.match(body.detail, /voice\.engine/);
  writeFileSync(join(dir, "config.yaml"), MIXED);
  assert.equal((await t.get()).status, 200, "a failure is never cached");
});
