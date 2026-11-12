import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { EVENT_TYPES } from "@cohost/bus";
import { ConfigSchema, schemaAt } from "@cohost/config";
import { SERVICE_MANIFEST } from "../src/index.js";
import { entryProblem, OWN_BOOTSTRAP } from "../../testing/src/unit-contract.js";

// The checks that keep the manifest and the files derived from it in step: Compose, the config schema, the bus
// registry and each unit's entry file (module-contract MOD-MAN-008, MOD-MAN-009).

const units = SERVICE_MANIFEST.filter((s) => s.pnpmFilter);
const unitIds = units.map((u) => u.id);
const rootPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

interface ComposeFile { services: Record<string, { build?: { args?: { SERVICE?: string } } }> }
const composeServices = (parse(readFileSync(rootPath("docker-compose.yml"), "utf8"), { merge: true }) as ComposeFile).services;

// @spec MOD-MAN-008
test("every unit has a Compose service of the same name, and every Compose service built from the shared Dockerfile belongs to a unit", () => {
  for (const id of unitIds) assert.ok(composeServices[id], `unit ${id} has no Compose service`);
  for (const [name, s] of Object.entries(composeServices)) {
    if (!s.build) continue;
    // a one-shot of a unit (memory's consolidate and reembed) is built with that unit's SERVICE argument
    const owner = s.build.args?.SERVICE;
    assert.ok(unitIds.includes(name) || (owner !== undefined && unitIds.includes(owner)), `Compose service ${name} is built from the shared Dockerfile and has no unit`);
  }
});

const shapeKeys = (s: unknown): string[] => {
  let cur = s as { _def?: { innerType?: unknown; schema?: unknown }; shape?: Record<string, unknown> };
  while (cur && !cur.shape && (cur._def?.innerType || cur._def?.schema)) cur = (cur._def!.innerType ?? cur._def!.schema) as typeof cur;
  return Object.keys(cur.shape ?? {});
};

// @spec MOD-MAN-008
test("every declared section is a path of ConfigSchema, and every section ConfigSchema defines is declared by a unit or is dashboard", () => {
  for (const u of units) for (const sec of u.config) assert.ok(schemaAt(sec), `${u.id}: ${sec} is not a config path`);
  const declared = new Set(units.flatMap((u) => u.config));
  const sections = shapeKeys(ConfigSchema).flatMap((k) => (k === "brain" ? shapeKeys(schemaAt("brain")).map((c) => `brain.${c}`) : [k]));
  assert.ok(sections.length >= 10, `read ${sections.join(", ")}`);
  for (const sec of sections) assert.ok(declared.has(sec) || sec === "dashboard", `section ${sec} is declared by no unit`);
});

const registered = new Set<string>(EVENT_TYPES);
const barred = (t: string) => !registered.has(t) || t === "service.heartbeat" || t === "service.lifecycle" || /^memory\.(notes|viewers)\./.test(t);

// @spec MOD-MAN-008
test("a declared bus input or observed type must be registered and not a heartbeat, lifecycle or viewer-notes event", () => {
  for (const bad of ["no.such.event", "service.heartbeat", "service.lifecycle", "memory.notes.reply", "memory.viewers.request"]) assert.ok(barred(bad), bad);
  for (const ok of ["chat.message", "inject.result", "memory.viewer"]) assert.ok(!barred(ok), ok);
  for (const u of units) {
    for (const t of [...u.test.inputs.filter((i) => !["text", "image", "audio"].includes(i)), ...u.test.observe]) assert.ok(!barred(t), `${u.id}: ${t}`);
  }
});

/**
 * A unit that has not yet moved onto the shared bootstrap, with the chunk that moves it. Empty when every unit complies;
 * an entry here is the only way a unit may fail the entry check.
 */
const NOT_ON_RUN_SERVICE: Record<string, string> = {};

// @spec MOD-MAN-009
test("each unit's entry file reaches runService and builds no bus or heartbeat of its own", () => {
  for (const id of unitIds) if (!NOT_ON_RUN_SERVICE[id]) assert.equal(entryProblem(id), undefined, id);
});

// The dashboard is a host process, not a manifest unit with a pnpm filter, and takes the same entry check (DASH-HTTP-016).
// @spec MOD-MAN-009, DASH-HTTP-016
test("the dashboard's entry file reaches runService and builds no bus or heartbeat of its own", () => {
  assert.equal(entryProblem("dashboard"), undefined);
});

// @spec MOD-MAN-009
test("the entry check fails for an entry that builds its own bus, heartbeat or shutdown", () => {
  for (const code of ["const bus = new Bus('x');", "startHeartbeat(bus, spec);", "onShutdown(() => {});"]) assert.ok(OWN_BOOTSTRAP.test(code), code);
  assert.ok(!OWN_BOOTSTRAP.test("await runService({ service: 'chat', main });"));
});
