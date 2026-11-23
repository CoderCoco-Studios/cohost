import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { createChatFilter, type ChatUserInfo } from "../src/filter.js";
import { createMessageHandler, registerUserToken, TwitchSource } from "../src/twitch.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribeInject } from "@cohost/shared";

const info: ChatUserInfo = { displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false };
const toEvent = createChatFilter(testConfig(), "twitch");

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
test("an unset or blank refresh token rejects naming chat.twitch.refresh_token before any registration", async () => {
  let calls = 0;
  const provider = { addUserForToken: async () => { calls++; return "uid"; } };
  for (const refreshToken of [undefined, "", "   "]) {
    await assert.rejects(registerUserToken(provider, { accessToken: "a", refreshToken }), /chat\.twitch\.refresh_token/);
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
  await subscribeInject({ bus: bus as never, group: "chat", handler: async () => {}, log: recordingLog().log });
  assert.deepEqual(calls, ["reset:chat", "subscribe"], "the group exists before subscribe is called, and before the caller signals ready");
  assert.deepEqual(opts, { group: "chat", types: ["inject.request"], start: "latest" });
});

/** A ChatClient double that counts what the source does to it. */
function clientDouble() {
  return { connects: 0, quits: 0, onConnect() {}, onDisconnect() {}, onMessage() {}, connect() { this.connects++; }, quit() { this.quits++; } };
}
const twitchCreds = { client_id: "i", client_secret: "s", access_token: "a", refresh_token: "r" };
const quietEnv = () => ({ log: recordingLog().log, emit() {}, emitRemoval() {}, onState() {} });

// @spec CHAT-PLAN-006
test("a Twitch source stopped while it registers its token never builds or connects a client", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const built: ReturnType<typeof clientDouble>[] = [];
  const src = new TwitchSource({
    channel: "chan", twitch: twitchCreds as never, tokenPath: join(mkdtempSync(join(tmpdir(), "tw-")), "t.json"),
    createAuth: async () => { await gate; return { onRefresh() {}, addUserForToken: async () => "uid" } as never; },
    createClient: () => { const c = clientDouble(); built.push(c); return c as never; },
  });
  const started = src.start(quietEnv() as never);
  src.stop();
  release();
  await started;
  assert.equal(built.length, 0, "no client is built after stop");
});

// @spec CHAT-PLAN-006
test("a Twitch client built after a stop is quit and never connected", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const built: ReturnType<typeof clientDouble>[] = [];
  let entered = false;
  const src = new TwitchSource({
    channel: "chan", twitch: {} as never, tokenPath: join(mkdtempSync(join(tmpdir(), "tw-")), "t.json"),
    createClient: async () => { entered = true; await gate; const c = clientDouble(); built.push(c); return c as never; },
  });
  const started = src.start(quietEnv() as never);
  await waitFor(() => entered, "the client is being built");
  src.stop();
  release();
  await started;
  assert.equal(built.length, 1);
  assert.equal(built[0]!.connects, 0, "never connected");
  assert.equal(built[0]!.quits, 1, "quit once");
});
