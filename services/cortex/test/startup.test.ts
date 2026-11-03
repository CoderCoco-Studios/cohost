import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatProvider } from "@cohost/llm";
import { silentLog } from "@cohost/testing";
import { startCortex, trackLlm } from "../src/startup.js";

function wiring(over: { resetGroup?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  let subscribed: Record<string, unknown> | undefined;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`resetGroup:${g}`); await over.resetGroup?.(); },
    subscribe: async (opts: Record<string, unknown>) => { calls.push("subscribe"); subscribed = opts; },
  };
  const cortex = { status: async (s: string) => { calls.push(`status:${s}`); }, onEvent: async () => {} };
  const heartbeat = { ready: () => { calls.push("ready"); } };
  const fatals: unknown[] = [];
  const start = () => startCortex({ bus: bus as never, cortex: cortex as never, heartbeat, onFatal: (e) => fatals.push(e) });
  return { calls, start, fatals, opts: () => subscribed };
}

// @spec CTX-START-003, CTX-EVT-001
test("startup: idle, then the cortex group exists (resetGroup), then subscribe at latest, then ready", async () => {
  const w = wiring();
  await w.start();
  assert.deepEqual(w.calls, ["status:idle", "resetGroup:cortex", "subscribe", "ready"]);
  const o = w.opts()!;
  assert.equal(o.group, "cortex");
  assert.equal(o.start, "latest");
  assert.equal("fromNow" in o, false);
  assert.deepEqual([...(o.types as string[])].sort(), [
    "affect.state", "attention.focus", "brain.say", "chat.message", "control",
    "memory.recall.reply", "memory.viewer", "speech.heard", "vision.summary", "voice.done",
  ]);
});

// @spec CTX-START-003
test("startup: ready waits for the group; a failed resetGroup never reports ready", async () => {
  let release!: () => void;
  const w = wiring({ resetGroup: () => new Promise<void>((r) => { release = r; }) });
  const started = w.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(w.calls, ["status:idle", "resetGroup:cortex"]);
  release();
  await started;
  assert.equal(w.calls.at(-1), "ready");

  const bad = wiring({ resetGroup: async () => { throw new Error("redis down"); } });
  await assert.rejects(bad.start(), /redis down/);
  assert.ok(!bad.calls.includes("ready"));
});

const llmWith = (chat: () => Promise<string>): ChatProvider =>
  ({ name: "fake", model: "m", chat, ping: async () => true, lastError: "boom", pingIsNominal: true });

// @spec CTX-HEALTH-003
test("trackLlm: every chat outcome feeds the dependency: failure down, success ok again", async () => {
  const seen: boolean[] = [];
  let fail = true;
  const llm = trackLlm(llmWith(async () => { if (fail) throw new Error("no answer"); return "[happy] hi"; }), (ok) => seen.push(ok));
  await assert.rejects(llm.chat([]), /no answer/);
  fail = false;
  assert.equal(await llm.chat([]), "[happy] hi");
  assert.deepEqual(seen, [false, true]);
  assert.deepEqual([llm.name, llm.model, llm.lastError, llm.pingIsNominal, await llm.ping()], ["fake", "m", "boom", true, true]);
});
