import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent } from "@cohost/bus";
import { Context } from "../src/index.js";

const heard = (data: Record<string, unknown>) =>
  ({ id: "e1", type: "speech.heard", ts: 5000, source: "ears", data: { speaker: "Streamer", text: "hello", durationMs: 500, ...data } }) as unknown as BusEvent;

// @spec WM-PUSH-011
test("a speech context event keeps the speech.heard timing unchanged and leaves it off when there is none", () => {
  const ctx = new Context(10);
  const timing = { audioEndedAt: 4000 };
  const kept = ctx.push(heard({ timing })) as unknown as { timing?: unknown };
  assert.deepEqual(kept.timing, timing);
  const bare = ctx.push(heard({})) as unknown as Record<string, unknown>;
  assert.equal("timing" in bare, false);
});

// @spec WM-PUSH-011
test("timing is never rendered into the transcript", () => {
  const ctx = new Context(10);
  ctx.push(heard({ timing: { audioEndedAt: 4000 } }));
  const plain = new Context(10);
  plain.push(heard({}));
  assert.equal(ctx.transcript("Coco"), plain.transcript("Coco"));
  assert.doesNotMatch(ctx.transcript("Coco"), /4000|timing|audioEndedAt/);
});
