import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// @spec WM-PKG-001
test("shared is the only runtime dependency; bus and config are development dependencies only: the package imports them for types", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ["@cohost/shared"]);
  assert.ok(pkg.devDependencies?.["@cohost/bus"], "@cohost/bus is a devDependency");
  assert.ok(pkg.devDependencies?.["@cohost/config"], "@cohost/config is a devDependency");
});

// @spec WM-PKG-001
test("the source imports @cohost/shared only through the untrusted subpath", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const specs = [...src.matchAll(/from\s+"(@cohost\/shared[^"]*)"/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, "imports from shared");
  assert.ok(specs.every((s) => s === "@cohost/shared/untrusted"), `got ${specs.join(", ")}`);
  assert.ok(!/^import(?!\s+type)[^\n]*"@cohost\/(bus|config)"/m.test(src), "bus/config are type imports only");
});
