import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatProvider, type ChatMessage, type ChatProvider } from "@cohost/llm";
import { TRANSCRIPT_TAGS } from "@cohost/working-memory";
import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import { FakeBus, event, silentLog, testConfig } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

/** The stop list the real provider sends for a reply: capture it off the wire (the list is not exported). */
async function providerStops(provider: "ollama" | "openai"): Promise<string[]> {
  const cfg = testConfig({ llm: { provider } });
  const realFetch = globalThis.fetch;
  let body: { stop?: string[]; options?: { stop?: string[] } } = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    body = JSON.parse(init!.body!);
    const json = provider === "ollama" ? { message: { content: "x" } } : { choices: [{ message: { content: "x" } }] };
    return new Response(JSON.stringify(json), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await createChatProvider(cfg.llm).chat([{ role: "user", content: "hi" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
  return (provider === "ollama" ? body.options?.stop : body.stop) ?? [];
}

// @spec CTX-PROMPT-008
test("every other-speaker transcript line starts with a provider stop tag; the co-host's own line matches none", async () => {
  const cfg = testConfig({ brain: { memory: { recall_k: 0 } } });
  const sent: ChatMessage[][] = [];
  const llm: ChatProvider = { name: "fake", model: "fake", chat: async (m) => { sent.push(m); return "[happy] hi"; }, ping: async () => true };
  const critic = new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: () => ({ ok: true }) }, silentLog);
  const cortex = new Cortex({ cfg, bus: new FakeBus(), llm, critic, log: silentLog, loadPersonality: () => "You are Coco." });
  await cortex.onEvent(event("chat.message", { platform: "twitch", user: "bob", text: "hello", isMod: true, isSub: false, mentionsCohost: false }));
  await cortex.onEvent(event("speech.heard", { speaker: "chris", text: "hey there", durationMs: 800 }));
  await cortex.onEvent(event("vision.summary", { text: "a boss fight", changed: true }));
  await cortex.onEvent(event("brain.say", { id: "own", text: "earlier line", emotion: "smug" }, "cortex"));
  await cortex.think({ reason: "idle chatter", score: 0 });

  const lines = sent[0]![1]!.content.split("\n").filter((l) => /^(\[chat\]|\[voice\]|\[screen\]|Coco:)/.test(l));
  assert.equal(lines.length, 4, lines.join(" | "));
  const [chat, voice, screen, own] = lines as [string, string, string, string];

  for (const provider of ["ollama", "openai"] as const) {
    const stops = await providerStops(provider);
    const transcriptStops = stops.filter((s) => s.startsWith("\n["));
    assert.ok(transcriptStops.length > 0, `${provider} sends transcript stops`);
    // A stop fires on "\n" + line start, so a line is another speaker's when "\n" + line begins with a stop.
    const stopsOn = (line: string) => stops.some((s) => `\n${line}`.startsWith(s));
    for (const line of [chat, voice, screen]) assert.ok(stopsOn(line), `${provider}: ${line} begins with a stop tag`);
    assert.equal(stopsOn(own), false, `${provider}: the co-host's own line is not a stop`);
    assert.deepEqual(transcriptStops.map((s) => s.slice(1)).sort(), [...TRANSCRIPT_TAGS].sort());
  }
});
