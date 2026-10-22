/**
 * memory — the hippocampus. The only region that touches Postgres.
 *
 * Writes: everything that addresses the co-host, everything said in voice,
 * and everything the co-host says itself gets embedded and stored. Viewers
 * get a row so regulars are recognised.
 *
 * Reads: answers `memory.recall.request` with `memory.recall.reply`, and
 * announces `memory.viewer` when someone who addressed the co-host is new
 * or a regular. The cortex is the usual caller, but any region may ask.
 *
 * Consolidation ("sleep") is reflect.ts, run between streams.
 */
import { Bus, onShutdown, type BusEvent } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { Ollama } from "@cohost/llm";
import { MemoryStore } from "./store.js";

const log = createLogger("memory");
const cfg = loadConfig();
const bus = new Bus("memory", log);
const llm = new Ollama(cfg.llm);
const store = new MemoryStore(llm, cfg.brain.memory, log);

async function main() {
  while (!(await llm.ping())) {
    log.warn("waiting for ollama (embeddings)...");
    await sleep(3000);
  }
  for (let attempt = 1; ; attempt++) {
    try { await store.init(); break; }
    catch (err) {
      if (attempt > 20) throw err;
      log.warn({ err: String(err) }, "postgres not ready, retrying in 3s");
      await sleep(3000);
    }
  }
  void bus.subscribe(
    { group: "memory", types: ["chat.message", "speech.heard", "brain.say", "memory.recall.request"], fromNow: true },
    onEvent,
  );
  log.info({ recall_k: cfg.brain.memory.recall_k }, "memory online");
}

async function onEvent(ev: BusEvent) {
  switch (ev.type) {
    case "chat.message": {
      const d = ev.data as BusEvent<"chat.message">["data"];
      const v = await store.touchViewer(d.userId ?? d.user, d.user);
      if (d.mentionsCohost) {
        await store.remember("chat", d.user, d.text);
        await bus.publish("memory.viewer", { user: d.user, isNew: v.isNew, msgCount: v.msgCount, notes: v.notes });
      }
      break;
    }
    case "speech.heard": {
      const d = ev.data as BusEvent<"speech.heard">["data"];
      await store.remember("speech", d.speaker, d.text);
      break;
    }
    case "brain.say": {
      const d = ev.data as BusEvent<"brain.say">["data"];
      if (d.text.length >= 2) await store.remember("self", cfg.cohost.name, d.text);
      break;
    }
    case "memory.recall.request": {
      const d = ev.data as BusEvent<"memory.recall.request">["data"];
      const memories = await store.recall(d.query, d.k);
      await bus.publish("memory.recall.reply", {
        id: d.id,
        memories: memories.map((m) => ({ ts: m.ts.getTime(), kind: m.kind, who: m.who, text: m.text, similarity: m.similarity })),
      });
      break;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
onShutdown(async () => { bus.stop(); await store.close(); });
