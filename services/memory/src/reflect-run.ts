import type { Config, Logger } from "@cohost/config";
import type { ChatProvider } from "@cohost/llm";
import { formatCursor, parseCursor } from "./cursor.js";
import { appendLearned, learnedBlock, parseBullets } from "./learned.js";
import type { MemoryBackend } from "./store.js";

/** Everything one reflection pass touches, injected so the pass can be tested (reflect.ts wires the real ones). */
export interface ReflectDeps {
  cfg: Config;
  llm: Pick<ChatProvider, "name" | "chat">;
  memory: MemoryBackend;
  log: Logger;
  loadPersonality: () => string;
  savePersonality: (text: string) => void;
  now: () => Date;
  print?: (text: string) => void;
}

const BATCH = 600;
const MIN_ROWS = 5;

// @spec MEM-REFLECT-011, MEM-REFLECT-012, MEM-REFLECT-001, MEM-REFLECT-002, MEM-REFLECT-003, MEM-REFLECT-004, MEM-REFLECT-006, MEM-REFLECT-007, MEM-REFLECT-008, MEM-REFLECT-010, LLM-MOCK-005
/** One reflection pass: read up to 600 memories after the cursor, ask the LLM for bullets, save them under `## Learned`, advance the cursor. */
export async function runReflect({ cfg, llm, memory, log, loadPersonality, savePersonality, now, print = console.log }: ReflectDeps): Promise<void> {
  if (llm.name === "mock") log.warn({ provider: llm.name }, "reflect is using the mock chat backend: the Learned bullets are canned text, not a real reflection");
  if (cfg.brain.memory.store === "memory") {
    log.warn("brain.memory.store is memory: nothing persists between processes, so there is nothing to reflect on");
    return;
  }
  // Reflection only reads rows and the cursor: no schema work and no embedder (MEM-REFLECT-011).
  await memory.connect();
  // The consolidation lock is shared with the live service's passes and the consolidate one-shot, so reflection never
  // overlaps them (MEM-REFLECT-012); a held lock ends the run and the unmoved cursor makes the next run catch up.
  const locked = await memory.withConsolidationLock(() => reflectOnce({ cfg, llm, memory, log, loadPersonality, savePersonality, now, print }));
  if (!locked.ran) log.warn("another memory pass holds the consolidation lock: reflection skipped, run it again later");
}

async function reflectOnce({ cfg, llm, memory, log, loadPersonality, savePersonality, now, print = console.log }: ReflectDeps): Promise<void> {
  const cursor = parseCursor(await memory.getMeta("last_reflection"));
  const rows = await memory.recentSince(cursor, BATCH);
  if (rows.length < MIN_ROWS) {
    // The cursor stays put, so these rows are read again in a later pass together with the ones that arrive.
    log.info({ count: rows.length }, "not enough new memories to reflect on");
    return;
  }
  const transcript = rows.map((r) => `${r.who}: ${r.text}`).join("\n");
  const personality = loadPersonality();

  const raw = await llm.chat(
    [
      {
        role: "system",
        content:
          `You are ${cfg.cohost.name}, reflecting after a stream. Below is your current personality file and ` +
          `a transcript of things you and chat said. Write 3-6 short bullet points of durable things worth ` +
          `remembering for future streams: running jokes, regulars and what they're like, opinions you formed, ` +
          `things ${cfg.cohost.streamer} likes or hates. Be concrete. Output only the bullets, each starting with "- ".`,
      },
      { role: "user", content: `## Personality\n${personality}\n\n## Transcript\n${transcript}` },
    ],
    { maxTokens: 400, temperature: 0.5 },
  );

  const bullets = parseBullets(raw);
  if (bullets.length === 0) { log.warn({ raw }, "no bullets produced"); return; }

  const addition = learnedBlock(bullets, now().toISOString().slice(0, 10));
  savePersonality(appendLearned(personality, addition));
  const last = rows[rows.length - 1]!;
  await memory.setMeta("last_reflection", formatCursor({ ts: last.tsText ?? last.ts.toISOString(), id: Number(last.id) }));
  log.info({ bullets: bullets.length, read: rows.length }, "personality updated");
  print(addition);
}
