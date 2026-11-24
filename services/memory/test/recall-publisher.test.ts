import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, testConfig } from "@cohost/testing";
import { createMemoryHandler } from "../src/region.js";
import type { Memory } from "../src/store.js";

const heard: Memory[] = [{ ts: new Date("2026-11-23T14:05:09Z"), kind: "chat", who: "bob", text: "gg", similarity: 0.8 } as Memory];

function setup() {
  const recalls: [string, number?][] = [];
  const store = {
    touchViewer: async () => ({ msgCount: 1, isNew: false, regular: false }),
    touchSpeaker: async () => ({}) as never,
    remember: async () => {},
    forgetChat: async () => {},
    recall: async (...args: [string, number?]) => { recalls.push(args); return heard; },
  };
  const bus = new FakeBus();
  const log = { warn() {}, info() {}, error() {}, debug() {} } as never;
  const onEvent = createMemoryHandler({ cfg: testConfig(), bus, store, log });
  return { onEvent, bus, recalls };
}

// @spec MEM-RECALL-007
test("a recall request is answered the same way whichever service published it, with the request's id only", async () => {
  const { onEvent, bus, recalls } = setup();
  await onEvent(event("memory.recall.request", { id: "from-cortex", query: "good game", k: 2 }, "cortex"));
  await onEvent(event("memory.recall.request", { id: "from-tools", query: "good game", k: 2 }, "tools"));
  assert.deepEqual(recalls, [["good game", 2], ["good game", 2]], "the same store call for both publishers");
  const replies = bus.of("memory.recall.reply");
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((r) => r.id), ["from-cortex", "from-tools"]);
  const { id: _a, ...a } = replies[0]!;
  const { id: _b, ...b } = replies[1]!;
  assert.deepEqual(a, b, "the same memories whoever asked");
  for (const r of replies) assert.deepEqual(Object.keys(r).sort(), ["id", "memories"], "the id and the memories, nothing that names the requester");
});

// @spec MEM-RECALL-007
test("a recall request with no k from the tools service is answered with the default k, like one from cortex", async () => {
  const { onEvent, recalls } = setup();
  await onEvent(event("memory.recall.request", { id: "t", query: "q" }, "tools"));
  await onEvent(event("memory.recall.request", { id: "c", query: "q" }, "cortex"));
  assert.deepEqual(recalls[0], recalls[1]);
});
