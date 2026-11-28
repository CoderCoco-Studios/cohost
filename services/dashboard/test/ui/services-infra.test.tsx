import { test } from "node:test";
import assert from "node:assert/strict";
import { screen, userEvent, waitFor, within } from "./helpers/render";
import { UNITS, mountServices, stackMsg, svc } from "./services-fixtures";
import type { StackSnapshot, UnitDescriptor } from "../../ui/src/state/types";

const table = () => screen.getByRole("table", { name: "Services" });
const rowOf = (name: string) => within(table()).getByRole("row", { name: new RegExp(`^${name}\\b`) });
const cells = (name: string) => [...rowOf(name).querySelectorAll("td")].map((c) => c.textContent ?? "");
type C = StackSnapshot["services"][number];
const MANIFEST: UnitDescriptor[] = [...UNITS, { ...UNITS[0]!, id: "ollama", infra: false }, { ...UNITS[0]!, id: "postgres", infra: true }];

// @spec DASH-UI-065
test("containers without a heartbeat row are rows of the Services table under an Infrastructure group, sorted by name, with Docker's state and n/a heartbeat cells", async () => {
  const containers: C[] = [
    { service: "chat", status: "running" },
    { service: "redis", status: "running", health: "healthy", restartCount: 2 },
    { service: "ollama", status: "running" },
    { service: "postgres", status: "running", health: "starting", restartCount: 1 },
  ];
  await mountServices({ services: [svc("chat")], stack: stackMsg({ services: containers }) });
  const rows = within(table()).getAllByRole("row").slice(1);
  const names = rows.map((r) => r.querySelector("th")?.textContent);
  assert.deepEqual(names, ["chat", "Infrastructure", "ollama", "postgres", "redis"], "the heartbeat rows, the group heading, then the containers by name");
  const heading = rows[1]!.querySelector("th")!;
  assert.equal(heading.getAttribute("scope"), "colgroup");
  assert.match(cells("redis")[0]!, /running, healthy/);
  assert.match(cells("postgres")[0]!, /running, starting/);
  assert.equal(cells("redis")[1], "n/a — container only");
  assert.match(cells("redis")[2]!, /^n\/a — container only/);
  assert.equal(rowOf("redis").querySelector(".svc-restarts")?.textContent, "2 restarts");
  assert.equal(rowOf("ollama").querySelector(".svc-restarts")?.textContent, "", "no count, the line is kept empty");
  assert.equal(within(screen.getByRole("region", { name: "Stack" })).queryByRole("list", { name: "Other containers" }), null, "the card lists no containers");
});

// @spec DASH-UI-065
test("the table shows the Infrastructure group even before any service has sent a heartbeat", async () => {
  await mountServices({ services: [], stack: stackMsg({ services: [{ service: "redis", status: "running" }] }) });
  assert.match(cells("redis")[0]!, /running/);
});

// @spec DASH-UI-066
test("an exited one-shot reads completed on exit 0, failed with its code otherwise, and exited without a code", async () => {
  await mountServices({ services: [svc("chat")], stack: stackMsg({ services: [
    { service: "models", status: "exited", oneShot: true, exitCode: 0 },
    { service: "reembed", status: "exited", oneShot: true, exitCode: 2 },
    { service: "consolidate", status: "exited", oneShot: true },
    { service: "ollama", status: "exited" },
  ] }) });
  assert.match(cells("models")[0]!, /^completed$/);
  assert.match(cells("reembed")[0]!, /^failed \(exit 2\)$/);
  assert.match(cells("consolidate")[0]!, /^exited$/);
  assert.match(cells("ollama")[0]!, /^exited$/);
  assert.ok(rowOf("models").querySelector(".st-ok"), "completed is an ok status");
  assert.ok(rowOf("reembed").querySelector(".st-bad"), "a failed one-shot is a bad status");
});

// @spec DASH-UI-058
test("a stale container's row reads as from the previous run in its why cell, recreated by this launch or this rebuild", async () => {
  const { app } = await mountServices({ services: [svc("chat")], stack: stackMsg({ state: "starting", action: { kind: "launch", phase: "compose-build", startedAt: 1 },
    services: [{ service: "redis", status: "exited", stale: true }, { service: "postgres", status: "exited" }] }) });
  assert.equal(cells("redis")[1], "from the previous run, recreated by this launch");
  assert.equal(cells("postgres")[1], "n/a — container only");
  const { act } = await import("./helpers/render");
  act(() => app.socket().message({ type: "stack", ...stackMsg({ state: "starting", action: { kind: "rebuild", phase: "compose-build", startedAt: 1 }, services: [{ service: "redis", status: "exited", stale: true }] }) }));
  assert.equal(cells("redis")[1], "from the previous run, recreated by this rebuild");
});

// @spec DASH-UI-067
test("an infrastructure unit has Restart, Redis and Postgres only with advanced control; a non-unit container has no action", async () => {
  const containers: C[] = [{ service: "ollama", status: "running" }, { service: "redis", status: "running" }, { service: "models", status: "exited", oneShot: true, exitCode: 0 }];
  const a = await mountServices({ manifest: MANIFEST, services: [svc("chat")], stack: stackMsg({ services: containers }) });
  assert.ok(within(rowOf("ollama")).getByRole("button", { name: "Restart ollama" }));
  assert.equal(within(rowOf("redis")).queryByRole("button"), null, "redis needs CONTROL_ADVANCED");
  assert.equal(within(rowOf("models")).queryByRole("button"), null, "models is not a unit");
  a.unmount();
  await mountServices({ manifest: MANIFEST, control: { runtime: "compose", advanced: true, unlocked: false }, services: [svc("chat")], stack: stackMsg({ services: containers }) });
  assert.ok(within(rowOf("redis")).getByRole("button", { name: "Restart redis" }));
  assert.deepEqual(within(rowOf("ollama")).getAllByRole("button").map((b) => b.textContent), ["Restart"], "Restart only");
});

// @spec DASH-UI-067
test("Restart asks first, then posts the unit's restart with no body and reports the outcome in the row", async () => {
  const { app } = await mountServices({ manifest: MANIFEST, services: [svc("chat")], stack: stackMsg({ services: [{ service: "ollama", status: "running" }] }) });
  app.fetch.on("POST /services/ollama/restart", { json: { ok: true } });
  const user = userEvent.setup();
  await user.click(within(rowOf("ollama")).getByRole("button", { name: "Restart ollama" }));
  const dlg = screen.getByRole("dialog", { name: "Restart ollama?" });
  assert.equal(app.fetch.callsTo("POST /services/ollama/restart").length, 0);
  await user.click(within(dlg).getByRole("button", { name: "Restart ollama" }));
  await waitFor(() => assert.equal(app.fetch.callsTo("POST /services/ollama/restart").length, 1));
  assert.ok(!app.fetch.callsTo("POST /services/ollama/restart")[0]!.body, "no body");
  assert.ok((await within(rowOf("ollama")).findByText(/Restarted ollama/)) !== null);
});

// @spec DASH-UI-067
test("an infrastructure Restart is refused with the reason while a stack action runs", async () => {
  await mountServices({ manifest: MANIFEST, services: [svc("chat")], stack: stackMsg({ state: "starting", action: { kind: "launch", phase: "waiting", startedAt: 1 }, services: [{ service: "ollama", status: "running" }] }) });
  await userEvent.setup().click(within(rowOf("ollama")).getByRole("button", { name: "Restart ollama" }));
  const dlg = screen.getByRole("dialog", { name: "Restart ollama?" });
  assert.equal((within(dlg).getByRole("button", { name: "Restart ollama" }) as HTMLButtonElement).disabled, true);
  assert.match(dlg.textContent ?? "", /A stack action is running\./);
});
