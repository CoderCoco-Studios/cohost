import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { MemoryStore } from "./store.js";
import type { CortexState } from "./scheduler.js";
import { answerViewersRequest, type ViewersAdminStore } from "./admin.js";
import { buildNotesReply, type SurfaceStore } from "./surface.js";

export interface MemoryDeps {
  cfg: Config;
  bus: Publisher;
  log: Logger;
  store: Pick<MemoryStore, "touchViewer" | "touchSpeaker" | "remember" | "recall"> & SurfaceStore;
  /** The store the owner's Viewers-page operations run against; without it `memory.viewers.request` is ignored (MEM-ADMIN-007). */
  admin?: ViewersAdminStore;
  /** Told the cortex's latest `brain.status`, so consolidation runs only while it is idle (MEM-CONSOL-002). */
  onBrainStatus?: (state: CortexState) => void;
  /** Milliseconds since the epoch; injectable so note fade and the sensitive cooldown are testable. */
  clock?: () => number;
}

// @spec MEM-INJ-001, MEM-INJ-002, MEM-INJ-003
/** An injected test input is kept out of memory unless the operator asked to remember it. `remember` means nothing on real events. */
const skipInjected = (d: { injected?: boolean; remember?: boolean }): boolean => d.injected === true && d.remember !== true;

// @spec MEM-EVT-002
/** The memory region's event handler; index.ts subscribes it to both consumer groups. */
export function createMemoryHandler({ cfg, bus, store, admin, log, onBrainStatus, clock = Date.now }: MemoryDeps): (ev: BusEvent) => Promise<void> {
  return async (ev) => {
    switch (ev.type) {
      // @spec MEM-WRITE-001, MEM-VIEWER-001, MEM-VIEWER-002, MEM-REG-005
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        if (skipInjected(d)) break; // no viewer row, no memory.viewer, no memory
        // @spec MEM-VIEWER-006
        const v = await store.touchViewer(d.userId ?? d.user, d.user, { isSub: d.isSub }).catch((err) => {
          log.warn({ err: String(err), user: d.user }, "viewer upsert failed; no memory.viewer for this message");
          return undefined;
        });
        if (d.mentionsCohost) {
          // Announce who this is before the slow embed so the cortex has it when the reply is built.
          if (v) await bus.publish("memory.viewer", { user: d.user, isNew: v.isNew, msgCount: v.msgCount, regular: v.regular });
          await store.remember("chat", d.user, d.text);
        }
        break;
      }
      // @spec MEM-WRITE-002, MEM-VOICE-002
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        if (skipInjected(d)) break;
        // A speaker with a Discord id is a viewer who can accrue notes; a label with no id (an injected clip) is not.
        if (d.speakerId) {
          await store.touchSpeaker(d.speakerId, d.speaker).catch((err) => {
            log.warn({ err: String(err), speaker: d.speaker }, "speaker upsert failed; the utterance is still remembered");
          });
        }
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
      // @spec MEM-CONSOL-002, MEM-CONSOL-003
      case "brain.status": {
        onBrainStatus?.((ev.data as BusEvent<"brain.status">["data"]).state);
        break;
      }
      // @spec MEM-ADMIN-007
      case "memory.viewers.request": {
        if (!admin) break;
        const d = ev.data as BusEvent<"memory.viewers.request">["data"];
        await bus.publish("memory.viewers.reply", { id: d.id, ...(await answerViewersRequest(admin, cfg.brain.memory.notes, d)) });
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
      // @spec MEM-SURF-001, MEM-SURF-005
      case "memory.notes.request": {
        const d = ev.data as BusEvent<"memory.notes.request">["data"];
        const viewers = await buildNotesReply(store, cfg.brain.memory, d.users, clock()).catch((err) => {
          // Neither the names nor any note text go in the log.
          log.warn({ err: String(err) }, "reading viewer notes failed; answering with none");
          return [];
        });
        await bus.publish("memory.notes.reply", { id: d.id, viewers });
        break;
      }
    }
  };
}
