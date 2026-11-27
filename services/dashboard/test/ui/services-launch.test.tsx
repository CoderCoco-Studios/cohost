import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, screen, userEvent, within } from "./helpers/render";
import { mountServices, push, stackMsg, svc } from "./services-fixtures";

const card = () => screen.getByRole("region", { name: "Stack" });
const panel = () => within(card()).getByRole("group", { name: /^Launch progress/ });

const record = (over: Record<string, unknown> = {}) => ({
  type: "stack-progress", kind: "launch", startedAt: 1, running: true, rows: [], lines: [], ...over,
});

// @spec DASH-UI-055
test("the Launch panel names the action and its outcome and lists a row per service with its state, step and steps done", async () => {
  const { app } = await mountServices({ stack: stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: 1 } }) });
  assert.equal(within(card()).queryByRole("group", { name: /^Launch progress/ }), null, "no record, no panel");
  push(app, record({ rows: [
    { service: "voice", state: "building", step: 2, of: 4, total: 6, done: 3, cached: 1, current: "RUN pip install -r requirements.txt" },
    { service: "chat", state: "cached", step: 3, of: 3, total: 3, done: 3, cached: 3 },
  ] }));
  const p = panel();
  assert.match(p.textContent ?? "", /Launch.*running/i);
  const rows = within(p).getAllByRole("row").slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent ?? "", /voice/);
  assert.match(rows[0]!.textContent ?? "", /building/);
  assert.match(rows[0]!.textContent ?? "", /step 2 of 4/);
  assert.match(rows[0]!.textContent ?? "", /RUN pip install -r requirements\.txt/);
  assert.match(rows[0]!.textContent ?? "", /3\/6 steps/);
  assert.match(rows[1]!.textContent ?? "", /chat.*cached/);
  push(app, record({ running: false, ok: true, finishedAt: 2, rows: [{ service: "chat", state: "built", done: 3, total: 3, cached: 0 }] }));
  assert.match(panel().textContent ?? "", /finished/i);
  push(app, record({ kind: "restart", running: false, ok: false, finishedAt: 2, rows: [{ service: "voice", state: "done" }, { service: "chat", state: "failed", detail: "boom" }] }));
  assert.match(panel().textContent ?? "", /Restart all.*failed/i);
  assert.match(panel().textContent ?? "", /restarting|done/);
});

// @spec DASH-UI-056
test("a failure shows inline in an alert with the failing image and its last error lines", async () => {
  const { app } = await mountServices({ stack: stackMsg({ state: "down" }) });
  push(app, record({ running: false, ok: false, finishedAt: 2, rows: [{ service: "voice", state: "failed", done: 1, total: 4, cached: 1 }],
    failure: { service: "voice", lines: ["ERROR: No matching distribution found for torch==9.9.9", "ERROR: process did not complete successfully"] } }));
  const alert = within(panel()).getByRole("alert");
  assert.match(alert.textContent ?? "", /voice/);
  assert.match(alert.textContent ?? "", /No matching distribution found/);
  assert.equal(alert.querySelector("pre")?.textContent, "ERROR: No matching distribution found for torch==9.9.9\nERROR: process did not complete successfully");
  push(app, record({ running: false, ok: false, finishedAt: 2, failure: { lines: ["Error response from daemon: no space left"] } }));
  assert.match(within(panel()).getByRole("alert").textContent ?? "", /failed/i);
});

// @spec DASH-UI-057
test("the log is in a collapsed disclosure labelled with the line count, in a focusable preformatted region", async () => {
  const { app } = await mountServices({ stack: stackMsg({ state: "starting" }) });
  push(app, record({ lines: ["#1 [voice 1/2] FROM cuda", "#1 CACHED", "#2 [voice 2/2] RUN pip install"] }));
  const details = panel().querySelector("details")!;
  assert.ok(details);
  assert.equal(details.open, false);
  const summary = details.querySelector("summary")!;
  assert.match(summary.textContent ?? "", /3 lines/);
  await userEvent.setup().click(summary);
  const pre = details.querySelector("pre")!;
  assert.equal(pre.textContent, "#1 [voice 1/2] FROM cuda\n#1 CACHED\n#2 [voice 2/2] RUN pip install");
  assert.equal(pre.getAttribute("tabindex"), "0");
  assert.ok(pre.getAttribute("aria-label"));
});

// @spec DASH-UI-058
test("a container marked stale reads as from the previous run instead of its status", async () => {
  await mountServices({ services: [svc("chat")], stack: stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: 1 },
    services: [{ service: "redis", status: "exited", stale: true }, { service: "postgres", status: "exited" }] }) });
  const others = within(card()).getByRole("list", { name: "Other containers" });
  assert.match(others.textContent ?? "", /redis: from the previous run, recreated by this launch/);
  assert.ok(!/redis: exited/.test(others.textContent ?? ""));
  assert.match(others.textContent ?? "", /postgres: exited/);
});

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
