/**
 * The hook reply JSON Schemas (src/schemas.ts) against the real region validators, and against the files
 * `scripts/gen-hook-schemas.mjs` writes for operators.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { HOOK_REPLY_SCHEMAS, type HookName } from "../src/schemas.js";
import { createScorer } from "../../../services/salience/src/scoring.js";
import { createAppraiser } from "../../../services/affect/src/appraise.js";
import { createCritic } from "../../../services/cortex/src/critic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Just enough JSON Schema for the three contracts: type, required, properties, items, enum, minimum, maximum, minLength. */
function check(schema: Record<string, unknown>, v: unknown): boolean {
  const type = schema.type as string | undefined;
  if (type === "object" && (typeof v !== "object" || v === null || Array.isArray(v))) return false;
  if (type === "array" && !Array.isArray(v)) return false;
  if (type === "number" && (typeof v !== "number" || !Number.isFinite(v))) return false;
  if (type === "string" && typeof v !== "string") return false;
  if (type === "boolean" && typeof v !== "boolean") return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(v)) return false;
  if (typeof v === "number") {
    if (typeof schema.minimum === "number" && v < schema.minimum) return false;
    if (typeof schema.maximum === "number" && v > schema.maximum) return false;
  }
  if (typeof v === "string" && typeof schema.minLength === "number" && v.length < schema.minLength) return false;
  if (Array.isArray(v) && schema.items && !v.every((x) => check(schema.items as Record<string, unknown>, x))) return false;
  if (type === "object") {
    const o = v as Record<string, unknown>;
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in o)) return false;
    for (const [k, sub] of Object.entries((schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      if (k in o && !check(sub, o[k])) return false;
    }
  }
  return true;
}

let answer: unknown;
const stub = http.createServer(async (req, res) => { for await (const _ of req); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); });
await new Promise<void>((r) => stub.listen(0, r));
after(() => stub.close());
const url = `http://127.0.0.1:${(stub.address() as { port: number }).port}/m`;

const cfg = (brain: Record<string, unknown>) => ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain,
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});
const hook = { module: { kind: "http", url, timeout_ms: 5000 } };

/** Replies the schema accepts, replies of the wrong shape, and a request to send. */
const cases: Record<HookName, { valid: unknown[]; invalid: unknown[]; request: unknown; make: () => { run: (i: never) => Promise<unknown> } }> = {
  salience: {
    request: { arousal: 0.2, events: [{ kind: "chat", who: "v", text: "hi", mention: false, isMod: false, isSub: false, changed: false }] },
    valid: [{ scores: [0.5] }],
    invalid: [{ scores: "high" }, { scores: ["x"] }, { score: [0.5] }, [0.5]],
    make: () => createScorer(cfg({ salience: hook }), logTo(warns)),
  },
  affect: {
    request: { source: "chat", who: "v", text: "hi", mention: false, valence: 0, arousal: 0 },
    valid: [{ valence_delta: 0.1, arousal_delta: -0.2 }],
    invalid: [{ valence_delta: "up", arousal_delta: 0 }, { valence_delta: 0.1 }, {}, "sad"],
    make: () => createAppraiser(cfg({ affect: hook }), logTo(warns)),
  },
  critic: {
    request: { text: "A line.", emotion: "happy", reason: "idle", transcript: "" },
    valid: [{ ok: true }, { ok: false, note: "no" }, { ok: true, text: "Fixed.", emotion: "smug" }],
    invalid: [{ ok: "yes" }, { text: "x" }, [true], "ok"],
    make: () => createCritic(cfg({ cortex: { critic: hook.module } }), logTo(warns)),
  },
};
const warns: string[] = [];
function logTo(sink: string[]): never {
  return { info() {}, error() {}, debug() {}, warn: (_o: unknown, msg: string) => sink.push(msg) } as never;
}

for (const name of ["salience", "affect", "critic"] as const) {
  // @spec HOOK-SCHEMA-001, HOOK-SCHEMA-002
  test(`${name}: replies the schema accepts are used by the region, replies of the wrong shape fall back to its rules`, async () => {
    const c = cases[name];
    const schema = HOOK_REPLY_SCHEMAS[name];
    for (const reply of c.valid) {
      assert.equal(check(schema, reply), true, `schema accepts ${JSON.stringify(reply)}`);
      answer = reply; warns.length = 0;
      await c.make().run(c.request as never);
      assert.deepEqual(warns, [], `${name} used ${JSON.stringify(reply)}`);
    }
    for (const reply of c.invalid) {
      assert.equal(check(schema, reply), false, `schema rejects ${JSON.stringify(reply)}`);
      answer = reply; warns.length = 0;
      await c.make().run(c.request as never);
      assert.equal(warns.length, 1, `${name} fell back on ${JSON.stringify(reply)}`);
    }
  });

  // @spec HOOK-SCHEMA-003
  test(`${name}: examples/modules/schemas/${name}.json is what the generator writes from the schema`, () => {
    const onDisk = JSON.parse(readFileSync(path.join(root, "examples/modules/schemas", `${name}.json`), "utf8"));
    assert.deepEqual(onDisk, HOOK_REPLY_SCHEMAS[name]);
  });
}

// @spec HOOK-SCHEMA-003
test("the example README cites each generated schema", () => {
  const readme = readFileSync(path.join(root, "examples/modules/README.md"), "utf8");
  for (const name of ["salience", "affect", "critic"]) assert.match(readme, new RegExp(`schemas/${name}\\.json`));
});

// @spec HOOK-SCHEMA-002
test("salience: a score count that differs from the event count is outside what a schema can say, and the validator rejects it", async () => {
  const c = cases.salience;
  answer = { scores: [0.5, 0.5] }; warns.length = 0;
  await c.make().run(c.request as never);
  assert.equal(warns.length, 1);
});
