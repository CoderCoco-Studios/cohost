/**
 * reflect — run after a stream (`pnpm reflect` or
 * `docker compose run --rm brain node dist/reflect.js`).
 *
 * Reads everything remembered since the last reflection, asks the LLM what
 * the co-host should carry forward, and appends it to the "## Learned"
 * section of personality.md. This is how the personality drifts over time
 * instead of resetting every stream. Edit the file by hand whenever you like.
 */
import { createLogger, loadConfig, loadPersonality, savePersonality } from "@cohost/config";
import { Ollama } from "./llm.js";
import { MemoryStore } from "./memory.js";

const log = createLogger("reflect");
const cfg = loadConfig();
const llm = new Ollama(cfg.llm);
const memory = new MemoryStore(llm, cfg.brain.memory, log);

async function main() {
  await memory.init();
  const since = new Date((await memory.getMeta("last_reflection")) ?? "1970-01-01");
  const rows = await memory.recentSince(since, 600);
  if (rows.length < 5) {
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

  const bullets = raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
  if (bullets.length === 0) { log.warn({ raw }, "no bullets produced"); return; }

  const stamp = new Date().toISOString().slice(0, 10);
  const addition = `\n### ${stamp}\n${bullets.join("\n")}\n`;
  const marker = "## Learned";
  const idx = personality.indexOf(marker);
  const updated = idx === -1 ? `${personality.trimEnd()}\n\n${marker}\n${addition}` : `${personality.trimEnd()}\n${addition}`;
  savePersonality(updated);
  await memory.setMeta("last_reflection", new Date().toISOString());
  log.info({ bullets: bullets.length }, "personality updated");
  console.log(addition);
}

main()
  .catch((err) => { log.error({ err }, "reflect failed"); process.exitCode = 1; })
  .finally(() => memory.close());
