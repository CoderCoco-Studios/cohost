import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { startIdle } from "../src/index.js";

function fakes() {
  const calls: string[] = [];
  const lines: { level: string; msg: string }[] = [];
  const log = {
    warn: (m: string) => lines.push({ level: "warn", msg: m }),
    error: (m: string) => lines.push({ level: "error", msg: m }),
  };
  const heartbeat = {
    ready: () => calls.push("ready"),
    degraded: (d?: string) => calls.push(`degraded:${d}`),
    setMode: (m?: string) => calls.push(`mode:${m}`),
  };
  return { calls, lines, log: log as never, heartbeat: heartbeat as never };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// @spec SHARED-IDLE-001
test("an off plan warns once with the reason, sets mode off, is ready and never reminds", async () => {
  const f = fakes();
  const idle = startIdle({ ...f, kind: "off", reason: "vision.enabled is false", warnEveryMs: 10 });
  try {
    await sleep(60);
    assert.deepEqual(f.lines, [{ level: "warn", msg: "vision.enabled is false" }]);
    assert.deepEqual(f.calls, ["mode:off", "ready"]);
  } finally { idle.stop(); }
});

// @spec SHARED-IDLE-002
test("a degraded plan logs one error with the reason and reports degraded(reason)", () => {
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "DISCORD_TOKEN is not set", warnEveryMs: 60_000 });
  try {
    assert.deepEqual(f.lines, [{ level: "error", msg: "DISCORD_TOKEN is not set" }]);
    assert.deepEqual(f.calls, ["degraded:DISCORD_TOKEN is not set"]);
  } finally { idle.stop(); }
});

// @spec SHARED-IDLE-003, SHARED-IDLE-004
test("a degraded plan reminds every warnEveryMs until stop(), and a second stop does nothing", async () => {
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "TWITCH_CHANNEL is not set", warnEveryMs: 20 });
  try {
    await sleep(110);
    const reminders = f.lines.filter((l) => l.level === "warn");
    assert.ok(reminders.length >= 2, `got ${reminders.length}`);
    assert.ok(reminders.every((l) => l.msg === "TWITCH_CHANNEL is not set; still idle"));
    idle.stop();
    const n = f.lines.length;
    idle.stop();
    await sleep(60);
    assert.equal(f.lines.length, n, "no reminder after stop");
  } finally { idle.stop(); }
});

// @spec SHARED-IDLE-003
test("reminders come after warnEveryMs and then after a doubling delay: 60 s, 120 s, 240 s", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "r" });
  try {
    const warns = () => f.lines.filter((l) => l.level === "warn").length;
    mock.timers.tick(59_999);
    assert.equal(warns(), 0, "nothing before 60 s");
    mock.timers.tick(1);
    assert.equal(warns(), 1, "first at 60 s");
    mock.timers.tick(119_999);
    assert.equal(warns(), 1, "second waits 120 s");
    mock.timers.tick(1);
    assert.equal(warns(), 2);
    mock.timers.tick(239_999);
    assert.equal(warns(), 2, "third waits 240 s");
    mock.timers.tick(1);
    assert.equal(warns(), 3);
  } finally { idle.stop(); mock.timers.reset(); }
});

// @spec SHARED-IDLE-006
test("the delay stops doubling at maxWarnEveryMs (one hour by default), which bounds the rate", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "r" });
  try {
    const warns = () => f.lines.filter((l) => l.level === "warn").length;
    // Waits 60, 120, ..., 1920 s fire six reminders; the next doubled wait (3840 s) is clamped to 3600 s.
    // A reminder re-arms its timer only after it fires, so each wait is ticked on its own.
    for (const s of [60, 120, 240, 480, 960, 1920]) mock.timers.tick(s * 1000);
    assert.equal(warns(), 6);
    mock.timers.tick(3_599_999);
    assert.equal(warns(), 6, "clamped to one hour");
    mock.timers.tick(1);
    assert.equal(warns(), 7);
    mock.timers.tick(3_600_000);
    assert.equal(warns(), 8, "and stays at one hour");
    idle.stop();
    mock.timers.tick(10 * 3_600_000);
    assert.equal(warns(), 8, "stop() cancels the pending reminder");
  } finally { idle.stop(); mock.timers.reset(); }
});

// @spec SHARED-IDLE-006
test("maxWarnEveryMs overrides the cap", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "r", warnEveryMs: 10, maxWarnEveryMs: 25 });
  try {
    for (const ms of [10, 20, 25, 25]) mock.timers.tick(ms);
    assert.equal(f.lines.filter((l) => l.level === "warn").length, 4);
  } finally { idle.stop(); mock.timers.reset(); }
});

// @spec SHARED-IDLE-003
test("the reminder interval defaults to 60000 ms", async () => {
  const f = fakes();
  const idle = startIdle({ ...f, kind: "degraded", reason: "r" });
  try {
    await sleep(40);
    assert.equal(f.lines.filter((l) => l.level === "warn").length, 0);
  } finally { idle.stop(); }
});

// @spec SHARED-IDLE-005
test("the idle plan needs only a heartbeat and a logger: it has no bus", () => {
  const f = fakes();
  const idle = startIdle({ ...f, kind: "off", reason: "r" });
  try { assert.deepEqual(Object.keys(idle), ["stop"]); } finally { idle.stop(); }
});
