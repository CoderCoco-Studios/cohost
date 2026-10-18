/**
 * brain — the orchestrator. Reads everything on the bus, keeps a rolling
 * context, decides when to talk, asks the LLM what to say, and publishes
 * `brain.say`. Long-term memory lives in Postgres via memory.ts.
 */
import { randomUUID } from "node:crypto";
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig, loadPersonality, type Emotion } from "@cohost/config";
import { Ollama } from "./llm.js";
import { MemoryStore } from "./memory.js";
import { Context } from "./context.js";
import { Scheduler } from "./scheduler.js";
import { buildMessages, parseReply } from "./prompt.js";

const log = createLogger("brain");
const cfg = loadConfig();
const bus = new Bus("brain", log);
const llm = new Ollama(cfg.llm);
const memory = new MemoryStore(llm, cfg.brain.memory, log);
const ctx = new Context(cfg.brain.max_context_events);
const scheduler = new Scheduler(cfg.brain);

let personality = loadPersonality();
let muted = false;
let speakingId: string | undefined;
let speakingSince = 0;
let thinking = false;
let lastViewerNote: string | undefined;

async function main() {
  while (!(await llm.ping())) {
    log.warn("waiting for ollama...");
    await sleep(3000);
  }
  for (let attempt = 1; ; attempt++) {
    try { await memory.init(); break; }
    catch (err) {
      if (attempt > 20) throw err;
      log.warn({ err: String(err) }, "postgres not ready, retrying in 3s");
      await sleep(3000);
    }
  }
  await status("idle");

  // Ingest.
  void bus.subscribe(
    { group: "brain", types: ["chat.message", "vision.summary", "speech.heard", "control", "voice.done"], fromNow: true },
    onEvent,
  );

  // Think on a timer, not on every event — batching is what keeps it from being spammy.
  setInterval(() => void tick(), cfg.brain.tick_ms);
  log.info({ model: cfg.llm.model, name: cfg.cohost.name }, "brain online");
}

async function onEvent(ev: BusEvent) {
  switch (ev.type) {
    case "chat.message": {
      const d = ev.data as BusEvent<"chat.message">["data"];
      ctx.push(ev);
      scheduler.noteActivity();
      const v = await memory.touchViewer(d.userId ?? d.user, d.user);
      if (d.mentionsCohost) {
        await memory.remember("chat", d.user, d.text);
        lastViewerNote = v.isNew
          ? `${d.user} is new here (first message).`
          : v.msgCount > 25
            ? `${d.user} is a regular (${v.msgCount} messages).${v.notes ? " Notes: " + v.notes : ""}`
            : undefined;
      }
      break;
    }
    case "speech.heard": {
      const d = ev.data as BusEvent<"speech.heard">["data"];
      ctx.push(ev);
      scheduler.noteActivity();
      await memory.remember("speech", d.speaker, d.text);
      break;
    }
    case "vision.summary":
      ctx.push(ev);
      break;
    case "voice.done": {
      const d = ev.data as BusEvent<"voice.done">["data"];
      if (d.id === speakingId) { speakingId = undefined; await status("idle"); }
      break;
    }
    case "control": {
      const d = ev.data as BusEvent<"control">["data"];
      if (d.cmd === "mute") { muted = true; await status("muted"); }
      if (d.cmd === "unmute") { muted = false; await status("idle"); }
      if (d.cmd === "forget_context") ctx.clear();
      if (d.cmd === "reload_personality") { personality = loadPersonality(); log.info("personality reloaded"); }
      if (d.cmd === "say" && d.text) await say(d.text, "neutral", undefined, "operator");
      break;
    }
  }
}

async function tick() {
  if (thinking) return;
  // Safety valve: if voice never reports done (e.g. no sink attached), don't stay stuck.
  if (speakingId && Date.now() - speakingSince > 20_000) speakingId = undefined;

  const decision = scheduler.decide(ctx, !!speakingId, muted);
  if (!decision.speak) return;

  thinking = true;
  await status("thinking", decision.reason);
  try {
    const focusText = decision.focus && "text" in decision.focus ? decision.focus.text : ctx.lastVision;
    const memories = focusText ? await memory.recall(focusText) : [];
    const messages = buildMessages({ cfg, personality, ctx, memories, decision, viewerNote: lastViewerNote });
    const t0 = Date.now();
    const raw = await llm.chat(messages);
    const { text, emotion, gesture } = parseReply(raw);
    log.info({ ms: Date.now() - t0, reason: decision.reason, raw }, "llm reply");
    ctx.markSeen();
    lastViewerNote = undefined;
    if (!text || text.length < 2) { await status("idle"); return; }
    await say(text, emotion as Emotion, gesture, decision.reason);
    await memory.remember("self", cfg.cohost.name, text);
  } catch (err) {
    log.error({ err }, "tick failed");
    await status("idle");
  } finally {
    thinking = false;
  }
}

async function say(text: string, emotion: Emotion, gesture: string | undefined, reason: string) {
  const id = randomUUID();
  speakingId = id;
  speakingSince = Date.now();
  scheduler.noteSpoke();
  ctx.pushSelf(text, emotion);
  await bus.publish("brain.say", { id, text, emotion, gesture, reason });
  await status("speaking", text);
}

async function status(state: "idle" | "thinking" | "speaking" | "muted", detail?: string) {
  await bus.publish("brain.status", { state, detail });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); await memory.close(); });
