import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Project = { include?: string[]; references?: { path: string }[] };
const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Project;

// @spec AVATAR-DEV-001
test("the test files are a project of the workspace build: tsc -b type-checks them", () => {
  const tests = read("./tsconfig.json");
  assert.deepEqual(tests.include, ["."]);
  assert.ok(tests.references?.some((r) => r.path === ".."), "the test project builds after the service sources");
  const root = read("../../../tsconfig.json");
  assert.ok(root.references?.some((r) => r.path === "services/avatar/test"), "the root build includes the test project");
});
