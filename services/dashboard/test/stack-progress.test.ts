import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { recordingLog } from "@cohost/testing";
import { HealthTracker, NO_PROVISION, type ExecFile, type StackResult, type StackStatus } from "@cohost/control";
import { ObservedStackController, StackService, type StackOps, type StackProgress, type StackSnapshot } from "../src/stack.js";
import { createFeed, type FeedSocket } from "../src/feed.js";

/** A StackOps whose long actions the test releases. */
function fakeOps(initial: StackStatus) {
  let status = initial;
  let release: (r: StackResult) => void = () => {};
  const hold = () => new Promise<StackResult>((r) => { release = r; });
  const ops: StackOps = {
    status: async () => status,
    launch: async () => hold(),
    rebuild: async () => hold(),
    stopAll: async () => hold(),
    restartAll: async () => hold(),
    consolidate: async () => hold(),
  };
  return { ops, setStatus: (s: StackStatus) => { status = s; }, finish: (r: StackResult) => release(r) };
}

const up: StackStatus = { docker: { ok: true }, services: [{ service: "redis", status: "exited", exitCode: 0 }, { service: "cortex", status: "running" }] };
const restarter = { restart: async () => ({ ok: true }) };
const tick = () => new Promise<void>((r) => setImmediate(r));

function service(o: { progressMs?: number; initial?: StackStatus } = {}) {
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected", pid: 1, progressMs: o.progressMs ?? 0 });
  const f = fakeOps(o.initial ?? up);
  svc.attach(f.ops);
  return { svc, f, rec };
}

async function started(kind: "launch" | "rebuild" | "restart" | "stop" | "consolidate", o: { progressMs?: number; initial?: StackStatus } = {}) {
  const h = service(o);
  await h.svc.probe();
  const r = h.svc.request(kind, restarter);
  assert.equal(r.ok, true);
  return h;
}

const OUTPUT = [
  "#1 [voice internal] load build definition from Dockerfile",
  "#2 [voice 1/2] FROM cuda",
  "#2 CACHED",
  "#3 [voice 2/2] RUN pip install -r requirements.txt",
  "#3 0.40 Collecting torch",
];

// @spec DASH-STACK-011
test("a launch starts a new record, streams lines into it and the parser's rows, and keeps both after it finishes", async () => {
  const { svc, f } = await started("launch");
  const p0 = svc.progress()!;
  assert.equal(p0.kind, "launch");
  assert.equal(p0.running, true);
  assert.deepEqual([p0.rows, p0.lines], [[], []]);
  for (const l of OUTPUT) svc.hooks.onOutput("launch", l);
  const p1 = svc.progress()!;
  assert.deepEqual(p1.lines, OUTPUT);
  assert.equal(p1.rows.length, 1);
  assert.equal(p1.rows[0]!.service, "voice");
  assert.equal(p1.rows[0]!.state, "building");
  assert.equal(p1.rows[0]!.step, 2);
  f.finish({ ok: true });
  await tick();
  const p2 = svc.progress()!;
  assert.equal(p2.running, false);
  assert.equal(p2.ok, true);
  assert.equal(typeof p2.finishedAt, "number");
  assert.equal(p2.rows[0]!.state, "built", "a row still building reads built after an ok launch");
  assert.deepEqual(p2.lines, OUTPUT, "the lines are kept after the launch");
});

// @spec DASH-STACK-011
test("the record keeps the last 200 lines; a stop or consolidate leaves it; the next rebuild replaces it", async () => {
  const { svc, f } = await started("launch");
  for (let i = 0; i < 250; i++) svc.hooks.onOutput("launch", `line ${i}`);
  assert.equal(svc.progress()!.lines.length, 200);
  assert.equal(svc.progress()!.lines[0], "line 50");
  f.finish({ ok: true });
  await tick();
  const kept = svc.progress();
  assert.ok(svc.request("stop", restarter).ok);
  f.finish({ ok: true });
  await tick();
  assert.deepEqual(svc.progress(), kept);
  assert.ok(svc.request("rebuild", restarter).ok);
  assert.equal(svc.progress()!.kind, "rebuild");
  assert.deepEqual(svc.progress()!.lines, []);
});

// @spec DASH-STACK-012
test("each output line is logged at info as `<kind> | <line>`", async () => {
  const { svc, rec } = await started("rebuild");
  svc.hooks.onOutput("rebuild", "#3 [voice 2/2] RUN pip install");
  assert.ok(rec.msgs("info").includes("rebuild | #3 [voice 2/2] RUN pip install"));
});

// @spec DASH-STACK-013, DASH-STACK-017
test("restart-all rows come from the phases and the per-unit outcomes, with a line for each", async () => {
  const { svc, f } = await started("restart");
  svc.hooks.onPhase("restart", "restarting voice");
  assert.deepEqual(svc.progress()!.rows, [{ service: "voice", state: "restarting" }]);
  svc.hooks.onPhase("restart", "restarting chat");
  assert.deepEqual(svc.progress()!.rows, [{ service: "voice", state: "done" }, { service: "chat", state: "restarting" }]);
  f.finish({ ok: false, detail: "chat: boom", restarts: [{ id: "voice", ok: true }, { id: "chat", ok: false, detail: "boom" }] });
  await tick();
  const p = svc.progress()!;
  assert.deepEqual(p.rows, [{ service: "voice", state: "done" }, { service: "chat", state: "failed", detail: "boom" }]);
  assert.deepEqual(p.lines, ["restarting voice", "restarting chat", "voice restarted", "chat failed: boom"]);
  assert.deepEqual(p.failure, { service: "chat", lines: ["boom"] });
});

// @spec DASH-STACK-017
test("a failed launch's failure is the parser's, else the last 10 lines, else the result's detail", async () => {
  {
    const { svc, f } = await started("launch");
    for (const l of [...OUTPUT, "#3 ERROR: process did not complete successfully: exit code: 1"]) svc.hooks.onOutput("launch", l);
    f.finish({ ok: false, detail: "failed to solve" });
    await tick();
    assert.deepEqual(svc.progress()!.failure, { service: "voice", lines: ["Collecting torch", "ERROR: process did not complete successfully: exit code: 1"] });
    assert.equal(svc.progress()!.rows[0]!.state, "failed");
  }
  {
    const { svc, f } = await started("launch");
    for (let i = 0; i < 12; i++) svc.hooks.onOutput("launch", `out ${i}`);
    f.finish({ ok: false, detail: "Error response from daemon" });
    await tick();
    assert.deepEqual(svc.progress()!.failure, { lines: Array.from({ length: 10 }, (_, i) => `out ${i + 2}`) });
  }
  {
    const { svc, f } = await started("launch");
    f.finish({ ok: false, detail: "docker: command not found" });
    await tick();
    assert.deepEqual(svc.progress()!.failure, { lines: ["docker: command not found"] });
  }
});

// @spec DASH-STACK-014
test("while a launch builds, a non-running container Compose has not touched is stale; touched or waiting, it is not", async () => {
  const { svc } = await started("launch");
  const stale = (s: StackSnapshot) => s.services.filter((c) => c.stale).map((c) => c.service);
  assert.deepEqual(stale(svc.snapshot()), ["redis"]);
  assert.equal(svc.snapshot().services.find((c) => c.service === "cortex")!.stale, undefined);
  svc.hooks.onOutput("launch", " Container cohost-redis-1  Recreated");
  assert.deepEqual(stale(svc.snapshot()), []);
  const again = await started("rebuild");
  assert.deepEqual(stale(again.svc.snapshot()), ["redis"]);
  again.svc.hooks.onPhase("rebuild", "waiting");
  assert.deepEqual(stale(again.svc.snapshot()), []);
  const idle = service();
  await idle.svc.probe();
  assert.ok(idle.svc.snapshot().services.every((c) => !("stale" in c)));
});

// @spec DASH-STACK-015
test("a probe that reads restart counts changes the snapshot once, never with the plain status it reads first", async () => {
  const exec: ExecFile = async (_file, args) => {
    if (args[0] === "inspect") return { stdout: `memory 1 null\n`, stderr: "" };
    if (args.includes("-q")) return { stdout: "0123456789ab\n", stderr: "" };
    if (args.includes("ps")) return { stdout: JSON.stringify([{ ID: "0123456789ab", Service: "memory", State: "running", Health: "healthy" }]), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const rec = recordingLog();
  const svc = new StackService({ log: rec.log, bus: () => "connected", pid: 1 });
  svc.attach(new ObservedStackController({ provision: NO_PROVISION, exec, cwd: tmpdir(), env: {}, onPath: (n) => n === "docker" }, svc.hooks));
  const seen: StackSnapshot[] = [];
  svc.onChange((s) => seen.push(s));
  for (let i = 0; i < 3; i++) await svc.probe();
  assert.equal(seen.length, 1, "one change: the probes after the first find nothing new");
  assert.equal(seen[0]!.services[0]!.restartCount, 1);
});

// @spec DASH-STACK-016
test("a status without restart counts keeps each container's last count while its id is unchanged; a count never drops for the same id; a container gone from a status leaves no count", async () => {
  const { svc, f } = service({ initial: { docker: { ok: true }, services: [{ service: "memory", status: "running", id: "a1", restartCount: 2 }] } });
  await svc.probe();
  const count = () => svc.snapshot().services.find((c) => c.service === "memory")!.restartCount;
  assert.equal(count(), 2);
  f.setStatus({ docker: { ok: true }, services: [{ service: "memory", status: "running", id: "a1" }] });
  await svc.probe();
  assert.equal(count(), 2);
  f.setStatus({ docker: { ok: true }, services: [{ service: "memory", status: "running", id: "a1", restartCount: 1 }] });
  await svc.probe();
  assert.equal(count(), 2);
  f.setStatus({ docker: { ok: true }, services: [{ service: "memory", status: "running", id: "b2" }] });
  await svc.probe();
  assert.equal(count(), undefined, "a recreated container starts afresh");
  f.setStatus({ docker: { ok: true }, services: [] });
  await svc.probe();
  f.setStatus({ docker: { ok: true }, services: [{ service: "memory", status: "running", id: "a1" }] });
  await svc.probe();
  assert.equal(count(), undefined, "the count of a1 was dropped when a1 was missing from a status");
});

class Sock implements FeedSocket {
  readyState = 1;
  sent: Array<{ type: string } & Record<string, unknown>> = [];
  constructor(lan = false) { if (lan) lanSocks.add(this); }
  send(d: string) { this.sent.push(JSON.parse(d)); }
  progress() { return this.sent.filter((m) => m.type === "stack-progress") as unknown as Array<StackProgress & { type: string }>; }
}

const lanSocks = new WeakSet<FeedSocket>();
function feedFor(svc: StackService, socks: Set<Sock>) {
  const bus = { recent: async () => [], tail: async () => {}, recentHealth: async () => [], tailHealth: async () => {} };
  return createFeed({ bus: bus as never, tracker: new HealthTracker(), clients: () => socks, stack: svc, redacts: (ws) => lanSocks.has(ws) });
}

// @spec DASH-FEED-013
test("stack-progress goes to unredacted sockets on connect (after the stack snapshot) and on change, never to redacted ones", async () => {
  const { svc } = service();
  await svc.probe();
  const socks = new Set<Sock>();
  const feed = feedFor(svc, socks);
  const before = new Sock();
  await feed.onConnection(before);
  assert.equal(before.progress().length, 0, "no record yet, no message");
  const local = new Sock();
  const lan = new Sock(true);
  socks.add(local); socks.add(lan);
  assert.ok(svc.request("launch", restarter).ok);
  svc.hooks.onOutput("launch", "#2 [voice 1/2] FROM cuda");
  assert.ok(local.progress().length >= 2);
  assert.deepEqual(local.progress().at(-1)!.lines, ["#2 [voice 1/2] FROM cuda"]);
  assert.equal(lan.progress().length, 0);
  const late = new Sock();
  const lateLan = new Sock(true);
  await feed.onConnection(late);
  await feed.onConnection(lateLan);
  const types = late.sent.map((m) => m.type);
  assert.ok(types.indexOf("stack-progress") === types.indexOf("stack") + 1, "the record follows the stack snapshot");
  assert.equal(lateLan.progress().length, 0);
  feed.stop();
});

// @spec DASH-FEED-013
test("stack-progress pushes are throttled to one per 250 ms with the latest record, and the end is sent at once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { svc, f } = await started("launch", { progressMs: 250 });
  const got: StackProgress[] = [];
  svc.onProgress((p) => got.push(p));
  for (let i = 0; i < 20; i++) svc.hooks.onOutput("launch", `l${i}`);
  assert.equal(got.length, 0, "the start opened a window: the lines wait for its end");
  t.mock.timers.tick(249);
  assert.equal(got.length, 0);
  t.mock.timers.tick(1);
  assert.equal(got.length, 1, "one push for the whole window");
  assert.equal(got[0]!.lines.length, 20);
  t.mock.timers.tick(250);
  assert.equal(got.length, 1, "an unchanged record is not sent again");
  svc.hooks.onOutput("launch", "next");
  assert.equal(got.length, 2, "a change after a quiet window goes at once");
  svc.hooks.onOutput("launch", "last");
  f.finish({ ok: true });
  await tick();
  assert.equal(got.at(-1)!.running, false, "the final record is sent without waiting for the throttle");
  assert.equal(got.at(-1)!.lines.at(-1), "last");
});
