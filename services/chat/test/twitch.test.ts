import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { createChatFilter, type ChatSender } from "../src/filter.js";
import { createMessageHandler, registerUserToken, TwitchSource } from "../src/twitch.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribeInject } from "@cohost/shared";

const info: ChatSender = { displayName: "Bob", login: "bob", userId: "42", isMod: false, isSub: false, ignoreIdentifiers: ["bob", "Bob"] };
const toEvent = createChatFilter(testConfig(), "twitch");

// @spec CHAT-TW-007
test("a failed chat.message publish is logged and the next message is still handled", async () => {
  const bus = new FakeBus();
  const rec = recordingLog();
  let calls = 0;
  bus.fail = () => ++calls === 1;
  const onMessage = createMessageHandler({ toEvent, bus, log: rec.log });
  await onMessage(info, "first"); // publish rejects: must not throw
  await onMessage(info, "second");
  assert.deepEqual(rec.msgs("warn"), ["chat.message publish failed"]);
  assert.deepEqual(bus.of("chat.message").map((m) => m.text), ["second"]);
});

// @spec CHAT-TW-008
test("a filtered message publishes nothing", async () => {
  const bus = new FakeBus();
  await createMessageHandler({ toEvent, bus, log: recordingLog().log })(info, "!uptime");
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

/** A ChatClient double that keeps every handler a source registers and records every method it is called with. */
function removalClient() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const calls: string[] = [];
  const known = ["onConnect", "onDisconnect", "onMessage", "onMessageRemove", "onBan", "onTimeout", "onChatClear", "connect", "quit"];
  const client = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => prop === "then" ? undefined : (...args: unknown[]) => {
      calls.push(prop);
      if (prop.startsWith("on")) handlers[prop] = args[0] as (...a: any[]) => void;
    },
  });
  return { client, handlers, calls, known };
}

/** Starts an anonymous TwitchSource on a recording client; returns what the source handed the service. */
async function startTwitch() {
  const rc = removalClient();
  const rec = recordingLog();
  const emitted: { sender: any; text: string; messageId?: string }[] = [];
  const removals: any[] = [];
  const states: [string, string | undefined][] = [];
  const src = new TwitchSource({
    channel: "chan", twitch: {} as never, tokenPath: join(mkdtempSync(join(tmpdir(), "tw-")), "t.json"),
    createClient: () => rc.client as never,
  });
  await src.start({
    log: rec.log,
    emit: (sender: any, text: string, messageId?: string) => { emitted.push({ sender, text, messageId }); },
    emitRemoval: (r: any) => { removals.push(r); },
    onState: (s: string, reason?: string) => { states.push([s, reason]); },
  } as never);
  return { ...rc, rec, emitted, removals, states, src };
}

const msgFrom = (over: Record<string, unknown> = {}, userInfo: Record<string, unknown> = {}) => ({
  id: "msg-1",
  userInfo: { userName: "bob_login", displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false, ...userInfo },
  ...over,
});

// @spec CHAT-TW-013, CHAT-FILT-012
test("a Twitch line reaches the service with its message id, the user id, and the login and display name as ignore identifiers", async () => {
  const t = await startTwitch();
  t.handlers.onMessage!("#chan", "bob_login", "hello", msgFrom({}, { isBroadcaster: true, isSubscriber: true }));
  assert.equal(t.emitted.length, 1);
  const { sender, text, messageId } = t.emitted[0]!;
  assert.equal(text, "hello");
  assert.equal(messageId, "msg-1");
  assert.equal(sender.userId, "42");
  assert.equal(sender.displayName, "Bob");
  assert.equal(sender.login, "bob_login");
  assert.equal(sender.isMod, true, "the broadcaster counts as a moderator, worked out by the source");
  assert.equal(sender.isSub, true);
  assert.deepEqual([...sender.ignoreIdentifiers].toSorted(), ["Bob", "bob_login"]);
});

// @spec CHAT-TW-004
test("on connect the Twitch source is reading and logs the channel and whether it is authenticated", async () => {
  const t = await startTwitch();
  t.handlers.onConnect!();
  assert.deepEqual(t.states.at(-1), ["reading", undefined]);
  const line = t.rec.lines.find((l) => l.level === "info" && /connected/.test(String(l.msg)));
  assert.ok(line, "an info line is logged");
  assert.deepEqual(line.obj, { channel: "chan", authenticated: false });
});

// @spec CHAT-TW-005, CHAT-TW-009
test("a disconnect makes the source retrying with a warning, and the library's reconnect returns it to reading", async () => {
  const t = await startTwitch();
  t.handlers.onConnect!();
  const reason = new Error("socket reset");
  t.handlers.onDisconnect!(false, reason);
  assert.equal(t.states.at(-1)![0], "retrying");
  const warn = t.rec.lines.find((l) => l.level === "warn" && /disconnected/.test(String(l.msg)));
  assert.deepEqual(warn?.obj, { manually: false, reason });
  t.handlers.onConnect!();
  assert.equal(t.states.at(-1)![0], "reading");
});

// @spec CHAT-SRC-001
test("the Twitch source reports starting until its client connects, then reading", async () => {
  const t = await startTwitch();
  assert.equal(t.src.state().state, "starting", "no state is reported before the client connects");
  assert.deepEqual(t.states, [], "nothing is reported on start");
  t.handlers.onConnect!();
  assert.equal(t.src.state().state, "reading");
  assert.deepEqual(t.states, [["reading", undefined]]);
});

// @spec CHAT-SRC-001
test("the Twitch source reports retrying on each disconnect and reading again on each reconnect; the library owns the backoff", async () => {
  const t = await startTwitch();
  t.handlers.onConnect!();
  for (let i = 0; i < 2; i++) {
    t.handlers.onDisconnect!(false, new Error("socket reset"));
    assert.equal(t.src.state().state, "retrying");
    t.handlers.onConnect!();
    assert.equal(t.src.state().state, "reading");
  }
  assert.deepEqual(t.states.map(([s]) => s), ["reading", "retrying", "reading", "retrying", "reading"]);
  assert.deepEqual(t.calls.filter((c) => c === "connect"), ["connect"], "the source never calls connect itself on a drop");
});

// @spec CHAT-SRC-001
test("a Twitch start rejected for a missing refresh token reports no state of its own", async () => {
  const rc = removalClient();
  const states: string[] = [];
  const src = new TwitchSource({
    channel: "chan", twitch: { client_id: "i", client_secret: "s", access_token: "a", refresh_token: " " } as never,
    tokenPath: join(mkdtempSync(join(tmpdir(), "tw-")), "t.json"),
    createAuth: () => ({ onRefresh() {}, addUserForToken: async () => "uid" }) as never,
    createClient: () => rc.client as never,
  });
  await assert.rejects(src.start({ ...quietEnv(), onState: (s: string) => { states.push(s); } } as never), /chat\.twitch\.refresh_token/);
  assert.deepEqual(states, [], "the rejection is the service's to record as stopped (CHAT-PLAN-011)");
  assert.equal(src.state().state, "starting");
});

// @spec CHAT-TW-014, CHAT-FORGET-001
test("onMessageRemove reports a message removal naming the message id", async () => {
  const t = await startTwitch();
  t.handlers.onMessageRemove!("#chan", "gone-7", {});
  assert.deepEqual(t.removals, [{ scope: "message", messageId: "gone-7" }]);
});

// @spec CHAT-TW-015, CHAT-FORGET-001
test("onBan reports a user removal with reason banned", async () => {
  const t = await startTwitch();
  t.handlers.onBan!("#chan", "troll", { targetUserId: "555" });
  assert.deepEqual(t.removals, [{ scope: "user", userId: "555", reason: "banned" }]);
});

// @spec CHAT-TW-016, CHAT-FORGET-008
test("onTimeout reports a user removal with reason timeout, as a ban does", async () => {
  const t = await startTwitch();
  t.handlers.onTimeout!("#chan", "troll", 600, { targetUserId: "555" });
  assert.deepEqual(t.removals, [{ scope: "user", userId: "555", reason: "timeout" }]);
});

// @spec CHAT-TW-017
test("onChatClear reports a removal of everything, reason cleared, naming no message or viewer", async () => {
  const t = await startTwitch();
  t.handlers.onChatClear!("#chan", {});
  assert.deepEqual(t.removals, [{ scope: "all", reason: "cleared" }]);
});

// @spec CHAT-TW-018
test("a ban or timeout with a null targetUserId reports nothing and logs a warning", async () => {
  const t = await startTwitch();
  t.handlers.onBan!("#chan", "troll", { targetUserId: null });
  assert.equal(t.removals.length, 0);
  assert.equal(t.rec.msgs("warn").length, 1);
  t.handlers.onTimeout!("#chan", "troll", 60, { targetUserId: null });
  assert.equal(t.removals.length, 0);
  assert.equal(t.rec.msgs("warn").length, 2);
});

// @spec CHAT-FORGET-007
test("the Twitch source only listens and connects: it calls no send, ban, timeout or delete on the client", async () => {
  const t = await startTwitch();
  for (const h of ["onMessageRemove", "onBan", "onTimeout", "onChatClear"]) assert.ok(t.handlers[h], `${h} is registered`);
  t.handlers.onMessageRemove!("#chan", "m", {});
  t.handlers.onBan!("#chan", "u", { targetUserId: "1" });
  t.handlers.onTimeout!("#chan", "u", 10, { targetUserId: "1" });
  t.handlers.onChatClear!("#chan", {});
  t.src.stop();
  const unexpected = t.calls.filter((c) => !t.known.includes(c));
  assert.deepEqual(unexpected, [], "no client method outside the listening and lifecycle set is called");
});
