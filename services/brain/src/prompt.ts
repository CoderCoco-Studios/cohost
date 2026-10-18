import { EMOTIONS, type Config } from "@cohost/config";
import type { ChatMessage } from "./llm.js";
import type { Memory } from "./memory.js";
import type { Context, ContextEvent } from "./context.js";
import type { Decision } from "./scheduler.js";

export function buildMessages(opts: {
  cfg: Config;
  personality: string;
  ctx: Context;
  memories: Memory[];
  decision: Decision;
  viewerNote?: string;
}): ChatMessage[] {
  const { cfg, personality, ctx, memories, decision, viewerNote } = opts;
  const now = new Date().toLocaleString("en-US", { timeZone: cfg.cohost.timezone });

  const memBlock = memories.length
    ? `\n## Things you remember (older, may be from past streams)\n${memories
        .map((m) => `- (${m.ts.toISOString().slice(0, 10)}) ${m.who}: ${m.text}`)
        .join("\n")}\n`
    : "";

  const system = [
    personality.trim(),
    "",
    `## Now\n- Local time: ${now}\n- Streamer: ${cfg.cohost.streamer}\n- Your name: ${cfg.cohost.name}`,
    ctx.lastVision ? `- On screen right now: ${ctx.lastVision}` : "",
    viewerNote ? `- ${viewerNote}` : "",
    memBlock,
    `## Output\nReply with ONE short spoken line, starting with an emotion tag from: ${EMOTIONS.map((e) => `[${e}]`).join(" ")}. ` +
      `Optionally add [gesture:name] after the tag. No other brackets, no quotes, no narration.`,
  ]
    .filter(Boolean)
    .join("\n");

  const transcript = ctx.transcript(cfg.cohost.name);
  const nudge = describeFocus(decision, cfg.cohost.name);

  return [
    { role: "system", content: system },
    { role: "user", content: `## Recent transcript\n${transcript || "(quiet)"}\n\n${nudge}` },
  ];
}

function describeFocus(d: Decision, name: string): string {
  const f: ContextEvent | undefined = d.focus;
  if (d.reason === "idle chatter") return `It's been quiet. Say something natural about what's going on, or don't force it — a short aside is fine. ${name}:`;
  if (!f) return `${name}:`;
  if (f.kind === "chat" && f.mention) return `${f.user} is talking to you. Answer them directly. ${name}:`;
  if (f.kind === "speech") return `${f.speaker} just said that out loud. React like you're in the room. ${name}:`;
  if (f.kind === "chat") return `Respond to the chat above if there's something worth saying. ${name}:`;
  if (f.kind === "vision") return `Something changed on screen. Comment only if it's interesting. ${name}:`;
  return `${name}:`;
}

const TAG = /^\s*\[(\w+)\]\s*(?:\[gesture:([\w-]+)\]\s*)?/i;

export function parseReply(raw: string): { text: string; emotion: string; gesture?: string } {
  let text = (raw.trim().split("\n")[0] ?? "").replace(/^[\w ]{1,20}:\s*(?=\[)/, "");
  let emotion = "neutral";
  let gesture: string | undefined;
  const m = TAG.exec(text);
  if (m) {
    emotion = (m[1] ?? "neutral").toLowerCase();
    gesture = m[2]?.toLowerCase();
    text = text.slice(m[0].length);
  }
  // Strip anything the model shouldn't have emitted: stray tags, quotes, "Name:" prefixes.
  text = text.replace(/\[[^\]]*\]/g, "").replace(/^["'“”]+|["'“”]+$/g, "").replace(/^\w+:\s*/, "").trim();
  if (!(EMOTIONS as readonly string[]).includes(emotion)) emotion = "neutral";
  return { text, emotion, gesture };
}
