import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { Bus, EVENT_TYPES, EventPayloads, type BusEvent } from "../src/index.js";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const hasRedis = await redisUp();
const needsRedis = { skip: !hasRedis && `no Redis at ${url}` };
/** Fails the test instead of hanging it when the awaited thing never happens. */
const within = <T>(p: Promise<T>, ms = 3000) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timed out")), ms); })]).finally(() => clearTimeout(timer));
};
let scratchCount = 0;

/** What a Redis test works with: buses and a raw connection on streams of its own. */
interface Scratch {
  /** The scratch stream keys. */
  events: string;
  health: string;
  /** A Bus on the scratch streams; it is stopped when the test ends. */
  bus(source: string, log?: ConstructorParameters<typeof Bus>[1]): Bus;
  raw: Redis;
}

/**
 * Runs a Redis test on its own pair of streams (so it neither reads nor writes `cohost:events` and `cohost:health`)
 * and always cleans up: every bus is stopped and the streams, with their groups, are deleted whether the body passed,
 * failed or timed out.
 */
async function scratch(body: (s: Scratch) => Promise<void>): Promise<void> {
  const prefix = `cohost-test:${process.pid}:${Date.now()}:${scratchCount++}`;
  const raw = new Redis(url);
  const buses: Bus[] = [];
  try {
    await body({
      events: `${prefix}:events`,
      health: `${prefix}:health`,
      bus: (source, log) => { const b = new Bus(source, log, url, { streamPrefix: prefix }); buses.push(b); return b; },
      raw,
    });
  } finally {
    for (const b of buses) b.stop();
    await raw.del(`${prefix}:events`, `${prefix}:health`).catch(() => {});
    raw.disconnect();
  }
}

// @spec BUS-EVT-003, BUS-EVT-010
test("every region event validates its documented shape", () => {
  assert.ok(EventPayloads["attention.focus"].safeParse({ reason: "mentioned", score: 1, focus: { kind: "chat", who: "u", text: "hi" } }).success);
  assert.ok(EventPayloads["affect.state"].safeParse({ valence: 0.2, arousal: 0.4, mood: "happy" }).success);
  assert.equal(EventPayloads["affect.state"].safeParse({ valence: 2, arousal: 0.4, mood: "happy" }).success, false);
  assert.ok(EventPayloads["memory.recall.request"].safeParse({ id: "x", query: "q" }).success);
  assert.ok(EventPayloads["memory.recall.reply"].safeParse({ id: "x", memories: [{ ts: 1, kind: "chat", who: "u", text: "t" }] }).success);
  const viewer = EventPayloads["memory.viewer"].safeParse({ user: "u", isNew: true, msgCount: 1, regular: false });
  assert.ok(viewer.success);
  assert.equal("notes" in viewer.data!, false, "memory.viewer carries no notes text");
  assert.equal(EventPayloads["memory.viewer"].safeParse({ user: "u", isNew: true, msgCount: 1 }).success, false, "regular is required");
  assert.equal(EventPayloads["memory.viewer"].safeParse({ user: "u", isNew: true, msgCount: 1.5, regular: true }).success, false);
  assert.equal("notes" in EventPayloads["memory.viewer"].parse({ user: "u", isNew: false, msgCount: 2, regular: true, notes: "legacy" }), false);
});

// @spec BUS-EVT-020
test("memory.notes.request/reply validate their shapes: text optional (absent for health/family), no subscriber field", () => {
  const req = EventPayloads["memory.notes.request"];
  assert.ok(req.safeParse({ id: "1", users: ["bob", "amy"] }).success);
  assert.equal(req.safeParse({ id: "1", users: [] }).success, false, "users must be non-empty");
  assert.equal(req.safeParse({ id: "1" }).success, false);
  assert.equal(req.safeParse({ id: "1", users: [3] }).success, false);

  const rep = EventPayloads["memory.notes.reply"];
  const viewer = (notes: unknown[]) => ({ id: "1", viewers: [{ user: "Bob", regular: true, msgCount: 3, notes }] });
  assert.ok(rep.safeParse({ id: "1", viewers: [] }).success, "an empty list is valid");
  assert.ok(rep.safeParse(viewer([{ layer: "core", category: "general", text: "t", strength: 0.5 }])).success);
  assert.ok(rep.safeParse(viewer([{ layer: "recent", category: "health", hint: "gently", strength: 1 }])).success, "text is optional");
  assert.ok(rep.safeParse(viewer([{ layer: "recent", category: "family", text: "t", hint: "h", strength: 0 }])).success);
  for (const bad of [
    { layer: "other", category: "general", strength: 0.5 },
    { layer: "core", category: "politics", strength: 0.5 },
    { layer: "core", category: "general", strength: 1.1 },
    { layer: "core", category: "general", strength: -0.1 },
    { layer: "core", category: "general" },
  ]) assert.equal(rep.safeParse(viewer([bad])).success, false, JSON.stringify(bad));
  assert.equal(rep.safeParse({ id: "1", viewers: [{ user: "Bob", regular: "yes", msgCount: 3, notes: [] }] }).success, false);
  assert.equal(rep.safeParse({ id: "1", viewers: [{ user: "Bob", regular: true, msgCount: 3.5, notes: [] }] }).success, false);
  const parsed = rep.parse({ id: "1", viewers: [{ user: "Bob", regular: true, msgCount: 3, isSub: true, notes: [] }] });
  assert.equal("isSub" in parsed.viewers[0]!, false, "no subscriber status survives validation");
});

// @spec BUS-EVT-001, BUS-EVT-020
test("the catalogue includes the viewer-notes surfacing events", () => {
  assert.ok(EVENT_TYPES.includes("memory.notes.request"));
  assert.ok(EVENT_TYPES.includes("memory.notes.reply"));
});

// @spec BUS-STREAM-001, BUS-SUB-001, BUS-SUB-004
test("publish → consumer group subscribe round-trip (needs Redis)", needsRedis, () => scratch(async ({ bus }) => {
  const group = "round-trip";
  const pub = bus("pub");
  const sub = bus("sub");
  const got: BusEvent[] = [];
  let ready!: () => void;
  const groupReady = new Promise<void>((r) => { ready = r; });
  const done = new Promise<void>((resolve) => {
    void sub.subscribe({ group, types: ["attention.focus"], start: "latest", blockMs: 200, onReady: ready }, (ev) => { got.push(ev); resolve(); });
  });
  await within(groupReady);
  await pub.publish("affect.state", { valence: 0, arousal: 0, mood: "neutral" }); // filtered out by types
  await pub.publish("attention.focus", { reason: "test", score: 0.7 });
  await within(done);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.type, "attention.focus");
  assert.equal(got[0]!.source, "pub");
  assert.deepEqual(got[0]!.data, { reason: "test", score: 0.7 });
}));

// @spec BUS-STREAM-003
test("publish validates the payload before it reaches the stream (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events }) => {
  const b = bus("validate");
  await assert.rejects(b.publish("affect.state", { valence: 5, arousal: 0, mood: "happy" }));
  await assert.rejects(b.publish("affect.state", { valence: 0, arousal: 0, mood: "ecstatic" } as never));
  assert.equal(await raw.xlen(events), 0, "nothing reached the stream");
}));

// @spec BUS-SUB-005
test("a throwing handler is logged, the event acked, and the loop keeps going (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events }) => {
  const group = "throwing";
  const errors: unknown[] = [];
  const log = { error: (o: unknown) => errors.push(o), debug() {}, info() {}, warn() {} } as never;
  const pub = bus("pub");
  const sub = bus("sub", log);
  const seen: string[] = [];
  let ready!: () => void;
  const groupReady = new Promise<void>((r) => { ready = r; });
  const second = new Promise<void>((resolve) => {
    void sub.subscribe({ group, types: ["control"], start: "latest", blockMs: 100, onReady: ready }, (ev) => {
      seen.push(ev.data.cmd);
      if (ev.data.cmd === "mute") throw new Error("handler blew up");
      resolve();
    });
  });
  await within(groupReady);
  await pub.publish("control", { cmd: "mute" });
  await pub.publish("control", { cmd: "unmute" });
  await within(second);
  assert.deepEqual(seen, ["mute", "unmute"]);
  assert.equal(errors.length, 1);
  await within((async () => {
    for (;;) { // the ack of the second entry follows its handler
      const pending = (await raw.xpending(events, group)) as [number, ...unknown[]];
      if (pending[0] === 0) return;
      await new Promise((r) => setTimeout(r, 10));
    }
  })());
}));

// @spec BUS-TAIL-002, BUS-SUB-007, BUS-STREAM-006
test("recent() returns the newest events oldest-first and skips entries it can't decode (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events }) => {
  const b = bus("recent");
  await b.publish("brain.status", { state: "idle", detail: "r-1" });
  await raw.xadd(events, "*", "type", "not.a.type", "ts", "1", "source", "x", "data", "{}");
  await raw.xadd(events, "*", "type", "brain.status", "ts", "1", "source", "x", "data", "{not json");
  await raw.xadd(events, "*", "type", "brain.status", "ts", "1", "source", "x", "data", JSON.stringify({ state: "dancing" }));
  await b.publish("brain.status", { state: "thinking", detail: "r-2" });
  const got = await b.recent(5);
  assert.deepEqual(got.map((e) => (e.data as { detail?: string }).detail), ["r-1", "r-2"]);
  assert.equal(got[1]!.source, "recent");
  assert.ok(got[1]!.ts > 0);
}));

// @spec BUS-TAIL-001
test("tail() delivers live events without a consumer group (needs Redis)", needsRedis, () => scratch(async ({ bus, events }) => {
  const pub = bus("tailpub");
  const watcher = bus("tail");
  const got = new Promise<string>((resolve) => {
    void watcher.tail((ev) => { if (ev.type === "brain.status") resolve(ev.source); }, "0"); // from the start of the scratch stream: no race with the publish
  });
  await pub.publish("brain.status", { state: "idle", detail: events });
  assert.equal(await within(got), "tailpub");
}));

// @spec BUS-STOP-001
test("subscribe() and tail() resolve when stop() interrupts a blocking read (needs Redis)", needsRedis, () => scratch(async ({ bus }) => {
  const b = bus("stopper");
  let ready!: () => void;
  const groupReady = new Promise<void>((r) => { ready = r; });
  const sub = b.subscribe({ group: "stopping", start: "latest", blockMs: 5000, onReady: ready }, () => {});
  const tail = b.tail(() => {});
  await within(groupReady);
  await new Promise((r) => setTimeout(r, 100)); // both are now parked in BLOCK
  b.stop();
  await within(Promise.all([sub, tail]), 2000);
}));

// ---- service.heartbeat / health stream ----

const hb = (over: Record<string, unknown> = {}) => ({
  service: "t", instance: "i", pid: 1, version: "0", startedAt: 1, state: "ready" as const,
  deps: { x: "ok" as const }, mode: "live", intervalMs: 5000, ...over,
});

// @spec BUS-EVT-001, BUS-EVT-009
test("service.heartbeat is catalogued and validated", () => {
  assert.ok(EVENT_TYPES.includes("service.heartbeat"));
  assert.ok(EventPayloads["service.heartbeat"].safeParse(hb()).success);
  assert.ok(EventPayloads["service.heartbeat"].safeParse(hb({ detail: "d" })).success);
  assert.equal(EventPayloads["service.heartbeat"].safeParse(hb({ state: "dead" })).success, false);
  assert.equal(EventPayloads["service.heartbeat"].safeParse(hb({ deps: { x: "maybe" } })).success, false);
});

// @spec BUS-STREAM-004
test("publish('service.heartbeat') throws and writes nothing (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events, health }) => {
  const b = bus("hb-reject");
  await assert.rejects(b.publish("service.heartbeat", hb()), /publishHealth/);
  assert.equal(await raw.xlen(events), 0);
  assert.equal(await raw.xlen(health), 0);
}));

// @spec BUS-HEALTH-001, BUS-HEALTH-002
test("publishHealth writes to the health stream only, and rejects an invalid state (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events, health }) => {
  const b = bus("hb-route");
  await b.publishHealth(hb({ service: "route" }));
  assert.equal(await raw.xlen(events), 0);
  assert.equal(await raw.xlen(health), 1);
  await assert.rejects(b.publishHealth(hb({ state: "dead" }) as never));
  assert.equal(await raw.xlen(health), 1, "nothing written for the invalid heartbeat");
}));

// @spec BUS-HEALTH-003, BUS-HEALTH-004
test("recentHealth returns the newest heartbeats oldest-first; tailHealth delivers live ones (needs Redis)", needsRedis, () => scratch(async ({ bus }) => {
  const b = bus("hb-recent");
  const watcher = bus("hb-tail");
  const live = new Promise<string>((resolve) => {
    void watcher.tailHealth((h) => { if (h.data.service === "live") resolve(h.source); }, "0");
  });
  for (let n = 1; n <= 4; n++) await b.publishHealth(hb({ service: "rh", pid: n }));
  const got = await b.recentHealth(3);
  assert.deepEqual(got.map((h) => h.data.pid), [2, 3, 4]);
  await b.publishHealth(hb({ service: "live" }));
  assert.equal(await within(live), "hb-recent");
}));

// ---- service.lifecycle / control target ----

// @spec BUS-EVT-001, BUS-EVT-008
test("service.lifecycle is catalogued and validated", () => {
  const ok = { service: "voice", action: "stop", by: "dashboard", ok: true };
  assert.ok(EVENT_TYPES.includes("service.lifecycle"));
  assert.ok(EventPayloads["service.lifecycle"].safeParse(ok).success);
  assert.ok(EventPayloads["service.lifecycle"].safeParse({ ...ok, ok: false, detail: "boom" }).success);
  assert.equal(EventPayloads["service.lifecycle"].safeParse({ ...ok, action: "kill" }).success, false);
  assert.equal(EventPayloads["service.lifecycle"].safeParse({ ...ok, ok: "yes" }).success, false);
});

// @spec BUS-EVT-004
test("control: no target is still valid, target and pause/resume are accepted", () => {
  assert.ok(EventPayloads.control.safeParse({ cmd: "mute" }).success);
  assert.ok(EventPayloads.control.safeParse({ cmd: "pause", target: "affect" }).success);
  assert.ok(EventPayloads.control.safeParse({ cmd: "resume" }).success);
  assert.equal(EventPayloads.control.safeParse({ cmd: "explode" }).success, false);
  assert.equal(EventPayloads.control.safeParse({ cmd: "mute", target: 3 }).success, false);
});

// @spec BUS-GROUP-001
test("resetGroup creates a missing group at $ and moves an existing one to $ (needs Redis)", needsRedis, () => scratch(async ({ bus, raw, events }) => {
  const b = bus("t");
  const group = "reset";
  await b.resetGroup(group); // missing: created
  await b.publish("control", { cmd: "mute" });
  await raw.xgroup("SETID", events, group, "0");
  await b.resetGroup(group); // existing: moved to $
  const groups = (await raw.xinfo("GROUPS", events)) as unknown[][];
  const g = groups.find((row) => row[1] === group)!;
  const lastDelivered = g[g.indexOf("last-delivered-id") + 1];
  const tail = (await raw.xrevrange(events, "+", "-", "COUNT", 1)) as [string, string[]][];
  assert.equal(lastDelivered, tail[0]![0]);
}));

// ---- test injection ----

// @spec BUS-EVT-005
test("injection flags are optional and absent on real payloads", () => {
  const chat = EventPayloads["chat.message"].parse({ platform: "twitch", user: "u", text: "hi" });
  assert.equal("injected" in chat, false);
  assert.equal("remember" in chat, false);
  const sp = EventPayloads["speech.heard"].parse({ speaker: "s", text: "t", durationMs: 1 });
  assert.equal("injected" in sp, false);
  const vis = EventPayloads["vision.summary"].parse({ text: "t" });
  assert.equal("remember" in vis, false);
  const say = EventPayloads["brain.say"].parse({ id: "1", text: "hi", emotion: "neutral" });
  assert.equal("injected" in say, false);
  const focus = EventPayloads["attention.focus"].parse({ reason: "r", score: 1 });
  assert.equal("injected" in focus, false);
});

// @spec BUS-EVT-005
test("injection flags are accepted and kept; non-boolean rejected", () => {
  const vis = EventPayloads["vision.summary"].parse({ text: "t", changed: true, injected: true, remember: false });
  assert.equal(vis.injected, true);
  assert.equal(vis.remember, false);
  assert.equal(EventPayloads["brain.say"].parse({ id: "1", text: "hi", emotion: "neutral", injected: true, remember: false }).injected, true);
  assert.equal(EventPayloads["attention.focus"].parse({ reason: "r", score: 1, injected: true }).injected, true);
  assert.equal(EventPayloads["chat.message"].safeParse({ platform: "twitch", user: "u", text: "x", injected: "yes" }).success, false);
});

// @spec BUS-EVT-001, BUS-EVT-006, BUS-EVT-007
test("inject.request / inject.result are catalogued and validated", () => {
  assert.ok(EVENT_TYPES.includes("inject.request"));
  assert.ok(EVENT_TYPES.includes("inject.result"));
  const req = { id: "a", target: "eyes", kind: "image", url: "http://dashboard:3000/uploads/abc", remember: false };
  assert.ok(EventPayloads["inject.request"].safeParse(req).success);
  assert.ok(EventPayloads["inject.request"].safeParse({ id: "a", target: "chat", kind: "text", text: "x", meta: { user: "u", platform: "youtube", isMod: true }, remember: true }).success);
  assert.equal(EventPayloads["inject.request"].safeParse({ ...req, target: "voice" }).success, false);
  assert.equal(EventPayloads["inject.request"].safeParse({ ...req, kind: "video" }).success, false);
  const { remember: _r, ...noRemember } = req;
  assert.equal(EventPayloads["inject.request"].safeParse(noRemember).success, false);
  assert.ok(EventPayloads["inject.result"].safeParse({ id: "a", ok: false, detail: "stt 503" }).success);
  assert.equal(EventPayloads["inject.result"].safeParse({ id: "a" }).success, false);
});

// @spec BUS-EVT-018
test("avatar.state requires mouthSmile and keeps it", () => {
  const base = { emotion: "happy", intensity: 1, mouthOpen: 0.2, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, driver: "x", connected: true };
  assert.equal(EventPayloads["avatar.state"].safeParse(base).success, false);
  const ok = EventPayloads["avatar.state"].parse({ ...base, mouthSmile: 0.75 });
  assert.equal(ok.mouthSmile, 0.75);
});

// @spec BUS-EVT-018
test("avatar.state accepts each parameter at the ends of its range and rejects a value beyond them", () => {
  const base = { emotion: "happy", intensity: 1, mouthOpen: 0.2, mouthSmile: 0.7, headX: 0, headY: 0, headZ: 0, eyeX: 0, eyeY: 0, blink: 0, driver: "x", connected: true };
  const parse = (over: Record<string, unknown>) => EventPayloads["avatar.state"].safeParse({ ...base, ...over }).success;
  const ranges: Record<string, [number, number]> = {
    intensity: [0, 1], mouthOpen: [0, 1], mouthSmile: [0, 1], blink: [0, 1],
    eyeX: [-1, 1], eyeY: [-1, 1], headX: [-90, 90], headY: [-90, 90], headZ: [-90, 90],
  };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    assert.ok(parse({ [key]: lo }) && parse({ [key]: hi }), `${key} accepts ${lo} and ${hi}`);
    assert.equal(parse({ [key]: lo - 0.01 }), false, `${key} rejects below ${lo}`);
    assert.equal(parse({ [key]: hi + 0.01 }), false, `${key} rejects above ${hi}`);
  }
});

// @spec BUS-EVT-017
test("voice.playing and voice.done share one payload shape", () => {
  const samples: unknown[] = [{ id: "u1", sink: "discord" }, { id: "u1" }, { sink: "x" }, { id: 1, sink: "x" }, { id: "u1", sink: "x", extra: 1 }, {}];
  for (const sample of samples) {
    const playing = EventPayloads["voice.playing"].safeParse(sample);
    const done = EventPayloads["voice.done"].safeParse(sample);
    assert.deepEqual(playing.success, done.success, JSON.stringify(sample));
    if (playing.success) assert.deepEqual(playing.data, done.data);
  }
  assert.ok(EventPayloads["voice.playing"].safeParse({ id: "u1", sink: "discord" }).success);
  assert.equal(EventPayloads["voice.done"].safeParse({ id: "u1" }).success, false);
  assert.equal(EventPayloads["voice.playing"], EventPayloads["voice.done"], "one schema serves both events");
});

// @spec BUS-EVT-021
test("memory.viewers.request validates each op and memory.viewers.reply its envelope", () => {
  const req = EventPayloads["memory.viewers.request"];
  const ok = (d: unknown) => req.safeParse(d).success;
  assert.ok(EVENT_TYPES.includes("memory.viewers.request") && EVENT_TYPES.includes("memory.viewers.reply"));
  assert.ok(ok({ id: "1", op: "list" }));
  assert.ok(ok({ id: "1", op: "list", query: "al" }));
  assert.ok(ok({ id: "1", op: "get", key: "k" }));
  assert.ok(ok({ id: "1", op: "delete_note", noteId: "5" }) && ok({ id: "1", op: "delete_note", noteId: "5", reason: "r" }));
  assert.ok(ok({ id: "1", op: "restore", deletionId: "9" }));
  assert.ok(ok({ id: "1", op: "clear", key: "k" }) && ok({ id: "1", op: "clear", key: "k", reason: "r" }));
  assert.ok(ok({ id: "1", op: "set_regular", regular: true, key: "k" }) && ok({ id: "1", op: "set_regular", regular: false, name: "Pat" }));
  assert.equal(ok({ op: "list" }), false, "id is required");
  assert.equal(ok({ id: "1", op: "get" }), false, "get needs a key");
  assert.equal(ok({ id: "1", op: "delete_note", noteId: 5 }), false, "noteId is a string");
  assert.equal(ok({ id: "1", op: "restore" }), false);
  assert.equal(ok({ id: "1", op: "set_regular", regular: true }), false, "a key or a name is needed");
  assert.equal(ok({ id: "1", op: "set_regular", regular: true, name: "" }), false, "the name is non-empty");
  assert.equal(ok({ id: "1", op: "set_regular", name: "Pat" }), false, "regular is a boolean");
  assert.ok(ok({ id: "1", op: "link_discord", discordId: "9", key: "k" }) && ok({ id: "1", op: "link_discord", discordId: "9", name: "Pat" }));
  assert.ok(ok({ id: "1", op: "unlink_discord", discordId: "9" }));
  assert.equal(ok({ id: "1", op: "link_discord", discordId: "9" }), false, "a key or a name is needed");
  assert.equal(ok({ id: "1", op: "link_discord", discordId: "", key: "k" }), false, "the discord id is non-empty");
  assert.equal(ok({ id: "1", op: "link_discord", key: "k" }), false);
  assert.equal(ok({ id: "1", op: "unlink_discord", discordId: "" }), false);
  assert.equal(ok({ id: "1", op: "purge" }), false, "unknown op");
  const rep = EventPayloads["memory.viewers.reply"];
  assert.ok(rep.safeParse({ id: "1", ok: true }).success && rep.safeParse({ id: "1", ok: true, data: { viewers: [] } }).success);
  assert.ok(rep.safeParse({ id: "1", ok: false, error: "not_found", detail: "no such viewer" }).success);
  assert.ok(rep.safeParse({ id: "1", ok: false, error: "failed" }).success);
  assert.equal(rep.safeParse({ id: "1", ok: false, error: "boom" }).success, false);
  assert.equal(rep.safeParse({ id: "1" }).success, false);
});

// @spec BUS-EVT-001
test("the catalogue is exactly the 24 documented event types, exported as EVENT_TYPES", () => {
  const expected = [
    "chat.message", "vision.summary", "speech.heard", "brain.say", "brain.status", "attention.focus", "affect.state",
    "memory.recall.request", "memory.recall.reply", "memory.viewer", "memory.notes.request", "memory.notes.reply",
    "memory.viewers.request", "memory.viewers.reply", "voice.utterance", "voice.playing", "voice.done", "voice.failed", "avatar.state",
    "control", "inject.request", "inject.result", "service.lifecycle", "service.heartbeat",
  ];
  assert.equal(EVENT_TYPES.length, 24);
  assert.deepEqual([...EVENT_TYPES].sort(), [...expected].sort());
  assert.deepEqual([...EVENT_TYPES].sort(), Object.keys(EventPayloads).sort());
});

// @spec BUS-EVT-022
test("voice.failed requires string id, sink and reason, and accepts an optional fallback with string clip and text", () => {
  const f = EventPayloads["voice.failed"];
  assert.ok(f.safeParse({ id: "u1", sink: "discord", reason: "fetch audio 404" }).success);
  assert.ok(f.safeParse({ id: "u1", sink: "discord", reason: "x", fallback: { clip: "00-ab12cd34.wav", text: "Error: unable to play line." } }).success);
  for (const bad of [
    { sink: "discord", reason: "x" }, { id: "u1", reason: "x" }, { id: "u1", sink: "discord" },
    { id: 1, sink: "discord", reason: "x" }, { id: "u1", sink: "discord", reason: "x", fallback: { clip: "a" } },
    { id: "u1", sink: "discord", reason: "x", fallback: { clip: "a", text: 3 } },
  ]) assert.equal(f.safeParse(bad).success, false, JSON.stringify(bad));
});
