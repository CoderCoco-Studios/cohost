import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// @spec WM-PKG-001
test("bus and config are development dependencies only: the package imports them for types", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.ok(pkg.devDependencies?.["@cohost/bus"], "@cohost/bus is a devDependency");
  assert.ok(pkg.devDependencies?.["@cohost/config"], "@cohost/config is a devDependency");
});
