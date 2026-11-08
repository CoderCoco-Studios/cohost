import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig } from "@cohost/testing";
import { createChatFilter, type ChatUserInfo } from "../src/filter.js";
import { createMessageHandler, registerUserToken } from "../src/twitch.js";
import { subscribeInject } from "../src/subscribe.js";

const info: ChatUserInfo = { displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false };
const toEvent = createChatFilter(testConfig());

// @spec CHAT-TW-007
test("a failed chat.message publish is logged and the next message is still handled", async () => {
  const bus = new FakeBus();
  const rec = recordingLog();
  let calls = 0;
  bus.fail = () => ++calls === 1;
  const onMessage = createMessageHandler({ toEvent, bus, log: rec.log });
  await onMessage("bob", "first", info); // publish rejects: must not throw
  await onMessage("bob", "second", info);
  assert.deepEqual(rec.msgs("warn"), ["chat.message publish failed"]);
  assert.deepEqual(bus.of("chat.message").map((m) => m.text), ["second"]);
});

// @spec CHAT-TW-008
test("a filtered message publishes nothing", async () => {
  const bus = new FakeBus();
  await createMessageHandler({ toEvent, bus, log: recordingLog().log })("bob", "!uptime", info);
  assert.equal(bus.published.length, 0);
});

// @spec CHAT-TW-006
test("the user token is registered (awaited) before registerUserToken resolves, and a rejection surfaces", async () => {
  const order: string[] = [];
  let release!: () => void;
  const provider = {
    addUserForToken: (_t: unknown, intents: string[]) => new Promise<string>((res) => {
      order.push(`add:${intents.join(",")}`);
      release = () => { order.push("registered"); res("uid"); };
    }),
  };
  const done = registerUserToken(provider, { accessToken: "a", refreshToken: "r" }).then(() => order.push("returned"));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(order, ["add:chat"], "still waiting for registration");
  release();
  await done;
  assert.deepEqual(order, ["add:chat", "registered", "returned"]);

  const failing = { addUserForToken: async () => { throw new Error("bad token"); } };
  await assert.rejects(registerUserToken(failing, { accessToken: "a", refreshToken: "r" }), /bad token/);
});

// @spec CHAT-TW-010
test("an unset or blank refresh token rejects naming TWITCH_REFRESH_TOKEN before any registration", async () => {
  let calls = 0;
  const provider = { addUserForToken: async () => { calls++; return "uid"; } };
  for (const refreshToken of [undefined, "", "   "]) {
    await assert.rejects(registerUserToken(provider, { accessToken: "a", refreshToken }), /TWITCH_REFRESH_TOKEN/);
  }
  assert.equal(calls, 0, "addUserForToken is never called");
});

// @spec CHAT-INJ-009
test("the inject subscription is created first, then subscribed with start mode latest", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeInject(bus, async () => {}, recordingLog().log);
  assert.deepEqual(calls, ["reset:chat", "subscribe"], "the group exists before subscribe is called, and before the caller signals ready");
  assert.deepEqual(opts, { group: "chat", types: ["inject.request"], start: "latest" });
});
