import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventPayloads } from "@cohost/bus";
import { FakeBus, recordingLog } from "@cohost/testing";
import { SERVICE_MANIFEST, type HealthState, type ServiceController, type ServiceHealth } from "@cohost/control";
import { createDashboardHandler } from "../src/routes.js";
import { UploadStore } from "../src/uploads.js";
import { StackService } from "../src/stack.js";

// The module contract's per-unit obligations, one table row per unit of SERVICE_MANIFEST (MOD-MAN-010): a unit added
// to the manifest without a declaration this table needs (a config section, a sample for an input) fails here.

const units = SERVICE_MANIFEST.filter((s) => s.pnpmFilter);
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const EXAMPLE = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** One valid payload per bus event type a unit may be fed; a type with no sample fails the table. */
const SAMPLES: Record<string, unknown> = {
  "chat.message": { platform: "twitch", user: "bob", text: "hi" },
  "speech.heard": { speaker: "chris", text: "hello", durationMs: 100 },
  "vision.summary": { text: "a boss fight", changed: true },
  "brain.say": { id: "s1", text: "hi", emotion: "neutral" },
  "memory.recall.request": { id: "r1", query: "q" },
  "attention.focus": { reason: "r", score: 0.5 },
  "affect.state": { valence: 0.2, arousal: 0.3, mood: "neutral" },
};
const KIND_ROUTE: Record<string, { path: string; type?: string; body: string }> = {
  text: { path: "/inject/text", body: JSON.stringify({ level: "service", text: "hi" }) },
  image: { path: "/inject/image", type: "image/png", body: "PNG" },
  audio: { path: "/inject/audio", type: "audio/wav", body: "RIFF" },
};

async function boot(states: Record<string, HealthState> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-unit-contract-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, EXAMPLE);
  const bus = new FakeBus();
  const rec = recordingLog();
  const calls: { action: string; id: string }[] = [];
  const act = (action: string) => async (id: string) => { calls.push({ action, id }); return { ok: true }; };
  const controller = { start: act("start"), stop: act("stop"), restart: act("restart") } as unknown as ServiceController;
  const services = (): ServiceHealth[] => units.map((u) => ({ service: u.id, state: states[u.id] ?? "up", restarts: 0 }));
  const server = http.createServer(createDashboardHandler({
    bus, log: rec.log, html: "x", cohostName: "Coco", voiceUrl: "http://127.0.0.1:1",
    loadPersonality: () => "p", savePersonality: () => {}, services,
    stack: new StackService({ log: rec.log, bus: () => "connected" }),
    configFile: () => file, configEnv: {},
    control: { token: "tok", runtime: "compose", advanced: false, controller },
    dashboardUrl: "http://dashboard:3000",
    uploads: new UploadStore({ maxImageBytes: 64, maxAudioBytes: 64, ttlMs: 600_000, maxEntries: 16, maxTotalBytes: 10_000 }),
  }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const auth = { authorization: "Bearer tok" };
  return { bus, calls, file, base, auth, text: () => readFileSync(file, "utf8") };
}

test("the table covers every application unit and each declares config and test inputs", () => {
  assert.equal(units.length, 10);
  for (const u of units) assert.ok(u.config.length > 0 && u.test.inputs.length > 0, u.id);
});

for (const u of units) {
  // @spec MOD-MAN-010, MOD-CFG-003, MOD-CFG-008, MOD-CFG-016
  test(`${u.id}: each declared section answers an etag, and a PUT with a stale etag is 409 writing nothing`, async () => {
    const t = await boot();
    for (const section of u.config) {
      const got = await fetch(`${t.base}/config/${section}`);
      assert.equal(got.status, 200, section);
      const j = (await got.json()) as { etag: string };
      assert.equal(j.etag, sha(t.text()), section);
      const stale = await fetch(`${t.base}/config/${section}`, {
        method: "PUT", headers: t.auth, body: JSON.stringify({ etag: sha("not the file"), values: {} }),
      });
      assert.equal(stale.status, 409, section);
      assert.deepEqual(await stale.json(), { ok: false, etag: j.etag });
    }
    assert.equal(t.text(), EXAMPLE);
    assert.deepEqual(t.calls, [], "the settings routes never drive a unit");
  });

  // @spec MOD-MAN-010, DASH-SVC-001
  test(`${u.id}: restart reaches the lifecycle controller for that unit alone`, async () => {
    const t = await boot();
    const r = await fetch(`${t.base}/services/${u.id}/restart`, { method: "POST", headers: t.auth });
    assert.equal(r.status, 200);
    assert.deepEqual(t.calls, [{ action: "restart", id: u.id }]);
  });

  // @spec MOD-MAN-010, MOD-TEST-002, MOD-TEST-003, MOD-TEST-005
  test(`${u.id}: each declared input is accepted while the unit is up and refused 409 while it is down or unknown`, async () => {
    for (const state of ["down", "unknown"] as const) {
      const down = await boot({ [u.id]: state });
      const up = await boot();
      for (const input of u.test.inputs) {
        const send = async (t: Awaited<ReturnType<typeof boot>>) => {
          if (KIND_ROUTE[input]) {
            const k = KIND_ROUTE[input]!;
            return fetch(`${t.base}${k.path}`, { method: "POST", body: k.body, headers: { ...t.auth, ...(k.type ? { "content-type": k.type } : {}) } });
          }
          assert.ok(input in EventPayloads, `${u.id}: ${input} is neither a service-level kind nor a bus event type`);
          assert.ok(input in SAMPLES, `${u.id}: add a sample payload for ${input}`);
          return fetch(`${t.base}/inject/event`, { method: "POST", body: JSON.stringify({ unit: u.id, type: input, data: SAMPLES[input] }), headers: t.auth });
        };
        const refused = await send(down);
        assert.equal(refused.status, 409, `${u.id}/${input} while ${state}`);
        assert.deepEqual(await refused.json(), { ok: false, detail: `service not running: ${KIND_ROUTE[input] ? ({ text: "chat", image: "eyes", audio: "ears" } as Record<string, string>)[input] : u.id}` });
        const accepted = await send(up);
        assert.equal(accepted.status, 202, `${u.id}/${input} while up`);
      }
      assert.equal(down.bus.published.length, 0, "a refused injection publishes nothing");
    }
  });
}
