/**
 * affect — the mood region (limbic system).
 *
 * Reads the same senses as everyone else and keeps a running valence/arousal
 * state that drifts back to baseline on its own. Publishes `affect.state` so:
 *   - the avatar can wear a resting expression between lines,
 *   - the cortex can colour its reply with the current mood,
 *   - salience can get chattier when things are exciting.
 * No LLM, no database — it's a couple of numbers and a half-life.
 */
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { Mood } from "./mood.js";
import { createAppraiser } from "./appraise.js";

const log = createLogger("affect");
const cfg = loadConfig();
const bus = new Bus("affect", log);
const mood = new Mood(cfg.brain.affect);
const appraiser = createAppraiser(cfg, log);

let lastPublished = "";
let lastPublishedAt = 0;

async function main() {
  void bus.subscribe(
    { group: "affect", types: ["chat.message", "speech.heard", "vision.summary", "brain.say", "control"], fromNow: true },
    onEvent,
  );
  setInterval(publish, cfg.brain.affect.publish_ms);
  log.info({ half_life_ms: cfg.brain.affect.half_life_ms, appraiser: appraiser.kind }, "affect online");
}

async function onEvent(ev: BusEvent) {
  switch (ev.type) {
    case "chat.message": {
      const d = ev.data as BusEvent<"chat.message">["data"];
      await appraise("chat", d.user, d.text, d.mentionsCohost);
      if (d.isSub) mood.nudge(0.05, 0.05, `sub: ${d.user}`);
      break;
    }
    case "speech.heard": {
      const d = ev.data as BusEvent<"speech.heard">["data"];
      await appraise("speech", d.speaker, d.text, false);
      break;
    }
    case "vision.summary": {
      const d = ev.data as BusEvent<"vision.summary">["data"];
      if (d.changed) mood.nudge(0, 0.08, "screen changed");
      break;
    }
    case "brain.say": {
      // Saying something emotional reinforces the mood a little (and talking is arousing).
      const d = ev.data as BusEvent<"brain.say">["data"];
      const dv = ["happy", "laugh", "smug"].includes(d.emotion) ? 0.08 : ["sad", "angry"].includes(d.emotion) ? -0.08 : 0;
      mood.nudge(dv, 0.05, `said: ${d.emotion}`);
      break;
    }
    case "control": {
      const d = ev.data as BusEvent<"control">["data"];
      if (d.cmd === "forget_context") { mood.nudge(cfg.brain.affect.baseline_valence - mood.valence, 0.1 - mood.arousal, "reset"); }
      break;
    }
  }
}

async function appraise(source: "chat" | "speech", who: string, text: string, mention: boolean) {
  mood.tick();
  const out = await appraiser.run({ source, who, text, mention, valence: mood.valence, arousal: mood.arousal });
  mood.applyAppraisal(out, `${source === "speech" ? "voice" : "chat"}: ${who}`);
}

function publish() {
  mood.tick();
  const s = mood.state();
  const key = `${s.mood}:${s.valence.toFixed(2)}:${s.arousal.toFixed(2)}`;
  const now = Date.now();
  // Only publish when it moved, plus a heartbeat so late joiners get a value.
  if (key === lastPublished && now - lastPublishedAt < 15_000) return;
  lastPublished = key;
  lastPublishedAt = now;
  void bus.publish("affect.state", s);
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); });
