import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { recordingLog, testConfig, waitFor } from "@cohost/testing";
import { createChatFilter, type ChatUserInfo } from "../src/filter.js";
import { fakeScript, FakeSource } from "../src/fake.js";
import type { ChatSender, ChatSourceStartEnv } from "../src/source.js";

const cfg = testConfig({ chat: { sources: ["fake"], ignore_users: ["nightbot"], ignore_prefixes: ["!"] } });
const filters = { twitch: createChatFilter(cfg, "twitch"), youtube: createChatFilter(cfg, "youtube") };

/** Starts a FakeSource with an env that runs each line through the filter, as the service does. */
function run(extra: { stdin?: PassThrough & { isTTY?: boolean } } = {}) {
  const published: { user: string; text: string; platform: string; mentionsCohost: boolean; userId?: string }[] = [];
  const states: string[] = [];
  const src = new FakeSource({ cohostName: cfg.cohost.name, intervalMs: cfg.chat.fake.interval_ms, ...extra });
  const env: ChatSourceStartEnv = {
    log: recordingLog().log,
    emit: (sender: ChatSender, text: string) => {
      const platform = sender.platform ?? "twitch";
      const ev = filters[platform](sender.login, text, { displayName: sender.displayName, userId: sender.userId, isMod: sender.isMod, isBroadcaster: false, isSubscriber: sender.isSubscriber } as ChatUserInfo);
      if (ev) published.push(ev);
    },
    emitRemoval: () => {},
    onState: (state) => { states.push(state); },
  };
  const started = src.start(env);
  return { published, states, started, stop: () => src.stop() };
}

// @spec CHAT-FAKE-001, CHAT-FAKE-003
test("scripted: a chat.message with a synthetic user is published each interval; '!' lines are filtered", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const { published, stop, started } = run();
    await started;
    assert.equal(published.length, 0);
    mock.timers.tick(8000);
    assert.equal(published.length, 1);
    assert.match(published[0]!.user, /^fake_viewer\d$/);
    assert.equal(published[0]!.mentionsCohost, true);
    // Run the whole script once: the "!uptime" line is dropped by the normal filter.
    mock.timers.tick(8000 * (fakeScript("Coco").length - 1));
    assert.equal(published.length, fakeScript("Coco").length - 1);
    assert.ok(published.every((p) => !p.text.startsWith("!")));
    stop();
  } finally { mock.timers.reset(); }
});

// @spec CHAT-FAKE-002, CHAT-FAKE-003
test("stdin lines are published through the filter; a prefixed line is not", async () => {
  const stdin = new PassThrough();
  const { published, stop, started } = run({ stdin });
  await started;
  stdin.write("hello there\n!command\n  spaced   out \n");
  await waitFor(() => published.length >= 2, "two stdin messages");
  assert.deepEqual(published.map((p) => p.text), ["hello there", "spaced out"]);
  stop();
});

// @spec CHAT-FAKE-004
test("a TTY stdin disables the script entirely", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const { published, stop, started } = run({ stdin });
    await started;
    mock.timers.tick(100_000);
    assert.equal(published.length, 0);
    stop();
  } finally { mock.timers.reset(); }
});

// @spec CHAT-FAKE-005
test("once a stdin line has arrived the scripted interval does not emit", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const stdin = new PassThrough();
    const { published, stop, started } = run({ stdin });
    await started;
    mock.timers.tick(8000);
    assert.equal(published.length, 1, "the script runs until a line arrives");
    stdin.write("typed line\n");
    await waitFor(() => published.length >= 2, "the stdin line");
    mock.timers.tick(8000 * 3);
    assert.deepEqual(published.map((p) => p.text).slice(1), ["typed line"], "no scripted line after the first stdin line");
    stop();
  } finally { mock.timers.reset(); }
});

// @spec CHAT-FAKE-009
test("the fake source reports reading at once, before any line", async () => {
  const { states, stop, started } = run({ stdin: Object.assign(new PassThrough(), { isTTY: true }) });
  await started;
  assert.deepEqual(states, ["reading"]);
  stop();
});
