import { test } from "node:test";
import assert from "node:assert/strict";
import { startTools } from "./helpers.js";
import { Clock, MIN, NOW, OrderedBus, callTool, cohost, mockTools, startBuiltin, waitFor } from "./builtin-helpers.js";

const allow = { timer: { enabled: true, acts: true } };
const stored = (s: { bus: { timers: Map<string, string> } }) => [...s.bus.timers].map(([id, json]) => ({ id, ...(JSON.parse(json) as object) })) as { id: string; note: string; setAt: number; dueAt: number }[];
const fired = (s: { bus: { of: (t: "tool.timer") => unknown[] } }) => s.bus.of("tool.timer") as { id: string; note: string; setAt: number; dueAt: number; missed?: true }[];
const set = (s: Awaited<ReturnType<typeof startBuiltin>>, minutes: number, note = "stretch") => callTool(s, "timer", { minutes, note });

test("timer takes an integer minutes from 1 to tools.timer.max_minutes (default 120) and a required text note cut to 200 characters", async () => { // @spec TOOL-TIMER-001, TOOL-TIMER-001
  const s = await startBuiltin(allow);
  for (const minutes of [1, 120]) assert.equal((await set(s, minutes, `n${minutes}`)).status, "ok", String(minutes));
  const long = await set(s, 5, "a".repeat(300));
  assert.equal(long.status, "ok");
  assert.equal(stored(s).find((t) => t.note.startsWith("aaa"))!.note.length, 200);
  await s.stop();
  const small = await startBuiltin(allow, { tools: { timer: { max_minutes: 10 } } });
  assert.equal((await set(small, 10)).status, "ok");
  assert.equal((await set(small, 11)).reason, "invalid_arguments", "the bound is the setting");
  await small.stop();
});

test("a minutes that is not an integer in range, or a note that is missing, not text or blank, is refused as invalid_arguments and starts nothing", async () => { // @spec TOOL-TIMER-002
  const s = await startBuiltin(allow);
  const bad: Record<string, unknown>[] = [
    { minutes: 0, note: "x" }, { minutes: -5, note: "x" }, { minutes: 121, note: "x" }, { minutes: 1.5, note: "x" },
    { minutes: "5", note: "x" }, { minutes: null, note: "x" }, { minutes: true, note: "x" }, { minutes: 1e9, note: "x" }, { note: "x" },
    { minutes: 5 }, { minutes: 5, note: "" }, { minutes: 5, note: "   \n\t " }, { minutes: 5, note: 42 }, { minutes: 5, note: null }, { minutes: 5, note: ["x"] },
  ];
  for (const args of bad) {
    const r = await callTool(s, "timer", args);
    assert.equal(r.status, "refused", JSON.stringify(args));
    assert.equal(r.reason, "invalid_arguments", JSON.stringify(args));
  }
  assert.equal(s.bus.timers.size, 0);
  assert.equal(s.clock.longer(9000).length, 0, "nothing was scheduled");
  await s.stop();
});

test("the answer is a sentence stating when the timer will fire, in cohost.timezone", async () => { // @spec TOOL-TIMER-003
  const s = await startBuiltin(allow);
  const r = await set(s, 10);
  assert.equal(r.status, "ok", r.content);
  assert.match(r.content, /\b0?3:15\b/, "now is 03:05 in Pacific/Auckland, so the timer fires at 03:15");
  assert.doesNotMatch(r.content, /\b14:15\b/, "not the UTC reading");
  await s.stop();
});

test("while tools.timer.max_active timers are pending a further call ends error with reason limit, and a timer that ran out frees a place", async () => { // @spec TOOL-TIMER-004
  const s = await startBuiltin(allow, { tools: { timer: { max_active: 2 } } });
  await set(s, 5, "one");
  await set(s, 6, "two");
  const over = await set(s, 7, "three");
  assert.equal(over.status, "error");
  assert.equal(over.reason, "limit");
  assert.equal(stored(s).length, 2, "the refused timer is not stored");
  assert.equal(s.clock.longer(9000).length, 2, "nor scheduled");
  s.clock.run(s.clock.longer(9000)[0]!);
  await waitFor(() => fired(s).length === 1, "first timer fired");
  await waitFor(() => stored(s).length === 1, "and deleted");
  assert.equal((await set(s, 7, "four")).status, "ok");
  await s.stop();
});

test("pending timers count against the limit after a restart too", async () => { // @spec TOOL-TIMER-004, TOOL-TIMER-007
  const bus = new OrderedBus();
  bus.timers.set("old-1", JSON.stringify({ id: "old-1", note: "a", setAt: NOW - MIN, dueAt: NOW + 30 * MIN }));
  const s = await startBuiltin(allow, { bus, tools: { timer: { max_active: 1 } } });
  await waitFor(() => bus.calls.includes("listTimers"), "timers read at start");
  assert.equal((await set(s, 5)).reason, "limit");
  await s.stop();
});

test("a timer started in live mode is stored under its id as JSON with exactly id, note, setAt and dueAt", async () => { // @spec TOOL-TIMER-005
  const s = await startBuiltin(allow);
  const r = await set(s, 10, "check the oven");
  assert.equal(r.status, "ok");
  assert.equal(s.bus.timers.size, 1);
  const [[field, json]] = [...s.bus.timers];
  const body = JSON.parse(json!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ["dueAt", "id", "note", "setAt"]);
  assert.equal(body.id, field, "the field is the timer's id");
  assert.equal(body.note, "check the oven");
  assert.equal(body.setAt, NOW);
  assert.equal(body.dueAt, NOW + 10 * MIN);
  assert.notEqual(body.id, r.id, "its own id, not the request's");
  await s.stop();
});

test("when a timer runs out the service publishes tool.timer with id, note, setAt and dueAt, and then deletes the field", async () => { // @spec TOOL-TIMER-006
  const bus = new OrderedBus();
  const s = await startBuiltin(allow, { bus });
  await set(s, 10, "tea is ready");
  const [t] = stored(s);
  const wait = s.clock.longer(9000);
  assert.equal(wait.length, 1);
  assert.equal(wait[0]!.ms, 10 * MIN, "scheduled for the minutes asked");
  assert.equal(fired(s).length, 0, "not before it is due");
  s.clock.run(wait[0]!);
  await waitFor(() => bus.timers.size === 0, "field deleted");
  assert.deepEqual(fired(s), [{ id: t!.id, note: "tea is ready", setAt: NOW, dueAt: NOW + 10 * MIN }], "no missed flag, nothing else");
  const order = bus.calls.filter((c) => c === "publish:tool.timer" || c === "deleteTimer");
  assert.deepEqual(order, ["publish:tool.timer", "deleteTimer"], "published first, then deleted");
  assert.equal(s.results().filter((r) => r.tool === "timer").length, 1, "the fire is no tool.result");
  await s.stop();
});

test("a delay longer than a platform timer can hold is never scheduled as one that fires at once", async () => { // @spec TOOL-TIMER-001, TOOL-TIMER-006, TOOL-TIMER-010
  const s = await startBuiltin(allow, { tools: { timer: { max_minutes: 200_000 } } });
  const r = await set(s, 100_000, "very long");
  assert.equal(r.status, "ok", r.content);
  for (const it of s.clock.active()) assert.ok(it.ms <= 2 ** 31 - 1, `a wait of ${it.ms} ms overflows setTimeout and would fire at once`);
  assert.equal(fired(s).length, 0);
  await s.stop();
});

test("when the service starts it fires each due timer at once, oldest dueAt first and however late, deletes it, and keeps the others until due", async () => { // @spec TOOL-TIMER-007, TOOL-TIMER-007
  const bus = new OrderedBus();
  const put = (id: string, dueAt: number, note = id) => bus.timers.set(id, JSON.stringify({ id, note, setAt: dueAt - MIN, dueAt }));
  put("late", NOW - 3 * 24 * 60 * MIN); // days late: still fired, never marked missed here
  put("recent", NOW - 5 * MIN);
  put("older", NOW - 60 * MIN);
  put("future", NOW + 20 * MIN);
  const s = await startBuiltin(allow, { bus });
  await waitFor(() => fired(s).length === 3, "due timers fired at start");
  assert.deepEqual(fired(s).map((t) => t.id), ["late", "older", "recent"], "oldest dueAt first");
  assert.ok(fired(s).every((t) => t.missed === undefined));
  await waitFor(() => bus.timers.size === 1, "due timers deleted");
  assert.deepEqual([...bus.timers.keys()], ["future"]);
  const wait = s.clock.longer(9000);
  assert.equal(wait.length, 1);
  assert.equal(wait[0]!.ms, 20 * MIN, "the rest wait for their own dueAt");
  s.clock.run(wait[0]!);
  await waitFor(() => fired(s).length === 4, "future timer fired when due");
  assert.equal(fired(s)[3]!.id, "future");
  await waitFor(() => bus.timers.size === 0, "and deleted");
  await s.stop();
});

test("an entry of the hash that is not a timer is skipped without stopping the others", async () => { // @spec TOOL-TIMER-007, TOOL-TIMER-007
  const bus = new OrderedBus();
  bus.timers.set("junk-1", "not json at all");
  bus.timers.set("junk-2", JSON.stringify({ id: "junk-2", note: 5, setAt: "x", dueAt: null }));
  bus.timers.set("junk-3", JSON.stringify({ id: "junk-3", dueAt: NOW - 1 }));
  bus.timers.set("good", JSON.stringify({ id: "good", note: "real", setAt: NOW - MIN, dueAt: NOW - 1 }));
  const s = await startBuiltin(allow, { bus });
  await waitFor(() => fired(s).some((t) => t.id === "good"), "the valid timer fired");
  assert.deepEqual(fired(s).map((t) => t.id), ["good"]);
  assert.equal(s.exits.length, 0, "the service stays up");
  await s.stop();
});

test("when the service stops its waits are cancelled and its pending timers stay in Redis unfired", async () => { // @spec TOOL-SVC-008, TOOL-TIMER-005
  const s = await startBuiltin(allow);
  await set(s, 5, "a");
  await set(s, 50, "b");
  assert.equal(s.clock.longer(9000).length, 2);
  await s.stop();
  assert.equal(s.clock.longer(9000).length, 0, "every timer wait is cancelled");
  for (const it of s.clock.items) s.clock.run(it, 0);
  assert.equal(fired(s).length, 0);
  assert.equal(s.bus.timers.size, 2, "both stay in the hash for the next start");
});

test("no tool cancels or lists timers", async () => { // @spec TOOL-TIMER-008
  const s = await startBuiltin({ ...allow, clock: { enabled: true } });
  await waitFor(() => s.catalogs().length > 0, "catalog");
  const names = s.catalogs().at(-1)!.tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /cancel|list|clear|delete|remove/.test(n)), []);
  assert.deepEqual(Object.keys(s.entry("timer").parameters.properties ?? {}).sort(), ["minutes", "note"], "no action argument either");
  await s.stop();
});

test("in mock mode timers live in the service's memory, touch no Redis key, and still publish tool.timer when due", async () => { // @spec TOOL-MOCK-006, TOOL-MOCK-001
  const clock = new Clock();
  const bus = new OrderedBus();
  bus.timers.set("redis-1", JSON.stringify({ id: "redis-1", note: "not mine", setAt: NOW - MIN, dueAt: NOW - 1 }));
  const s = await startTools(mockTools(allow, { timer: { max_active: 1 } }), [], cohost, bus, undefined, clock.env());
  const r = await callTool(s, "timer", { minutes: 3, note: "mock reminder" });
  assert.equal(r.status, "ok", r.content);
  assert.equal(r.mock, true);
  assert.equal((await callTool(s, "timer", { minutes: 3, note: "second" })).reason, "limit", "the limit applies in mock mode");
  assert.equal((await callTool(s, "timer", { minutes: 0, note: "x" })).reason, "invalid_arguments");
  assert.deepEqual(bus.calls.filter((c) => c.endsWith("Timer")), [], "no hash call at all");
  assert.equal(bus.timers.size, 1, "the hash is neither read nor written");
  const wait = clock.longer(9000);
  assert.equal(wait.length, 1);
  assert.equal(wait[0]!.ms, 3 * MIN);
  clock.run(wait[0]!);
  await waitFor(() => fired(s).length === 1, "mock timer fired");
  assert.equal(fired(s)[0]!.note, "mock reminder");
  assert.equal(fired(s)[0]!.dueAt, NOW + 3 * MIN);
  assert.deepEqual(bus.calls.filter((c) => c.endsWith("Timer")), []);
  await s.stop();
});

test("a timer whose tool.timer cannot be published stays stored and fires at the next start, with no retry while the service is up", async () => { // @spec TOOL-TIMER-009
  const bus = new OrderedBus();
  const publish = bus.publish.bind(bus);
  let failing = true;
  bus.publish = (async (type: never, data: never) => {
    if (type === "tool.timer" && failing) throw new Error("bus down");
    return publish(type, data);
  }) as typeof bus.publish;
  const clock = new Clock();
  const s = await startBuiltin(allow, { bus, clock });
  await set(s, 5, "keep me");
  clock.run(clock.longer(9000)[0]!);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired(s).length, 0, "nothing was published");
  assert.equal(bus.timers.size, 1, "the field stays stored");
  assert.equal(clock.active().length, 0, "no retry is armed while the service is up");
  await s.stop();

  failing = false;
  const next = new Clock();
  next.t = NOW + 6 * MIN;
  const restarted = await startBuiltin(allow, { bus, clock: next });
  await waitFor(() => fired(restarted).length === 1, "fired at the next start");
  assert.equal(fired(restarted)[0]!.note, "keep me");
  await waitFor(() => bus.timers.size === 0, "and deleted");
  await restarted.stop();
});

test("a delay longer than one timer can wait is armed in steps: the first step publishes nothing and the last fires once at dueAt", async () => { // @spec TOOL-TIMER-010
  const s = await startBuiltin(allow, { tools: { timer: { max_minutes: 200_000 } } });
  await set(s, 100_000, "long");
  const dueAt = NOW + 100_000 * MIN;
  let step = s.clock.longer(9000)[0]!;
  assert.equal(step.ms, 2 ** 31 - 1, "the first step is the largest delay");
  for (;;) {
    assert.ok(step.ms <= 2 ** 31 - 1, `a wait of ${step.ms} ms overflows setTimeout`);
    if (step.ms < 2 ** 31 - 1) break;
    s.clock.run(step);
    assert.equal(fired(s).length, 0, "no fire before dueAt");
    step = s.clock.longer(9000)[0]!;
  }
  assert.equal(step.ms, dueAt - s.clock.t, "the last step waits for dueAt");
  s.clock.run(step);
  await waitFor(() => fired(s).length === 1, "fired at dueAt");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fired(s).length, 1, "exactly one fire");
  assert.equal(fired(s)[0]!.dueAt, dueAt);
  await s.stop();
});

test("a due time no Date can show is refused as invalid_arguments before anything is stored; the largest one that fits is set", async () => { // @spec TOOL-TIMER-010
  const bus = new OrderedBus();
  const s = await startBuiltin(allow, { bus, tools: { timer: { max_minutes: 200_000_000_000 } } });
  const limit = Math.floor((8.64e15 - NOW) / MIN);
  const ok = await set(s, limit, "last one");
  assert.equal(ok.status, "ok", ok.content);
  const bad = await set(s, limit + 1, "too late");
  assert.equal(bad.status, "refused");
  assert.equal(bad.reason, "invalid_arguments");
  assert.equal(stored(s).length, 1, "the refused timer is not stored");
  assert.equal(s.clock.longer(9000).length, 1, "nor armed");
  await s.stop();
});

test("a timer call that arrives before the stored timers are read counts them toward max_active", async () => { // @spec TOOL-TIMER-004, TOOL-TIMER-007
  const bus = new OrderedBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  bus.timers.set("stored", JSON.stringify({ id: "stored", note: "a", setAt: NOW, dueAt: NOW + 30 * MIN }));
  const listed = bus.listTimers.bind(bus);
  bus.listTimers = async () => { await gate; return listed(); };
  const s = await startBuiltin(allow, { bus, tools: { timer: { max_active: 1 } } });
  const pending = callTool(s, "timer", { minutes: 5, note: "early" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.results().some((r) => r.tool === "timer"), false, "the call waits for the read");
  release();
  assert.equal((await pending).reason, "limit");
  await s.stop();
});

test("a stored field whose id is not the field is skipped and does not fire", async () => { // @spec TOOL-TIMER-007
  const bus = new OrderedBus();
  bus.timers.set("field-a", JSON.stringify({ id: "field-b", note: "wrong", setAt: NOW - MIN, dueAt: NOW - 1 }));
  const s = await startBuiltin(allow, { bus });
  await waitFor(() => bus.calls.includes("listTimers"), "read at start");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired(s).length, 0);
  assert.equal(bus.timers.has("field-a"), true, "skipped, left stored");
  await s.stop();
});

test("a timer call the pipeline ends while the stored timers are still being read sets nothing, even after the read completes", async () => { // @spec TOOL-TIMER-004, TOOL-CALL-010
  const bus = new OrderedBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const listed = bus.listTimers.bind(bus);
  bus.listTimers = async () => { await gate; return listed(); };
  const s = await startBuiltin(allow, { bus, tools: { timeout_ms: 20 } });
  const id = await s.request({ tool: "timer", arguments: { minutes: 5, note: "ghost" } });
  await waitFor(() => s.results().some((r) => r.id === id), "timeout result");
  assert.equal(s.results().find((r) => r.id === id)!.status, "timeout");
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bus.calls.includes("putTimer"), false, "nothing was stored");
  assert.equal(bus.timers.size, 0);
  assert.equal(s.clock.longer(9000).length, 0, "nothing was armed");
  await s.stop();
});

test("a timer call waiting for the stored timers sets nothing when the service stops first", async () => { // @spec TOOL-SVC-008, TOOL-TIMER-004
  const bus = new OrderedBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const listed = bus.listTimers.bind(bus);
  bus.listTimers = async () => { await gate; return listed(); };
  const s = await startBuiltin(allow, { bus });
  await s.request({ tool: "timer", arguments: { minutes: 5, note: "stopped" } });
  await new Promise((r) => setTimeout(r, 10));
  await s.stop();
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(bus.timers.size, 0, "nothing was stored");
  assert.equal(s.clock.longer(9000).length, 0, "nothing was armed");
});

test("a due time the clock pushes past the largest Date while the call waits is refused, and nothing is stored", async () => { // @spec TOOL-TIMER-010
  const bus = new OrderedBus();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const listed = bus.listTimers.bind(bus);
  bus.listTimers = async () => { await gate; return listed(); };
  const clock = new Clock();
  clock.t = 8.64e15 - 5 * MIN;
  const s = await startBuiltin(allow, { bus, clock, tools: { timer: { max_minutes: 200_000_000_000 } } });
  const pending = callTool(s, "timer", { minutes: 5, note: "edge" });
  await new Promise((r) => setTimeout(r, 10));
  clock.t += MIN;
  release();
  const r = await pending;
  assert.equal(r.status, "error", r.content);
  assert.equal(bus.timers.size, 0);
  assert.equal(clock.longer(9000).length, 0);
  await s.stop();
});
