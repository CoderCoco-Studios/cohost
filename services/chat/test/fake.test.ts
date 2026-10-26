import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { testConfig, waitFor } from "@cohost/testing";
import { chatPlan, createChatFilter } from "../src/filter.js";
import { fakeScript, startFakeSource } from "../src/fake.js";

const cfg = testConfig({ chat: { source: "fake", ignore_users: ["nightbot"], ignore_prefixes: ["!"] } });

function run(extra: { stdin?: PassThrough & { isTTY?: boolean } } = {}) {
  const published: { user: string; text: string; platform: string; mentionsCohost: boolean }[] = [];
  const stop = startFakeSource({
    toEvent: createChatFilter(cfg),
    publish: (ev) => { published.push(ev); },
    cohostName: cfg.cohost.name,
    intervalMs: cfg.chat.fake.interval_ms,
    ...extra,
  });
  return { published, stop };
}

test("scripted: a chat.message with a synthetic user is published each interval; '!' lines are filtered", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { published, stop } = run();
    assert.equal(published.length, 0);
    mock.timers.tick(8000);
    assert.equal(published.length, 1);
    assert.match(published[0]!.user, /^fake_viewer\d$/);
    assert.equal(published[0]!.platform, "twitch");
    assert.equal(published[0]!.mentionsCohost, true);
    // Run the whole script once: the "!uptime" line is dropped by the normal filter.
    mock.timers.tick(8000 * (fakeScript("Coco").length - 1));
    assert.equal(published.length, fakeScript("Coco").length - 1);
    assert.ok(published.every((p) => !p.text.startsWith("!")));
    stop();
  } finally { mock.timers.reset(); }
});

test("stdin lines are published through the filter; a prefixed line is not", async () => {
  const stdin = new PassThrough();
  const { published, stop } = run({ stdin });
  stdin.write("hello there\n!command\n  spaced   out \n");
  await waitFor(() => published.length >= 2, "two stdin messages");
  assert.deepEqual(published.map((p) => p.text), ["hello there", "spaced out"]);
  stop();
});

test("a TTY stdin disables the script entirely", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const { published, stop } = run({ stdin });
    mock.timers.tick(100_000);
    assert.equal(published.length, 0);
    stop();
  } finally { mock.timers.reset(); }
});

test("chatPlan: fake needs no channel; twitch without a channel idles (never exits); twitch with one connects", () => {
  const plan = (over: Record<string, unknown>) => chatPlan(testConfig({ chat: over }).chat);
  assert.equal(plan({ source: "fake", twitch: { channel: "" } }), "fake");
  assert.equal(plan({ source: "twitch", twitch: { channel: "" } }), "idle");
  assert.equal(plan({ source: "twitch", twitch: { channel: "#Chan" } }), "twitch");
});
