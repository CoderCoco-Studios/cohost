import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import { chatService, type ChatClientLike, type ChatServiceDeps } from "../src/service.js";
import { loadStoredToken, saveStoredToken } from "../src/token-store.js";

/** A bus that also answers the inject subscription calls (FakeBus only records). */
class SvcBus extends FakeBus {
  async resetGroup(): Promise<void> {}
  subscriptions: { group: string; types: string[]; start?: string }[] = [];
  async subscribe(opts: { group: string; types: string[]; start?: string }): Promise<void> { this.subscriptions.push(opts); }
  stopped = 0;
  stop(): void { this.stopped++; }
}

class FakeClient implements ChatClientLike {
  connected: (() => void)[] = [];
  disconnected: ((manually: boolean, reason?: Error) => void)[] = [];
  messages: ((chan: string, user: string, text: string, msg: { userInfo: unknown }) => void)[] = [];
  removed: ((chan: string, id: string, msg: unknown) => void)[] = [];
  banned: ((chan: string, user: string, msg: { targetUserId: string | null }) => void)[] = [];
  timedOut: ((chan: string, user: string, duration: number, msg: { targetUserId: string | null }) => void)[] = [];
  cleared: ((chan: string, msg: unknown) => void)[] = [];
  connects = 0;
  quits = 0;
  constructor(public opts: Record<string, unknown>) {}
  onMessageRemove(cb: (chan: string, id: string, msg: unknown) => void) { this.removed.push(cb); }
  onBan(cb: (chan: string, user: string, msg: { targetUserId: string | null }) => void) { this.banned.push(cb); }
  onTimeout(cb: (chan: string, user: string, duration: number, msg: { targetUserId: string | null }) => void) { this.timedOut.push(cb); }
  onChatClear(cb: (chan: string, msg: unknown) => void) { this.cleared.push(cb); }
  onConnect(cb: () => void) { this.connected.push(cb); }
  onDisconnect(cb: (manually: boolean, reason?: Error) => void) { this.disconnected.push(cb); }
  onMessage(cb: (chan: string, user: string, text: string, msg: { userInfo: unknown }) => void) { this.messages.push(cb); }
  connect() { this.connects++; }
  quit() { this.quits++; }
}

class FakeAuth {
  refresh?: (userId: string, token: Record<string, unknown>) => void;
  added: { token: Record<string, unknown>; intents: string[] }[] = [];
  onRefresh(cb: (userId: string, token: Record<string, unknown>) => void) { this.refresh = cb; }
  async addUserForToken(token: Record<string, unknown>, intents: string[]) { this.added.push({ token, intents }); return "uid"; }
}

function rig(over: Record<string, unknown> = {}, deps: Partial<ChatServiceDeps> = {}) {
  const bus = new SvcBus();
  const rec = recordingLog();
  const clients: FakeClient[] = [];
  const auths: FakeAuth[] = [];
  const exits: number[] = [];
  let shutdown: (() => void | Promise<void>) | undefined;
  let heartbeat: { stop(): Promise<void> } | undefined;
  const svc = chatService({
    createClient: (opts) => { const c = new FakeClient(opts); clients.push(c); return c; },
    createAuth: () => { const a = new FakeAuth(); auths.push(a); return a as never; },
    exit: (c) => { exits.push(c); },
    ...deps,
  });
  const cfg = testConfig(over);
  const start = () => runService({
    service: "chat", health: () => svc.health(cfg), main: async (ctx) => { heartbeat = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => cfg, createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  return { bus, rec, clients, auths, exits, start, deps: () => svc.health(cfg).deps(), stop: async () => { await shutdown?.(); await heartbeat?.stop(); } };
}

// @spec CHAT-TW-008
test("a message in the joined channel goes through the filter and is published; a filtered one is not", async () => {
  const r = rig({ chat: { twitch: { channel: "Chan" }, ignore_prefixes: ["!"] } });
  try {
    await r.start();
    const client = r.clients[0]!;
    assert.deepEqual(client.opts.channels, ["chan"], "the channel is normalised");
    const msg = { userInfo: { displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false } };
    client.messages[0]!("#chan", "bob", "hello   Coco", msg);
    client.messages[0]!("#chan", "bob", "!uptime", msg);
    await waitFor(() => r.bus.of("chat.message").length >= 1, "chat.message");
    assert.deepEqual(r.bus.of("chat.message").map((m) => m.text), ["hello Coco"]);
  } finally { await r.stop(); }
});

// @spec CHAT-TW-009, CHAT-TW-004
test("the client keeps its library reconnect, and a reconnect signals ready again", async () => {
  const r = rig();
  try {
    await r.start();
    const client = r.clients[0]!;
    assert.equal(client.connects, 1);
    assert.notEqual(client.opts.reconnect, false, "reconnect is left at the library default");
    const readyOk = () => r.bus.health.filter((h) => h.state === "ready" && h.deps?.twitch === "ok").length;
    client.connected[0]!();
    await waitFor(() => readyOk() === 1, "first ready");
    client.disconnected[0]!(false, new Error("reset"));
    assert.ok(r.rec.lines.some((l) => l.level === "warn" && l.msg === "twitch chat disconnected"));
    client.connected[0]!();
    await waitFor(() => readyOk() >= 2, "ready again");
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-003
test("no channel: one error naming chat.twitch.channel, a degraded heartbeat, then only warnings; no Twitch client is built", async () => {
  const r = rig({ chat: { twitch: { channel: "" } } }, { idleWarnEveryMs: 15 });
  try {
    await r.start();
    await waitFor(() => r.rec.msgs("warn").filter((m) => /still idle/.test(String(m))).length >= 2, "reminders");
    assert.equal(r.rec.msgs("error").length, 1, "one error, not one per reminder");
    assert.match(String(r.rec.msgs("error")[0]), /chat\.twitch\.channel/);
    assert.equal(r.clients.length, 0);
    await waitFor(() => r.bus.health.some((h) => h.state === "degraded" && /chat\.twitch\.channel/.test(h.detail ?? "")), "degraded heartbeat");
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-006
test("shutdown stops the idle reminder and the bus", async () => {
  const r = rig({ chat: { twitch: { channel: "" } } }, { idleWarnEveryMs: 10 });
  await r.start();
  await r.stop();
  const n = r.rec.msgs("warn").length;
  await new Promise((x) => setTimeout(x, 60));
  assert.equal(r.rec.msgs("warn").length, n, "no reminder after shutdown");
  assert.equal(r.bus.stopped, 1);
});

// @spec CHAT-PLAN-006, CHAT-PLAN-001
test("twitch shutdown quits the client; fake source builds no client", async () => {
  const t = rig();
  await t.start();
  await t.stop();
  assert.equal(t.clients[0]!.quits, 1);
  const f = rig({ chat: { sources: ["fake"], twitch: { channel: "" } } }, { stdin: Object.assign(new PassThrough(), { isTTY: true }) });
  try {
    await f.start();
    assert.equal(f.clients.length, 0);
    await waitFor(() => f.bus.health.some((h) => h.state === "ready" && h.mode === "mock"), "mock ready");
  } finally { await f.stop(); }
});

/** Config override carrying Twitch credentials, as `secrets.yaml` would supply them (the channel stays the test default). */
const tw = (c: Record<string, string>) => ({ chat: { twitch: c } });
const creds = { client_id: "id", client_secret: "sec", access_token: "secA", refresh_token: "secR" };
const refreshed = { accessToken: "newA", refreshToken: "newR", expiresIn: 14000, obtainmentTimestamp: 1234, scope: ["chat:read"] };

// @spec CHAT-TW-003, CHAT-TW-011
test("a refreshed token is logged with expiresIn and persisted atomically, owner-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-token-"));
  const tokenPath = join(dir, "chat", "twitch-token.json");
  const r = rig(tw(creds), { tokenPath });
  try {
    await r.start();
    r.auths[0]!.refresh!("uid", refreshed);
    const saved = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.deepEqual(saved, { ...refreshed, startingRefreshToken: "secR" });
    assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
    assert.ok(r.rec.lines.some((l) => l.msg === "twitch token refreshed" && (l.obj as { expiresIn: number }).expiresIn === 14000));
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// @spec CHAT-TW-011
test("a failed token write is logged and ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-token-"));
  writeFileSync(join(dir, "chat"), "a file where the directory should be");
  const r = rig(tw(creds), { tokenPath: join(dir, "chat", "twitch-token.json") });
  try {
    await r.start();
    r.auths[0]!.refresh!("uid", refreshed);
    assert.ok(r.rec.lines.some((l) => l.level === "warn" && /persist/.test(String(l.msg))));
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// @spec CHAT-TW-012
test("a stored token is preferred over secrets.yaml; a superseded, malformed or missing file falls back to secrets.yaml", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-token-"));
  const tokenPath = join(dir, "chat", "twitch-token.json");
  try {
    saveStoredToken(tokenPath, refreshed, "secR");
    const withStore = rig(tw(creds), { tokenPath });
    await withStore.start();
    assert.equal(withStore.auths[0]!.added[0]!.token.accessToken, "newA");
    assert.equal(withStore.auths[0]!.added[0]!.token.refreshToken, "newR");
    assert.deepEqual(withStore.auths[0]!.added[0]!.intents, ["chat"]);
    await withStore.stop();

    const superseded = rig(tw({ ...creds, refresh_token: "operatorNew" }), { tokenPath });
    await superseded.start();
    assert.equal(superseded.auths[0]!.added[0]!.token.accessToken, "secA");
    assert.equal(superseded.auths[0]!.added[0]!.token.refreshToken, "operatorNew");
    await superseded.stop();

    writeFileSync(tokenPath, "{not json");
    const malformed = rig(tw(creds), { tokenPath });
    await malformed.start();
    assert.equal(malformed.auths[0]!.added[0]!.token.accessToken, "secA");
    await malformed.stop();

    rmSync(tokenPath);
    const missing = rig(tw(creds), { tokenPath });
    await missing.start();
    assert.equal(missing.auths[0]!.added[0]!.token.accessToken, "secA");
    await missing.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// @spec CHAT-TW-012, CHAT-TW-011
test("the token store round-trips and rejects a file of the wrong shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-token-"));
  const file = join(dir, "chat", "twitch-token.json");
  try {
    assert.equal(loadStoredToken(file, "secR"), undefined);
    saveStoredToken(file, refreshed, "secR");
    assert.deepEqual(loadStoredToken(file, "secR"), refreshed);
    assert.equal(loadStoredToken(file, "other"), undefined);
    mkdirSync(join(dir, "chat"), { recursive: true });
    writeFileSync(file, JSON.stringify({ accessToken: 5 }));
    assert.equal(loadStoredToken(file, "secR"), undefined);
    assert.equal(existsSync(file + ".tmp"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// @spec CHAT-TW-010
test("a missing chat.twitch.refresh_token with the other credentials set rejects the twitch start: only that source stops, the process keeps running", async () => {
  const { refresh_token: _omit, ...partial } = creds;
  const r = rig(tw(partial));
  try {
    await r.start();
    assert.deepEqual(r.exits, []);
    assert.equal(r.clients.length, 0, "no client is built before the token is registered");
    assert.ok(r.rec.msgs("error").some((m) => /chat\.twitch\.refresh_token/.test(String(m))));
    assert.deepEqual(r.deps(), { twitch: "down", youtube: "n/a" });
  } finally { await r.stop(); }
});

const ANON_CASES: [string, Record<string, string>][] = [
  ["no credentials", {}],
  ["client id only", { client_id: "id" }],
  ["no client id", { client_secret: "sec", access_token: "secA", refresh_token: "secR" }],
  ["no client secret", { client_id: "id", access_token: "secA", refresh_token: "secR" }],
  ["no access token", { client_id: "id", client_secret: "sec", refresh_token: "secR" }],
];

// @spec CHAT-TW-001
test("anonymous: with no or partial credentials no auth provider is created and the client has none", async () => {
  for (const [label, env] of ANON_CASES) {
    const r = rig(tw(env));
    try {
      await r.start();
      assert.equal(r.auths.length, 0, `${label}: no auth provider is created`);
      assert.equal(r.clients.length, 1, `${label}: the client is still built`);
      assert.equal(r.clients[0]!.opts.authProvider, undefined, `${label}: client built without an auth provider`);
      assert.deepEqual(r.exits, [], `${label}: not fatal`);
    } finally { await r.stop(); }
  }
});

// @spec CHAT-TW-001, CHAT-PLAN-003
test("TWITCH_* variables in the process environment supply no credential and no channel", async () => {
  const names = ["TWITCH_CHANNEL", "TWITCH_CLIENT_ID", "TWITCH_CLIENT_SECRET", "TWITCH_ACCESS_TOKEN", "TWITCH_REFRESH_TOKEN"];
  const old = names.map((n) => process.env[n]);
  for (const n of names) process.env[n] = `env-${n}`;
  try {
    const anon = rig();
    try {
      await anon.start();
      assert.equal(anon.auths.length, 0, "no auth provider from the environment");
      assert.equal(anon.clients[0]!.opts.authProvider, undefined);
      assert.deepEqual(anon.clients[0]!.opts.channels, ["chan"], "the channel is the configured one");
    } finally { await anon.stop(); }
    const idle = rig({ chat: { twitch: { channel: "" } } });
    try {
      await idle.start();
      assert.equal(idle.clients.length, 0, "an environment channel does not end the idle plan");
    } finally { await idle.stop(); }
  } finally { names.forEach((n, i) => { if (old[i] === undefined) delete process.env[n]; else process.env[n] = old[i]; }); }
});

// @spec CHAT-TW-002
test("with all three credentials the auth provider holds the configured tokens for intent chat and is handed to the client", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-token-"));
  const r = rig(tw(creds), { tokenPath: join(dir, "chat", "twitch-token.json") });
  try {
    await r.start();
    assert.equal(r.auths.length, 1);
    assert.equal(r.clients[0]!.opts.authProvider, r.auths[0], "the provider is passed to the client");
    const added = r.auths[0]!.added;
    assert.equal(added.length, 1);
    assert.equal(added[0]!.token.accessToken, "secA");
    assert.equal(added[0]!.token.refreshToken, "secR");
    assert.deepEqual(added[0]!.intents, ["chat"]);
  } finally { await r.stop(); rmSync(dir, { recursive: true, force: true }); }
});

// @spec CHAT-TW-005
test("a disconnect logs a warning with manually and reason, and the twitch dependency goes down", async () => {
  const r = rig();
  try {
    await r.start();
    const client = r.clients[0]!;
    client.connected[0]!();
    assert.deepEqual(r.deps(), { twitch: "ok", youtube: "n/a" });
    const reason = new Error("socket reset");
    client.disconnected[0]!(true, reason);
    const line = r.rec.lines.find((l) => l.level === "warn" && l.msg === "twitch chat disconnected");
    assert.ok(line, "a warning is logged");
    assert.deepEqual(line.obj, { manually: true, reason });
    assert.deepEqual(r.deps(), { twitch: "down", youtube: "n/a" });
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-005
test("chat/src has no value import of @twurple/*: type-only imports and dynamic import() only", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    const statics = src.match(/^\s*(?:import|export)\b[^;]*?from\s*["']@twurple\/[^"']*["']|^\s*import\s*["']@twurple\/[^"']*["']/gm) ?? [];
    for (const m of statics) if (!/^\s*(?:import|export)\s+type\b/.test(m)) offenders.push(`${f}: ${m.trim()}`);
  }
  assert.deepEqual(offenders, []);
  const all = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.match(all, /await import\("@twurple\/chat"\)/, "the guard sees the dynamic imports it allows");
});

// @spec CHAT-INJ-001
test("inject.request is subscribed with group chat in the fake, idle and twitch plans", async () => {
  const plans: [string, Record<string, unknown>, Partial<ChatServiceDeps>][] = [
    ["fake", { chat: { sources: ["fake"], twitch: { channel: "" } } }, { stdin: Object.assign(new PassThrough(), { isTTY: true }) }],
    ["idle", { chat: { twitch: { channel: "" } } }, {}],
    ["twitch", {}, {}],
  ];
  for (const [label, over, deps] of plans) {
    const r = rig(over, deps);
    try {
      await r.start();
      assert.deepEqual(r.bus.subscriptions.map((s) => ({ group: s.group, types: s.types })), [{ group: "chat", types: ["inject.request"] }], label);
    } finally { await r.stop(); }
  }
});

// @spec CHAT-FAKE-006
test("a rejecting fake publish warns 'chat.message publish failed' and the source keeps running", async () => {
  const stdin = new PassThrough();
  const r = rig({ chat: { sources: ["fake"], twitch: { channel: "" } } }, { stdin });
  try {
    await r.start();
    r.bus.fail = (t) => t === "chat.message";
    stdin.write("first\n");
    await waitFor(() => r.rec.lines.some((l) => l.level === "warn" && l.msg === "chat.message publish failed"), "publish-failed warning");
    r.bus.fail = undefined;
    stdin.write("second\n");
    await waitFor(() => r.bus.of("chat.message").length === 1, "a later message still publishes");
    assert.equal(r.bus.of("chat.message")[0]!.text, "second");
  } finally { await r.stop(); }
});

// @spec CHAT-TW-013, CHAT-FILT-005
test("a Twitch line is published with the platform's message id and user id", async () => {
  const r = rig();
  try {
    await r.start();
    const msg = { id: "tw-msg-1", userInfo: { userName: "bob", displayName: "Bob", userId: "42", isMod: false, isBroadcaster: false, isSubscriber: false } };
    r.clients[0]!.messages[0]!("#chan", "bob", "hello", msg);
    await waitFor(() => r.bus.of("chat.message").length === 1, "chat.message");
    const ev = r.bus.of("chat.message")[0]!;
    assert.deepEqual([ev.platform, ev.userId, ev.messageId], ["twitch", "42", "tw-msg-1"]);
  } finally { await r.stop(); }
});

// @spec CHAT-FILT-001, CHAT-FILT-012
test("chat.ignore_users drops a Twitch line by login or by display name, in any letter case", async () => {
  const r = rig({ chat: { ignore_users: ["Some_Login", "FancyName"] } });
  try {
    await r.start();
    const from = (userName: string, displayName: string) => ({ id: `id-${userName}`, userInfo: { userName, displayName, userId: "1", isMod: false, isBroadcaster: false, isSubscriber: false } });
    const send = r.clients[0]!.messages[0]!;
    send("#chan", "some_login", "by login", from("some_login", "Whoever"));
    send("#chan", "other", "by name", from("other", "fancyname"));
    send("#chan", "bob", "kept", from("bob", "Bob"));
    await waitFor(() => r.bus.of("chat.message").length >= 1, "chat.message");
    assert.deepEqual(r.bus.of("chat.message").map((m) => m.text), ["kept"]);
  } finally { await r.stop(); }
});

// @spec CHAT-TW-014, CHAT-TW-015, CHAT-TW-016, CHAT-TW-017, CHAT-FORGET-001, CHAT-FORGET-008
test("Twitch removal events are published as chat.removed with platform twitch", async () => {
  const r = rig();
  try {
    await r.start();
    const c = r.clients[0]!;
    c.removed[0]!("#chan", "gone-1", {});
    c.banned[0]!("#chan", "troll", { targetUserId: "7" });
    c.timedOut[0]!("#chan", "flood", 60, { targetUserId: "8" });
    c.cleared[0]!("#chan", {});
    await waitFor(() => r.bus.of("chat.removed").length === 4, "four chat.removed");
    assert.deepEqual(r.bus.of("chat.removed"), [
      { platform: "twitch", scope: "message", messageId: "gone-1" },
      { platform: "twitch", scope: "user", userId: "7", reason: "banned" },
      { platform: "twitch", scope: "user", userId: "8", reason: "timeout" },
      { platform: "twitch", scope: "all", reason: "cleared" },
    ]);
  } finally { await r.stop(); }
});

// @spec CHAT-TW-018
test("a ban with a null targetUserId publishes no chat.removed and warns", async () => {
  const r = rig();
  try {
    await r.start();
    r.clients[0]!.banned[0]!("#chan", "troll", { targetUserId: null });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.bus.of("chat.removed").length, 0);
    assert.ok(r.rec.lines.some((l) => l.level === "warn"), "a warning is logged");
  } finally { await r.stop(); }
});

// @spec CHAT-FORGET-006
test("a removal for an ignored viewer is still published: ignore lists do not apply to removals", async () => {
  const r = rig({ chat: { ignore_users: ["troll"], ignore_prefixes: ["!"] } });
  try {
    await r.start();
    r.clients[0]!.banned[0]!("#chan", "troll", { targetUserId: "7" });
    r.clients[0]!.removed[0]!("#chan", "!cmd-msg", {});
    await waitFor(() => r.bus.of("chat.removed").length === 2, "both removals published");
  } finally { await r.stop(); }
});

// @spec CHAT-FORGET-001
test("any source's removal is published with that source's platform", async () => {
  const hold: { env?: any } = {};
  const r = rig({ chat: { sources: ["youtube"] } }, {
    sourceFactories: { youtube: () => ({ name: "youtube", state: () => ({ state: "reading" }), async start(env: any) { hold.env = env; env.onState("reading"); }, stop() {} }) as never },
  });
  try {
    await r.start();
    hold.env.emitRemoval({ platform: "youtube", scope: "user", userId: "UCabc", reason: "banned" });
    await waitFor(() => r.bus.of("chat.removed").length === 1, "chat.removed");
    assert.deepEqual(r.bus.of("chat.removed")[0], { platform: "youtube", scope: "user", userId: "UCabc", reason: "banned" });
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-008, CHAT-FORGET-001
test("a failed chat.removed publish is logged at warn and the next removal is still published", async () => {
  const r = rig();
  try {
    await r.start();
    let calls = 0;
    r.bus.fail = () => ++calls === 1;
    const c = r.clients[0]!;
    c.removed[0]!("#chan", "first", {});
    await waitFor(() => calls >= 1, "first publish attempted");
    c.removed[0]!("#chan", "second", {});
    await waitFor(() => r.bus.of("chat.removed").length === 1, "second published");
    assert.equal(r.bus.of("chat.removed")[0]!.messageId, "second");
    assert.ok(r.rec.lines.some((l) => l.level === "warn" && /chat\.removed/.test(String(l.msg))), "the failure is logged at warn naming chat.removed");
  } finally { await r.stop(); }
});

// @spec CHAT-FORGET-007
test("chat/src has no call that sends a line, ban, timeout or delete to a platform", () => {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  const all = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.doesNotMatch(all, /\.(say|ban|timeout|deleteMessage|deleteChatMessage|clear|action|whisper|banUser|timeoutUser)\s*\(/);
  assert.doesNotMatch(all, /\/moderation\/|helix\.moderation|liveChat\/(bans|messages)/);
});
