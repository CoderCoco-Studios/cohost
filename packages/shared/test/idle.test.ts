import { test } from "node:test";
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
