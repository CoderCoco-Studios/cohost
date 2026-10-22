/**
 * salience — the attention region (think amygdala + salience network).
 *
 * Watches every sense on the bus, keeps its own short working memory, and
 * decides *when* the co-host should speak. It never talks to the LLM: when
 * something is worth a response it publishes `attention.focus` and the cortex
 * takes it from there. It also owns the reflex fast path — canned reactions
 * that go straight to `brain.say` without waiting for anyone to think.
 *
 * Inputs it listens to from other regions: `affect.state` (an excited mood
 * lowers the bar to speak), `brain.status` / `brain.say` (don't pile on while
 * the cortex is thinking or the voice is still playing).
 */
import { randomUUID } from "node:crypto";
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { Context } from "@cohost/working-memory";
import { Scheduler } from "./scheduler.js";
import { Reflexes, type Sense } from "./reflex.js";

const log = createLogger("salience");
const cfg = loadConfig();
const bus = new Bus("salience", log);
const ctx = new Context(cfg.brain.working_memory_events);
const scheduler = new Scheduler(cfg.brain.salience);
const reflexes = new Reflexes(cfg.brain.salience.reflexes);

let muted = false;
let arousal = 0;
/** What the cortex / voice are up to, as last reported on the bus. */
let cortexState: "idle" | "thinking" | "speaking" | "muted" = "idle";
let cortexSince = Date.now();

async function main() {
  void bus.subscribe(
    {
      group: "salience",
      types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "brain.status", "affect.state", "control"],
      fromNow: true,
    },
    onEvent,
  );
  setInterval(() => void tick(), cfg.brain.salience.tick_ms);
  log.info({ reflexes: reflexes.size, threshold: cfg.brain.salience.speak_threshold }, "salience online");
}

async function onEvent(ev: BusEvent) {
  switch (ev.type) {
    case "chat.message": {
      const d = ev.data as BusEvent<"chat.message">["data"];
      ctx.push(ev);
      scheduler.noteActivity();
      await reflex("chat", d.text);
      break;
    }
    case "speech.heard": {
      const d = ev.data as BusEvent<"speech.heard">["data"];
      ctx.push(ev);
      scheduler.noteActivity();
      await reflex("speech", d.text);
      break;
    }
    case "vision.summary": {
      const d = ev.data as BusEvent<"vision.summary">["data"];
      ctx.push(ev);
      if (d.changed) await reflex("vision", d.text);
      break;
    }
    case "brain.say":
      // Whoever spoke (cortex, a reflex, the operator), the cooldown starts now.
      scheduler.noteSpoke();
      cortexState = "speaking";
      cortexSince = Date.now();
      break;
    case "brain.status": {
      const d = ev.data as BusEvent<"brain.status">["data"];
      cortexState = d.state;
      cortexSince = Date.now();
      break;
    }
    case "affect.state":
      arousal = (ev.data as BusEvent<"affect.state">["data"]).arousal;
      break;
    case "control": {
      const d = ev.data as BusEvent<"control">["data"];
      if (d.cmd === "mute") muted = true;
      if (d.cmd === "unmute") muted = false;
      if (d.cmd === "forget_context") ctx.clear();
      break;
    }
  }
}

/** Fast path. Fires immediately, bypassing the scheduler and the LLM. */
async function reflex(sense: Sense, text: string) {
  if (muted || reflexes.size === 0) return;
  const hit = reflexes.test(sense, text);
  if (!hit) return;
  log.info({ rule: hit.rule, sense }, "reflex");
  ctx.markSeen(); // the thing that triggered it has been "handled"
  await bus.publish("brain.say", { id: randomUUID(), text: hit.text, emotion: hit.emotion, gesture: hit.gesture, reason: `reflex: ${hit.rule}` });
}

function busy(): boolean {
  const age = Date.now() - cortexSince;
  // Safety valves: a cortex that never reports back, or a voice sink that never says done.
  if (cortexState === "thinking") return age < 60_000;
  if (cortexState === "speaking") return age < cfg.brain.cortex.speaking_timeout_ms;
  return false;
}

async function tick() {
  const decision = scheduler.decide(ctx, busy(), muted, arousal);
  if (!decision.speak) return;
  ctx.markSeen();
  // Optimistically treat the cortex as busy until it reports; stops double-firing on the next tick.
  cortexState = "thinking";
  cortexSince = Date.now();
  const f = decision.focus;
  await bus.publish("attention.focus", {
    reason: decision.reason,
    score: decision.score,
    focus:
      f?.kind === "chat" ? { kind: "chat", who: f.user, text: f.text, mention: f.mention }
      : f?.kind === "speech" ? { kind: "speech", who: f.speaker, text: f.text }
      : f?.kind === "vision" ? { kind: "vision", text: f.text }
      : undefined,
  });
  log.debug({ reason: decision.reason, score: decision.score }, "focus");
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
