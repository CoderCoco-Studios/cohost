import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as shared from "../src/index.js";

const pkg = (rel: string) => JSON.parse(readFileSync(new URL(`../../../${rel}/package.json`, import.meta.url), "utf8")) as { dependencies?: Record<string, string> };
const workspaceDeps = (rel: string) => Object.entries(pkg(rel).dependencies ?? {}).filter(([, v]) => v.startsWith("workspace:")).map(([k]) => k).sort();

// @spec SHARED-BOUND-001
test("service-only behaviour stays in its service: the lip-sync envelope, output gain and speaker capture are not exported by shared", () => {
  for (const name of ["envelope", "lipSyncEnvelope", "applyGain", "gain", "listenTo", "Hearing", "discordPcmToWav16k", "wavToDiscordPcm"]) {
    assert.equal(name in shared, false, `shared must not export ${name}`);
  }
  const voice = readFileSync(new URL("../../../services/voice/src/wav.ts", import.meta.url), "utf8");
  assert.match(voice, /envelope/i, "the envelope lives in voice");
  const mouth = readFileSync(new URL("../../../services/mouth/src/audio.ts", import.meta.url), "utf8");
  assert.match(mouth, /applyGain/, "output gain lives in mouth");
});

// @spec SHARED-BOUND-002
test("shared depends on config and bus only among workspace packages, and bus does not depend on shared", () => {
  assert.deepEqual(workspaceDeps("packages/shared"), ["@cohost/bus", "@cohost/config"]);
  assert.ok(!workspaceDeps("packages/bus").includes("@cohost/shared"));
  const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir).pathname]));
  for (const f of walk(new URL("../../bus/src/", import.meta.url))) assert.doesNotMatch(readFileSync(f, "utf8"), /@cohost\/shared/, f);
  for (const f of walk(new URL("../src/", import.meta.url))) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /from "@cohost\/(llm|control|modules|working-memory|testing)"/, f);
  }
});
