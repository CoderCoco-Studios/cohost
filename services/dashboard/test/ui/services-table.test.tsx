import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, screen } from "./helpers/render";
import { mountServices, push, svc } from "./services-fixtures";

// @spec DASH-UI-059
test("the Last seen cell shows only the Docker restart count and keeps its line when the count is unknown", async () => {
  const { app } = await mountServices({ services: [svc("memory", { restarts: 1, containerRestarts: 1 }), svc("chat", { restarts: 1 })] });
  const cell = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}\\b`) }).querySelector(".svc-restarts")!;
  assert.equal(cell("memory").textContent, "1 restart");
  assert.equal(cell("chat").textContent, "", "no Docker count: the line is empty but present");
  push(app, { type: "services", services: [svc("memory", { restarts: 0, containerRestarts: 3 }), svc("chat")] });
  assert.equal(cell("memory").textContent, "3 restarts");
  act(() => {});
});

// @spec DASH-UI-059
test("the Services table has fixed column widths that do not follow the cell text", async () => {
  await mountServices({ services: [svc("memory")] });
  const table = screen.getByRole("table", { name: "Services" });
  const cols = table.querySelectorAll("colgroup > col");
  assert.equal(cols.length, 5);
  for (const c of cols) assert.ok(c.className.startsWith("svc-col-"), "each column has a width class");
  const css = readFileSync(new URL("../../ui/src/styles/services.css", import.meta.url), "utf8");
  assert.match(css, /\.svc-table\s*\{[^}]*table-layout:\s*fixed/);
  for (const c of cols) assert.match(css, new RegExp(`\\.${c.className}\\s*\\{[^}]*width:`));
  assert.match(css, /\.svc-restarts\s*\{[^}]*min-height:/);
});
