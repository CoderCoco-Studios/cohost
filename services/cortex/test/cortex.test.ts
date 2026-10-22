import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply } from "../src/prompt.js";

test("parseReply: emotion tag, gesture, stray brackets, quotes and name prefixes", () => {
  assert.deepEqual(parseReply("[happy] Hey chat!"), { text: "Hey chat!", emotion: "happy", gesture: undefined });
  assert.deepEqual(parseReply("[laugh] [gesture:wave] hi there"), { text: "hi there", emotion: "laugh", gesture: "wave" });
  assert.equal(parseReply("Coco: [smug] sure").emotion, "smug");
  assert.equal(parseReply("[smug] \"quoted\"").text, "quoted");
  assert.equal(parseReply("[smug] first line\nsecond line").text, "first line");
  assert.equal(parseReply("[bogus] whatever").emotion, "neutral");
  assert.equal(parseReply("no tag at all").emotion, "neutral");
  assert.equal(parseReply("[happy] keep [this] out").text.replace(/\s+/g, " "), "keep out");
});
