/**
 * cortex — the language region (prefrontal + Broca's, if you like).
 *
 * The only region that calls the chat LLM. It keeps its own working memory
 * of the conversation and waits to be told what to do:
 *   - salience says `attention.focus`  → think, then publish `brain.say`
 *   - memory answers `memory.recall.reply` and volunteers `memory.viewer`
 *   - affect says `affect.state`        → colours the prompt
 *   - the operator says `control`       → mute / say / reload personality
 *
 * It does not decide *whether* to speak and it does not remember anything
 * past the window — those are other regions' jobs. If the memory region is
 * down it simply answers without recall.
 */
import { randomUUID } from "node:crypto";
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig, loadPersonality, type Emotion } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { Context } from "@cohost/working-memory";
import { buildMessages, parseReply, type Focus, type Mood, type Recalled } from "./prompt.js";
import { createCritic } from "./critic.js";

const log = createLogger("cortex");
const cfg = loadConfig();
const bus = new Bus("cortex", log);
const llm = createChatProvider(cfg.llm);
const ctx = new Context(cfg.brain.working_memory_events);
const critic = createCritic(cfg, log);

let personality = loadPersonality();
let muted = false;
let thinking = false;
let speakingId: string | undefined;
let speakingSince = 0;
let mood: Mood | undefined;
let viewerNote: string | undefined;
const pendingRecall = new Map<string, (m: Recalled) => void>();

async function main() {
  while (!(await llm.ping())) {
    log.warn({ provider: llm.name }, "waiting for the model backend...");
    await sleep(3000);
  }
  await status("idle");
  void bus.subscribe(
    {
      group: "cortex",
      types: [
        "chat.message", "speech.heard", "vision.summary", "brain.say", "voice.done",
        "attention.focus", "memory.recall.reply", "memory.viewer", "affect.state", "control",
      ],
      fromNow: true,
    },
    onEvent,
  );
  log.info({ provider: llm.name, model: llm.model, critic: critic.kind, name: cfg.cohost.name }, "cortex online");
}

async function onEvent(ev: BusEvent) {
  switch (ev.type) {
    case "chat.message":
    case "speech.heard":
    case "vision.summary":
      ctx.push(ev);
      break;
    case "brain.say": {
      // Our own lines and anyone else's (reflexes, operator) all land in the transcript.
      const d = ev.data as BusEvent<"brain.say">["data"];
      ctx.pushSelf(d.text, d.emotion);
      if (ev.source !== "cortex") { speakingId = d.id; speakingSince = Date.now(); }
      break;
    }
    case "voice.done": {
      const d = ev.data as BusEvent<"voice.done">["data"];
      if (d.id === speakingId) { speakingId = undefined; await status(muted ? "muted" : "idle"); }
      break;
    }
    case "attention.focus":
      // Don't await: the LLM call must not block the subscription loop, or the
      // memory reply we're waiting on could never be delivered.
      void think(ev.data as Focus);
      break;
    case "memory.recall.reply": {
      const d = ev.data as BusEvent<"memory.recall.reply">["data"];
      pendingRecall.get(d.id)?.(d.memories);
      break;
    }
    case "memory.viewer": {
      const d = ev.data as BusEvent<"memory.viewer">["data"];
      viewerNote = d.isNew
        ? `${d.user} is new here (first message).`
        : d.msgCount > 25
          ? `${d.user} is a regular (${d.msgCount} messages).${d.notes ? " Notes: " + d.notes : ""}`
          : undefined;
      break;
    }
    case "affect.state":
      mood = ev.data as Mood;
      break;
    case "control": {
      const d = ev.data as BusEvent<"control">["data"];
      if (d.cmd === "mute") { muted = true; await status("muted"); }
      if (d.cmd === "unmute") { muted = false; await status("idle"); }
      if (d.cmd === "forget_context") { ctx.clear(); viewerNote = undefined; }
      if (d.cmd === "reload_personality") { personality = loadPersonality(); log.info("personality reloaded"); }
      if (d.cmd === "say" && d.text) await say(d.text, "neutral", undefined, "operator");
      break;
    }
  }
}

async function think(focus: Focus) {
  if (thinking) return;
  // Salience assumes we're busy once it fires; if we're not going to act, tell it so.
  if (muted) { await status("muted"); return; }
  if (speakingId && Date.now() - speakingSince > cfg.brain.cortex.speaking_timeout_ms) speakingId = undefined;
  if (speakingId) { await status("speaking"); return; }

  thinking = true;
  await status("thinking", focus.reason);
  try {
    const query = focus.focus?.text ?? ctx.lastVision;
    const memories = query ? await recall(query) : [];
    const messages = buildMessages({ cfg, personality, ctx, memories, focus, mood, viewerNote });
    const t0 = Date.now();
    const raw = await llm.chat(messages);
    let { text, emotion, gesture } = parseReply(raw);
    log.info({ ms: Date.now() - t0, reason: focus.reason, memories: memories.length, raw }, "llm reply");
    viewerNote = undefined;
    if (!text || text.length < 2) { await status("idle"); return; }
    // Inhibition: let the critic veto or touch up the line before it's spoken.
    const verdict = await critic.run({ text, emotion: emotion as Emotion, reason: focus.reason, transcript: ctx.transcript(cfg.cohost.name) });
    if (!verdict.ok) { log.info({ note: verdict.note, text }, "critic vetoed"); await status("idle"); return; }
    if (verdict.text) { log.info({ from: text, to: verdict.text }, "critic rewrote"); text = verdict.text; }
    if (verdict.emotion) emotion = verdict.emotion;
    await say(text, emotion as Emotion, gesture, focus.reason);
  } catch (err) {
    log.error({ err }, "think failed");
    await status("idle");
  } finally {
    thinking = false;
  }
}

/** Ask the memory region over the bus; give up gracefully if it doesn't answer. */
function recall(query: string): Promise<Recalled> {
  if (cfg.brain.memory.recall_k <= 0) return Promise.resolve([]);
  const id = randomUUID();
  return new Promise<Recalled>((resolve) => {
    const timer = setTimeout(() => { pendingRecall.delete(id); log.warn("memory region did not answer in time"); resolve([]); }, cfg.brain.cortex.recall_timeout_ms);
    pendingRecall.set(id, (m) => { clearTimeout(timer); pendingRecall.delete(id); resolve(m); });
    void bus.publish("memory.recall.request", { id, query, k: cfg.brain.memory.recall_k }).catch(() => {
      clearTimeout(timer); pendingRecall.delete(id); resolve([]);
    });
  });
}

async function say(text: string, emotion: Emotion, gesture: string | undefined, reason: string) {
  const id = randomUUID();
  speakingId = id;
  speakingSince = Date.now();
  await bus.publish("brain.say", { id, text, emotion, gesture, reason });
  await status("speaking", text);
}

async function status(state: "idle" | "thinking" | "speaking" | "muted", detail?: string) {
  await bus.publish("brain.status", { state, detail });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
