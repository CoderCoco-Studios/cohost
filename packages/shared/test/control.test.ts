import { test } from "node:test";
import assert from "node:assert/strict";
import type { BusEvent, EventType } from "@cohost/bus";
import { controlFor } from "../src/index.js";

const event = (type: EventType, data: unknown): BusEvent => ({ id: "1", type, ts: Date.now(), source: "t", data } as never);
const ctl = (data: Record<string, unknown>) => event("control", data as never);

// @spec SHARED-CTRL-001
test("a control event with no target or this service's target applies; another target applies nothing; non-control returns false", async () => {
  const seen: string[] = [];
  const c = controlFor("cortex", { mute: () => { seen.push("mute"); }, pause: () => { seen.push("pause"); } });
  assert.equal(c.handle(ctl({ cmd: "mute" })), true);
  assert.equal(c.handle(ctl({ cmd: "pause", target: "cortex" })), true);
  assert.equal(c.handle(ctl({ cmd: "unmute", target: "affect" })), true);
  assert.equal(c.handle(ctl({ cmd: "mute", target: "affect" })), true);
  assert.deepEqual(seen, ["mute", "pause"]);
  assert.equal(c.muted, true, "the other-target mute did not apply, the first did");
  assert.equal(c.handle(event("chat.message", { platform: "twitch", user: "u", text: "x" } as never)), false);
  assert.equal(await c.handleAsync(ctl({ cmd: "mute", target: "x" })), true);
  assert.equal(await c.handleAsync(event("brain.status", { state: "idle" } as never)), false);
});

// @spec SHARED-CTRL-002
test("the reader starts with paused and muted false and epoch 0", () => {
  const c = controlFor("salience", {});
  assert.deepEqual([c.paused, c.muted, c.epoch], [false, false, 0]);
});

// @spec SHARED-CTRL-003
test("pause/resume/mute/unmute set the flags before the service's handler runs", async () => {
  const log: string[] = [];
  const c: ReturnType<typeof controlFor> = controlFor("cortex", {
    pause: () => { log.push(`pause:${c.paused}`); },
    resume: () => { log.push(`resume:${c.paused}`); },
    mute: () => { log.push(`mute:${c.muted}`); },
    unmute: () => { log.push(`unmute:${c.muted}`); },
  });
  for (const cmd of ["pause", "mute", "unmute", "resume"]) await c.handleAsync(ctl({ cmd }));
  assert.deepEqual(log, ["pause:true", "mute:true", "unmute:false", "resume:false"]);
});

// @spec SHARED-CTRL-004
test("pause and forget_context increase the epoch by one before the handler runs; mute does not", async () => {
  const seen: number[] = [];
  const c: ReturnType<typeof controlFor> = controlFor("affect", { pause: () => { seen.push(c.epoch); }, forget_context: () => { seen.push(c.epoch); } });
  await c.handleAsync(ctl({ cmd: "pause" }));
  await c.handleAsync(ctl({ cmd: "mute" }));
  await c.handleAsync(ctl({ cmd: "forget_context" }));
  await c.handleAsync(ctl({ cmd: "resume" }));
  assert.deepEqual(seen, [1, 2]);
  assert.equal(c.epoch, 2);
});

// @spec SHARED-CTRL-005
test("forget_context, reload_personality and say call the handler with the event's data; a command with no handler does nothing else", async () => {
  const got: unknown[] = [];
  const c = controlFor("cortex", {
    forget_context: (d) => { got.push(["f", d.cmd]); },
    reload_personality: (d) => { got.push(["r", d.cmd]); },
    say: (d) => { got.push(["s", d.text]); },
  });
  await c.handleAsync(ctl({ cmd: "forget_context" }));
  await c.handleAsync(ctl({ cmd: "reload_personality" }));
  await c.handleAsync(ctl({ cmd: "say", text: "hello" }));
  assert.deepEqual(got, [["f", "forget_context"], ["r", "reload_personality"], ["s", "hello"]]);
  const bare = controlFor("x", {});
  await bare.handleAsync(ctl({ cmd: "say", text: "hello" }));
  await bare.handleAsync(ctl({ cmd: "reload_personality" }));
  assert.deepEqual([bare.paused, bare.muted, bare.epoch], [false, false, 0]);
});

// @spec SHARED-CTRL-006
test("a handler that throws or rejects is logged and the already-updated state stays", async () => {
  const errors: unknown[] = [];
  const c = controlFor("cortex", {
    pause: () => { throw new Error("sync boom"); },
    mute: async () => { throw new Error("async boom"); },
  }, { log: { error: (o: unknown) => errors.push(o) } as never });
  assert.equal(await c.handleAsync(ctl({ cmd: "pause" })), true);
  assert.equal(await c.handleAsync(ctl({ cmd: "mute" })), true);
  assert.equal(errors.length, 2);
  assert.deepEqual([c.paused, c.muted, c.epoch], [true, true, 1]);
  assert.equal(c.handle(ctl({ cmd: "pause" })), true, "handle still returns true and does not throw");
  await new Promise((r) => setTimeout(r, 5));
});

// @spec SHARED-CTRL-007
test("given a heartbeat, the standing detail is `paused` while paused and cleared on resume", async () => {
  const details: (string | undefined)[] = [];
  const heartbeat = { setDetail: (d: string | undefined) => details.push(d) };
  const c = controlFor("cortex", {}, { heartbeat: heartbeat as never });
  await c.handleAsync(ctl({ cmd: "mute" }));
  await c.handleAsync(ctl({ cmd: "pause" }));
  await c.handleAsync(ctl({ cmd: "resume" }));
  assert.deepEqual(details, ["paused", undefined]);
});

// @spec SHARED-CTRL-008
test("only salience, cortex and affect read control, and only through controlFor", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const root = new URL("../../../services/", import.meta.url);
  const users: string[] = [];
  for (const svc of readdirSync(root)) {
    const src = new URL(`${svc}/src/`, root);
    let files: string[] = [];
    try { files = readdirSync(src).filter((f) => f.endsWith(".ts")); } catch { continue; }
    for (const f of files) {
      const text = readFileSync(new URL(f, src), "utf8");
      if (/controlFor\(/.test(text)) users.push(svc);
      if (svc !== "dashboard" && /\.cmd\b/.test(text)) assert.fail(`${svc}/${f} reads control by hand`);
    }
  }
  assert.deepEqual([...new Set(users)].sort(), ["affect", "cortex", "salience"]);
});
