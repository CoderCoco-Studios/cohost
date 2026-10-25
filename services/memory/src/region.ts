import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config } from "@cohost/config";
import type { MemoryStore } from "./store.js";

export interface MemoryDeps {
  cfg: Config;
  bus: Publisher;
  store: Pick<MemoryStore, "touchViewer" | "remember" | "recall">;
}

/** An injected test input is kept out of memory unless the operator asked to remember it. `remember` means nothing on real events. */
const skipInjected = (d: { injected?: boolean; remember?: boolean }): boolean => d.injected === true && d.remember !== true;

/** The memory region's event handler; index.ts subscribes it to both consumer groups. */
export function createMemoryHandler({ cfg, bus, store }: MemoryDeps): (ev: BusEvent) => Promise<void> {
  return async (ev) => {
    switch (ev.type) {
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        if (skipInjected(d)) break; // no viewer row, no memory.viewer, no memory
        const v = await store.touchViewer(d.userId ?? d.user, d.user);
        if (d.mentionsCohost) {
          // Announce who this is before the slow embed so the cortex has it when the reply is built.
          await bus.publish("memory.viewer", { user: d.user, isNew: v.isNew, msgCount: v.msgCount, notes: v.notes });
          await store.remember("chat", d.user, d.text);
        }
        break;
      }
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        if (skipInjected(d)) break;
        await store.remember("speech", d.speaker, d.text);
        break;
      }
      case "brain.say": {
        const d = ev.data as BusEvent<"brain.say">["data"];
        if (skipInjected(d)) break; // a reply to an injected input
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
  };
}
