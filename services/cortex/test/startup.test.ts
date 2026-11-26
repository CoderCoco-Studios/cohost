import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatProvider } from "@cohost/llm";
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

// @spec CTX-START-003, CTX-EVT-001, CTX-EVT-008, CTX-EVT-009, CTX-FORGET-001
test("startup: idle, then the cortex group exists (resetGroup), then subscribe at latest, then ready", async () => {
  const w = wiring();
  await w.start();
  assert.deepEqual(w.calls, ["status:idle", "resetGroup:cortex", "subscribe", "ready"]);
  const o = w.opts()!;
  assert.equal(o.group, "cortex");
  assert.equal(o.start, "latest");
  assert.equal("fromNow" in o, false);
  assert.deepEqual([...(o.types as string[])].toSorted(), [
    "affect.state", "attention.focus", "attention.resolve", "brain.clause", "brain.say", "chat.message", "chat.removed", "control",
    "memory.notes.reply", "memory.recall.reply", "memory.viewer", "speech.heard", "tool.catalog", "tool.result", "vision.summary", "voice.done", "voice.failed", "voice.playing", "voice.stop", "voice.utterance",
  ]);
  assert.ok(!(o.types as string[]).includes("speech.partial"), "an interim transcript is not speech to the cortex");
  assert.ok(!(o.types as string[]).includes("speech.early"));
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
  ({ name: "fake", model: "m", chat, complete: async () => { throw new Error("not used"); }, stream: () => { throw new Error("not used"); }, ping: async () => true, lastError: "boom", pingIsNominal: true });

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

test("trackLlm: complete() passes through to the provider untracked", async () => {
  const seen: boolean[] = [];
  const result = { text: "x", toolCalls: [], finish: "stop", message: { role: "assistant", content: "x" } };
  const fake = { ...llmWith(async () => "ok"), complete: async () => result } as unknown as ChatProvider;
  const llm = trackLlm(fake, (ok) => seen.push(ok));
  assert.equal(await llm.complete!([]), result);
  assert.deepEqual(seen, []);
});

const streamWith = (stream: (m: unknown[], o?: { signal?: AbortSignal }) => AsyncGenerator): ChatProvider =>
  ({ ...llmWith(async () => "ok"), stream } as unknown as ChatProvider);

// @spec CTX-HEALTH-003
test("trackLlm: a stream that ends is ok, a stream that throws is down, and the events pass through unchanged", async () => {
  const seen: boolean[] = [];
  let fail = true;
  const llm = trackLlm(streamWith(async function* () {
    yield { type: "text", delta: "x" };
    if (fail) throw new Error("stream broke");
    yield { type: "done", result: {} };
  }), (ok) => seen.push(ok));
  const events: unknown[] = [];
  await assert.rejects((async () => { for await (const e of llm.stream!([])) events.push(e); })(), /stream broke/);
  assert.deepEqual(events, [{ type: "text", delta: "x" }]);
  assert.deepEqual(seen, [false]);
  fail = false;
  const again: unknown[] = [];
  for await (const e of llm.stream!([])) again.push(e);
  assert.deepEqual(again, [{ type: "text", delta: "x" }, { type: "done", result: {} }]);
  assert.deepEqual(seen, [false, true], "ok again after recovery");
});

// @spec CTX-HEALTH-003
test("trackLlm: a stream the consumer abandons, or that stops because cortex aborted it, counts as ok", async () => {
  const seen: boolean[] = [];
  const llm = trackLlm(streamWith(async function* (_m, o) {
    yield { type: "text", delta: "a" };
    yield { type: "text", delta: "b" };
    if (o?.signal?.aborted) throw o.signal.reason;
  }), (ok) => seen.push(ok));
  for await (const _ of llm.stream!([])) break; // cortex stops reading
  assert.deepEqual(seen, [true]);
  const ctl = new AbortController();
  await assert.rejects((async () => { for await (const _ of llm.stream!([], { signal: ctl.signal })) ctl.abort(new Error("aborted by cortex")); })(), /aborted by cortex/);
  assert.deepEqual(seen, [true, true], "a thrown error after cortex aborted is not a failure");
});
