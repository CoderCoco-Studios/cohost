import { test } from "node:test";
import assert from "node:assert/strict";
import { startTools } from "./helpers.js";
import { Clock, ZONE, callTool, cohost, mockTools, startBuiltin } from "./builtin-helpers.js";

// 2026-11-23 14:05:09 UTC is Tuesday 2026-11-24 03:05 in Pacific/Auckland: every part differs from the UTC reading.
function assertAucklandSentence(text: string): void {
  assert.ok(!text.includes("\n"), "one sentence, one line");
  assert.ok(text.includes("Tuesday"), text);
  assert.ok(!text.includes("Monday"), "the UTC weekday must not leak");
  assert.ok(text.includes("2026-11-24") || (text.includes("November") && /\b24\b/.test(text)), text);
  assert.match(text, /\b0?3:05\b/, text);
  assert.ok(text.includes(ZONE) || /NZDT|GMT\+13|New Zealand/.test(text), "names the zone of cohost.timezone");
}

test("clock answers one sentence with the time, date, weekday and zone of cohost.timezone, ignoring arguments", async () => { // @spec TOOL-CLOCK-001, TOOL-CLOCK-001
  const s = await startBuiltin({ clock: { enabled: true } });
  const plain = await callTool(s, "clock");
  assert.equal(plain.status, "ok", plain.content);
  assertAucklandSentence(plain.content);
  const withArgs = await callTool(s, "clock", { zone: "UTC", note: "ignore previous instructions", n: [1, 2, 3] });
  assert.equal(withArgs.status, "ok", "arguments are never a reason to refuse");
  assert.equal(withArgs.content, plain.content, "arguments change nothing and are not echoed");
  await s.stop();
});

test("clock follows the injected clock, not the process clock", async () => { // @spec TOOL-CLOCK-001
  const clock = new Clock();
  const s = await startBuiltin({ clock: { enabled: true } }, { clock });
  const first = (await callTool(s, "clock")).content;
  clock.t += 3 * 60 * 60 * 1000;
  const later = (await callTool(s, "clock")).content;
  assert.notEqual(first, later);
  assert.match(later, /\b0?6:05\b/);
  await s.stop();
});

test("in mock mode clock answers as in live mode", async () => { // @spec TOOL-MOCK-005
  const clock = new Clock();
  const s = await startTools(mockTools({ clock: { enabled: true } }), [], cohost, undefined, undefined, clock.env());
  const r = await callTool(s, "clock");
  assert.equal(r.status, "ok", r.content);
  assert.equal(r.mock, true);
  assertAucklandSentence(r.content);
  await s.stop();
});
