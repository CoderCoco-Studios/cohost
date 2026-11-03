import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { MemoryStore } from "./store.js";

export interface MemoryDeps {
  cfg: Config;
  bus: Publisher;
  log: Logger;
  store: Pick<MemoryStore, "touchViewer" | "remember" | "recall">;
}

// @spec MEM-INJ-001, MEM-INJ-002, MEM-INJ-003
/** An injected test input is kept out of memory unless the operator asked to remember it. `remember` means nothing on real events. */
const skipInjected = (d: { injected?: boolean; remember?: boolean }): boolean => d.injected === true && d.remember !== true;

// @spec MEM-EVT-002
/** The memory region's event handler; index.ts subscribes it to both consumer groups. */
export function createMemoryHandler({ cfg, bus, store, log }: MemoryDeps): (ev: BusEvent) => Promise<void> {
  return async (ev) => {
    switch (ev.type) {
      // @spec MEM-WRITE-001, MEM-VIEWER-001, MEM-VIEWER-002, MEM-VIEWER-004
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        if (skipInjected(d)) break; // no viewer row, no memory.viewer, no memory
        // @spec MEM-VIEWER-006
        const v = await store.touchViewer(d.userId ?? d.user, d.user).catch((err) => {
          log.warn({ err: String(err), user: d.user }, "viewer upsert failed; no memory.viewer for this message");
          return undefined;
        });
        if (d.mentionsCohost) {
          // Announce who this is before the slow embed so the cortex has it when the reply is built.
          if (v) await bus.publish("memory.viewer", { user: d.user, isNew: v.isNew, msgCount: v.msgCount, notes: v.notes });
          await store.remember("chat", d.user, d.text);
        }
        break;
      }
      // @spec MEM-WRITE-002
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        if (skipInjected(d)) break;
        await store.remember("speech", d.speaker, d.text);
        break;
      }
      // @spec MEM-WRITE-003
      case "brain.say": {
        const d = ev.data as BusEvent<"brain.say">["data"];
        if (skipInjected(d)) break; // a reply to an injected input
        if (d.text.length >= 2) await store.remember("self", cfg.cohost.name, d.text);
        break;
      }
      // @spec MEM-RECALL-001
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
