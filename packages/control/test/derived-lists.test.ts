import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

const composeNames = units.map((u) => u.composeName);

// @spec MOD-MAN-008
test("every unit has a Compose service named for its composeName, and every Compose service built from the shared Dockerfile belongs to a unit", () => {
  for (const u of units) assert.ok(composeServices[u.composeName], `unit ${u.id} has no Compose service ${u.composeName}`);
  for (const [name, s] of Object.entries(composeServices)) {
    if (!s.build) continue;
    // a one-shot of a unit (memory's consolidate and reembed) is built with that unit's SERVICE argument
    const owner = s.build.args?.SERVICE;
    assert.ok(composeNames.includes(name) || (owner !== undefined && composeNames.includes(owner)), `Compose service ${name} is built from the shared Dockerfile and has no unit`);
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
  // `dashboard` is host-run, not a unit: the one section no unit declares.
  const hostRun = new Set(["dashboard"]);
  for (const sec of sections) assert.ok(declared.has(sec) || hostRun.has(sec), `section ${sec} is declared by no unit`);
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
  for (const u of units) if (!NOT_ON_RUN_SERVICE[u.id]) assert.equal(entryProblem(u.composeName), undefined, u.id);
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

/** Every `service: "<name>"` literal in the unit's `index.ts` and `health.ts` (comments removed). */
const heartbeatNames = (id: string): string[] =>
  ["index.ts", "health.ts"].flatMap((f) => {
    const file = rootPath(`services/${id}/src/${f}`);
    if (!existsSync(file)) return [];
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    return [...code.matchAll(/\bservice:\s*"([^"]+)"/g)].map((m) => m[1]!);
  });

// @spec MOD-MAN-012
test("for every unit with a Compose service, the name its healthcheck is given equals the service its heartbeat publishes", () => {
  assert.ok(readdirSync(rootPath("services")).length > 0);
  for (const u of units) {
    const given = composeServices[u.composeName]?.build?.args?.SERVICE;
    assert.equal(given, u.id, `${u.id}: its Compose service builds with SERVICE=${given}, which the healthcheck checks`);
    const published = heartbeatNames(u.composeName);
    assert.ok(published.length > 0, `${u.id}: no heartbeat service name found in its entry or health file`);
    for (const name of published) assert.equal(name, given, `${u.id}: heartbeat service ${name} is not the name its healthcheck is given (${given})`);
  }
});
