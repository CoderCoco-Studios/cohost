/**
 * The chat service running several sources at once (#177): plan shapes, source lifecycle, the ready rule, per-source health.
 * Stub sources stand in for twitch and youtube through `ChatServiceDeps.sourceFactories`; a `clock` dep injects the 30 s bound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import { chatService, type ChatServiceDeps } from "../src/service.js";
import type { ChatSource, ChatSourceName, ChatSourceStartEnv, ChatSourceStatus, ChatSender } from "../src/source.js";

class SvcBus extends FakeBus {
  async resetGroup(): Promise<void> {}
  subscriptions: { group: string; types: string[]; start?: string }[] = [];
  async subscribe(opts: { group: string; types: string[]; start?: string }): Promise<void> { this.subscriptions.push(opts); }
  stopped = 0;
  stop(): void { this.stopped++; }
}

/** A source the test drives: records start/stop, reports whatever state the test sets. */
class StubSource implements ChatSource {
  status: ChatSourceStatus = { state: "starting" };
  env!: ChatSourceStartEnv;
  starts = 0;
  stops = 0;
  subscriptionsAtStart = -1;
  constructor(public name: ChatSourceName, private bus: SvcBus, private startBehaviour: () => Promise<void> | void = () => {}) {}
  state(): ChatSourceStatus { return this.status; }
  async start(env: ChatSourceStartEnv): Promise<void> {
    this.starts++;
    this.env = env;
    this.subscriptionsAtStart = this.bus.subscriptions.length;
    await this.startBehaviour();
  }
  stop(): void { this.stops++; }
  set(state: ChatSourceStatus["state"], reason?: string): void { this.status = { state, reason }; this.env.onState(state, reason); }
}

const sender = (over: Partial<ChatSender> = {}): ChatSender => ({ login: "bob", displayName: "Bob", userId: "u1", isMod: false, isSubscriber: false, isBroadcaster: false, ...over });

interface Clock { calls: { ms: number; fire: () => void; cleared: boolean }[] }

function rig(over: Record<string, unknown>, stubs: Partial<Record<ChatSourceName, (bus: SvcBus) => StubSource>> = {}, deps: Partial<ChatServiceDeps> = {}) {
  const bus = new SvcBus();
  const rec = recordingLog();
  const exits: number[] = [];
  const made: StubSource[] = [];
  const clock: Clock = { calls: [] };
  let shutdown: (() => void | Promise<void>) | undefined;
  let heartbeat: { stop(): Promise<void> } | undefined;
  const sourceFactories = Object.fromEntries(
    Object.entries(stubs).map(([name, make]) => [name, () => { const s = make!(bus); made.push(s); return s; }]),
  );
  const svc = chatService({
    sourceFactories,
    clock: {
      setTimeout: (fn: () => void, ms: number) => { const c = { ms, fire: fn, cleared: false }; clock.calls.push(c); return c; },
      clearTimeout: (h: unknown) => { (h as { cleared: boolean }).cleared = true; },
    },
    exit: (c: number) => { exits.push(c); },
    ...deps,
  } as ChatServiceDeps);
  const cfg = testConfig(over);
  const start = () => runService({
    service: "chat", health: () => svc.health(cfg), main: async (ctx) => { heartbeat = ctx.heartbeat; await svc.main(ctx); },
    loadConfig: () => cfg, createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: (c) => { exits.push(c); },
  });
  const last = () => bus.health[bus.health.length - 1];
  const readyHeartbeats = () => bus.health.filter((h) => h.state === "ready" || h.state === "degraded");
  return { bus, rec, exits, made, clock, start, last, readyHeartbeats, deps: () => svc.health(cfg).deps(), stop: async () => { await shutdown?.(); await heartbeat?.stop(); } };
}

const twitchStub = (b: SvcBus) => new StubSource("twitch", b);
const youtubeStub = (b: SvcBus) => new StubSource("youtube", b);
const YT = { api_key: "k", video: "dQw4w9WgXcQ" };

// @spec CHAT-PLAN-015, CHAT-INJ-001
test("inject.request is subscribed (group chat, start latest) before any source starts, and in every shape", async () => {
  const shapes: [string, Record<string, unknown>, Parameters<typeof rig>[1]][] = [
    ["sources running", { chat: { sources: ["twitch", "youtube"], youtube: YT } }, { twitch: twitchStub, youtube: youtubeStub }],
    ["off", { chat: { sources: [] } }, {}],
    ["idle plan", { chat: { sources: ["twitch", "youtube"], twitch: { channel: "" } } }, { twitch: twitchStub, youtube: youtubeStub }],
    ["fake", { chat: { sources: ["fake"] } }, {}],
  ];
  for (const [shape, over, stubs] of shapes) {
    const r = rig(over, stubs, { stdin: Object.assign(new PassThrough(), { isTTY: true }) });
    try {
      await r.start();
      assert.deepEqual(r.bus.subscriptions.map((s) => [s.group, s.start]), [["chat", "latest"]], shape);
      for (const s of r.made) assert.equal(s.subscriptionsAtStart, 1, `${shape}: ${s.name} started after the subscription`);
    } finally { await r.stop(); }
  }
});

// @spec CHAT-PLAN-008, CHAT-HEALTH-007
test("empty chat.sources: no source built, nothing at warn level or above, ready in mode off with every dependency n/a", async () => {
  const r = rig({ chat: { sources: [] } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    await waitFor(() => r.bus.health.some((h) => h.state === "ready"), "ready");
    assert.equal(r.made.length, 0);
    for (const level of ["warn", "error", "fatal"] as const) assert.deepEqual(r.rec.msgs(level), [], level);
    const hb = r.bus.health.find((h) => h.state === "ready")!;
    assert.equal(hb.mode, "off");
    assert.deepEqual(hb.deps, { twitch: "n/a", youtube: "n/a" });
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-003, CHAT-HEALTH-005
test("every source a gap: nothing built, one error naming each reason in list order, degraded with the joined reasons, then still-idle warnings", async () => {
  const r = rig(
    { chat: { sources: ["youtube", "twitch"], twitch: { channel: "" }, youtube: { api_key: "", video: "" } } },
    { twitch: twitchStub, youtube: youtubeStub },
    { idleWarnEveryMs: 15 },
  );
  const joined = "chat.youtube.api_key is not set; chat.youtube.video is not set; chat.twitch.channel is not set";
  try {
    await r.start();
    await waitFor(() => r.rec.msgs("warn").filter((m) => /still idle/.test(String(m))).length >= 2, "reminders");
    assert.equal(r.made.length, 0, "no source is started");
    assert.equal(r.rec.msgs("error").length, 1);
    assert.ok(String(r.rec.msgs("error")[0]).includes(joined), String(r.rec.msgs("error")[0]));
    await waitFor(() => r.bus.health.some((h) => h.state === "degraded" && h.detail === joined), "degraded heartbeat with the reasons");
    const hb = r.bus.health.find((h) => h.state === "degraded")!;
    assert.equal(hb.mode, "live");
    assert.deepEqual(hb.deps, { twitch: "down", youtube: "down" });
    assert.equal(r.bus.of("chat.message").length, 0);
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-010
test("one gap and one runnable source: the runnable one starts, one error names the gap's reason, the gap source is down", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT, twitch: { channel: "" } } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    assert.deepEqual(r.made.map((s) => s.name), ["youtube"], "only the runnable source is built and started");
    assert.equal(r.made[0]!.starts, 1);
    const errors = r.rec.msgs("error").map(String);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /chat\.twitch\.channel is not set/);
    r.made[0]!.set("reading");
    assert.deepEqual(r.deps(), { twitch: "down", youtube: "ok" });
    assert.deepEqual(r.exits, []);
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-011
test("a start that rejects makes only that source stopped with the message as its reason; the others keep running", async () => {
  const r = rig(
    { chat: { sources: ["twitch", "youtube"], youtube: YT } },
    { twitch: twitchStub, youtube: (b) => new StubSource("youtube", b, () => { throw new Error("quota gone"); }) },
  );
  try {
    await r.start();
    const [tw, yt] = r.made;
    assert.equal(yt!.name, "youtube");
    assert.ok(r.rec.msgs("error").some((m) => /chat source youtube did not start: quota gone/.test(String(m))), "the reason is logged");
    tw!.set("reading");
    assert.deepEqual(r.deps(), { twitch: "ok", youtube: "down" }, "the service reports youtube stopped: its dependency is down");
    assert.deepEqual(r.exits, [], "the process keeps running");
    assert.equal(tw!.stops, 0, "the other source is not stopped");
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-009
test("a source listed twice is built and started once", async () => {
  const r = rig({ chat: { sources: ["twitch", "twitch"] } }, { twitch: twitchStub });
  try {
    await r.start();
    assert.equal(r.made.length, 1);
    assert.equal(r.made[0]!.starts, 1);
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-002, CHAT-SRC-003
test("ready only when every listed source has had a first outcome; a failure counts as one", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    const [tw, yt] = r.made;
    assert.equal(r.readyHeartbeats().length, 0, "starting while no source has an outcome");
    tw!.set("reading");
    await new Promise((x) => setTimeout(x, 30));
    assert.equal(r.readyHeartbeats().length, 0, "one outcome of two is not enough");
    yt!.set("stopped", "the video was not found");
    await waitFor(() => r.readyHeartbeats().length > 0, "ready after the second outcome");
    assert.equal(r.readyHeartbeats()[0]!.state, "degraded", "a stopped dependency degrades the ready service (CHAT-HEALTH-004)");
    assert.ok(r.clock.calls.every((c) => c.cleared || c.ms === 30_000), "the only bound is the 30 s one");
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-003
test("a source waiting (a broadcast hours away) is an outcome, so it does not hold the service in starting", async () => {
  const r = rig({ chat: { sources: ["youtube"] , youtube: YT } }, { youtube: youtubeStub });
  try {
    await r.start();
    r.made[0]!.set("waiting", "the broadcast has not started");
    await waitFor(() => r.readyHeartbeats().length > 0, "ready");
    assert.deepEqual(r.deps(), { twitch: "n/a", youtube: "down" });
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-003, CHAT-SRC-004
test("30 s after start the service is ready whatever is pending, and a source with no outcome is down", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    r.made[0]!.set("reading");
    assert.equal(r.readyHeartbeats().length, 0);
    const bound = r.clock.calls.find((c) => c.ms === 30_000 && !c.cleared);
    assert.ok(bound, "a 30000 ms timer was set through the injected clock");
    bound.fire();
    await waitFor(() => r.readyHeartbeats().length > 0, "ready at the bound");
    assert.deepEqual(r.deps(), { twitch: "ok", youtube: "down" });
    assert.equal(r.last()!.state, "degraded");
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-003
test("the 30 s timer is cancelled once every source has had an outcome, and on shutdown", async () => {
  const r = rig({ chat: { sources: ["twitch"] } }, { twitch: twitchStub });
  await r.start();
  r.made[0]!.set("reading");
  await waitFor(() => r.readyHeartbeats().length > 0, "ready");
  assert.ok(r.clock.calls.filter((c) => c.ms === 30_000).every((c) => c.cleared), "no live bound after ready");
  await r.stop();
});

// @spec CHAT-SRC-009, CHAT-HEALTH-003, CHAT-HEALTH-009
test("each source's dependency follows its own state: ok only while reading", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    const [tw, yt] = r.made;
    const expected = { starting: "down", waiting: "down", reading: "ok", retrying: "down", stopped: "down" } as const;
    for (const [state, dep] of Object.entries(expected)) {
      tw!.set(state as never, state === "starting" || state === "reading" ? undefined : "why");
      yt!.set("reading");
      assert.equal(r.deps().twitch, dep, `twitch ${state}`);
      assert.equal(r.deps().youtube, "ok");
    }
  } finally { await r.stop(); }
});

// @spec CHAT-HEALTH-004, CHAT-HEALTH-011
test("after ready, a dependency going down degrades the heartbeat, and a quiet youtube chat stays ok", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT } }, { twitch: twitchStub, youtube: youtubeStub });
  try {
    await r.start();
    const [tw, yt] = r.made;
    tw!.set("reading");
    yt!.set("reading");
    await waitFor(() => r.last()?.state === "ready", "ready");
    assert.deepEqual(r.last()!.deps, { twitch: "ok", youtube: "ok" }, "no message needed to stay ok");
    tw!.set("retrying", "disconnected");
    assert.equal(r.deps().twitch, "down");
    assert.equal(r.deps().youtube, "ok");
  } finally { await r.stop(); }
});

// @spec CHAT-HEALTH-002, CHAT-HEALTH-006, CHAT-HEALTH-008, CHAT-HEALTH-010, CHAT-HEALTH-012
test("mode is fixed by the list: mock with fake, live without; sources not listed are n/a", async () => {
  const cases: [Record<string, unknown>, string, Record<string, string>][] = [
    [{ chat: { sources: ["fake"] } }, "mock", { twitch: "n/a", youtube: "n/a" }],
    [{ chat: { sources: ["fake", "twitch"] } }, "mock", { twitch: "down", youtube: "n/a" }],
    [{ chat: { sources: ["twitch", "youtube"], youtube: YT } }, "live", { twitch: "down", youtube: "down" }],
    [{ chat: { sources: ["twitch"], twitch: { channel: "" } } }, "live", { twitch: "down", youtube: "n/a" }],
    [{ chat: { sources: ["youtube"], youtube: YT } }, "live", { twitch: "n/a", youtube: "down" }],
  ];
  for (const [over, mode, deps] of cases) {
    const r = rig(over, { twitch: twitchStub, youtube: youtubeStub }, { stdin: Object.assign(new PassThrough(), { isTTY: true }) });
    try {
      await r.start();
      assert.equal(r.bus.health[0]!.mode, mode, JSON.stringify(over));
      assert.deepEqual(r.deps(), deps, JSON.stringify(over));
      if (mode === "mock" && !over.chat) assert.equal(r.made.length, 0);
    } finally { await r.stop(); }
  }
});

// @spec CHAT-HEALTH-010, CHAT-PLAN-001, CHAT-PLAN-005
test("fake alone builds no twitch or youtube source and loads no platform library", async () => {
  let clients = 0;
  let auths = 0;
  const r = rig(
    { chat: { sources: ["fake"], twitch: { channel: "chan" }, youtube: YT } },
    { twitch: twitchStub, youtube: youtubeStub },
    { createClient: () => { clients++; throw new Error("no"); }, createAuth: () => { auths++; throw new Error("no"); }, stdin: Object.assign(new PassThrough(), { isTTY: true }) },
  );
  try {
    await r.start();
    assert.equal(r.made.length, 0);
    assert.equal(clients + auths, 0);
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-005
test("a youtube-only list never builds a twitch client or auth provider", async () => {
  let built = 0;
  const r = rig(
    { chat: { sources: ["youtube"], youtube: YT, twitch: { channel: "chan", client_id: "i", client_secret: "s", access_token: "a", refresh_token: "r" } } },
    { youtube: youtubeStub },
    { createClient: () => { built++; throw new Error("no"); }, createAuth: () => { built++; throw new Error("no"); } },
  );
  try {
    await r.start();
    assert.equal(built, 0);
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-007
test("every source's messages go through the one filter with that source's platform", async () => {
  const r = rig(
    { chat: { sources: ["twitch", "youtube"], youtube: YT, ignore_users: ["nightbot"], ignore_prefixes: ["!"] } },
    { twitch: twitchStub, youtube: youtubeStub },
  );
  try {
    await r.start();
    const [tw, yt] = r.made;
    tw!.set("reading");
    yt!.set("reading");
    tw!.env.emit(sender({ displayName: "Bob" }), "hello   Coco");
    yt!.env.emit(sender({ login: "yt1", displayName: "Yan", userId: "UCyan" }), "hi there");
    yt!.env.emit(sender({ login: "nightbot", displayName: "Nightbot" }), "ignored by user");
    tw!.env.emit(sender(), "!uptime");
    await waitFor(() => r.bus.of("chat.message").length >= 2, "two messages");
    await new Promise((x) => setTimeout(x, 20));
    assert.deepEqual(
      r.bus.of("chat.message").map((m) => [m.platform, m.user, m.text, m.userId]),
      [["twitch", "Bob", "hello Coco", "u1"], ["youtube", "Yan", "hi there", "UCyan"]],
    );
  } finally { await r.stop(); }
});

// @spec CHAT-SRC-008
test("a failed publish is logged at warn level and the next message is handled", async () => {
  const r = rig({ chat: { sources: ["youtube"], youtube: YT } }, { youtube: youtubeStub });
  try {
    await r.start();
    const yt = r.made[0]!;
    yt.set("reading");
    let calls = 0;
    r.bus.fail = (type) => type === "chat.message" && ++calls === 1;
    yt.env.emit(sender(), "first");
    yt.env.emit(sender(), "second");
    await waitFor(() => r.bus.of("chat.message").length === 1, "the second message");
    assert.equal(r.bus.of("chat.message")[0]!.text, "second");
    assert.ok(r.rec.msgs("warn").length >= 1);
  } finally { await r.stop(); }
});

// @spec CHAT-PLAN-006, CHAT-SRC-005
test("shutdown stops every started source once and the bus; a gap source that never started is not stopped", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT, twitch: { channel: "" } } }, { twitch: twitchStub, youtube: youtubeStub });
  await r.start();
  await r.stop();
  assert.deepEqual(r.made.map((s) => [s.name, s.stops]), [["youtube", 1]]);
  assert.equal(r.bus.stopped, 1);
});

// @spec CHAT-PLAN-006
test("shutdown stops all runnable sources even when one stop throws", async () => {
  const r = rig({ chat: { sources: ["twitch", "youtube"], youtube: YT } }, {
    twitch: (b) => Object.assign(new StubSource("twitch", b), { stop() { this.stops++; throw new Error("stuck"); } }),
    youtube: youtubeStub,
  });
  await r.start();
  await r.stop();
  assert.deepEqual(r.made.map((s) => s.stops), [1, 1]);
});

// @spec CHAT-SRC-006, CHAT-PLAN-006
test("after shutdown the fake source publishes nothing more, from its script or from stdin", async () => {
  const stdin = new PassThrough();
  const r = rig({ chat: { sources: ["fake"], fake: { interval_ms: 5 } } }, {}, { stdin });
  await r.start();
  await waitFor(() => r.bus.of("chat.message").length >= 2, "scripted messages");
  await r.stop();
  const n = r.bus.of("chat.message").length;
  stdin.write("late line\n");
  await new Promise((x) => setTimeout(x, 60));
  assert.equal(r.bus.of("chat.message").length, n);
});

// @spec CHAT-FAKE-001, CHAT-FAKE-007, CHAT-FAKE-008
test("the fake script publishes the two platform shapes: viewers 1 and 3 on twitch, viewer 2 on youtube, userId equal to the name", async () => {
  const r = rig({ chat: { sources: ["fake"], fake: { interval_ms: 5 } } }, {}, { stdin: new PassThrough() });
  try {
    await r.start();
    await waitFor(() => r.bus.of("chat.message").length >= 5, "the script");
    const seen = new Map<string, Set<string>>();
    for (const m of r.bus.of("chat.message")) {
      assert.equal(m.userId, m.user, "userId equals the name");
      if (!seen.has(m.user)) seen.set(m.user, new Set());
      seen.get(m.user)!.add(m.platform);
    }
    assert.deepEqual([...seen.get("fake_viewer1")!], ["twitch"]);
    assert.deepEqual([...seen.get("fake_viewer2")!], ["youtube"]);
    assert.deepEqual([...(seen.get("fake_viewer3") ?? new Set(["twitch"]))], ["twitch"]);
  } finally { await r.stop(); }
});

// @spec CHAT-FAKE-007
test("a stdin line is published as fake_viewer1 on twitch with userId fake_viewer1", async () => {
  const stdin = new PassThrough();
  const r = rig({ chat: { sources: ["fake"], fake: { interval_ms: 100_000 } } }, {}, { stdin });
  try {
    await r.start();
    stdin.write("typed hello\n");
    await waitFor(() => r.bus.of("chat.message").length === 1, "stdin message");
    const m = r.bus.of("chat.message")[0]!;
    assert.deepEqual([m.platform, m.user, m.userId], ["twitch", "fake_viewer1", "fake_viewer1"]);
  } finally { await r.stop(); }
});

// @spec CHAT-FAKE-009, CHAT-SRC-003, CHAT-HEALTH-002
test("the fake source is reading at once, so the service is ready in mode mock before the first interval", async () => {
  const r = rig({ chat: { sources: ["fake"], fake: { interval_ms: 100_000 } } }, {}, { stdin: Object.assign(new PassThrough(), { isTTY: true }) });
  try {
    await r.start();
    await waitFor(() => r.bus.health.some((h) => h.state === "ready" && h.mode === "mock"), "mock ready");
    assert.equal(r.bus.of("chat.message").length, 0);
  } finally { await r.stop(); }
});
