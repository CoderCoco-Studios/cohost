import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { MemoryStore } from "./store.js";
import type { CortexState } from "./scheduler.js";
import { answerViewersRequest, type ViewersAdminStore } from "./admin.js";
import { buildNotesReply, type SurfaceStore } from "./surface.js";
import { boundText, UNKNOWN_NAME, viewerKey } from "@cohost/shared/untrusted";
import { intakeName, textLimits } from "./limits.js";

export interface MemoryDeps {
  cfg: Config;
  bus: Publisher;
  log: Logger;
  store: Pick<MemoryStore, "touchViewer" | "touchSpeaker" | "remember" | "forgetChat" | "recall"> & SurfaceStore;
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

/** A streamed line held open until it closes (MEM-WRITE-010..019); `skipInjected` is the decision its `brain.say` made. */
interface OpenLine { text: string; lastSeq: number; skipInjected: boolean; lastRead: number }

/** A streamed line with no clause for this long is written and closed (MEM-WRITE-015). */
const LINE_IDLE_MS = 300_000;
/** How often the idle check runs while any line is open; the bound is LINE_IDLE_MS, so the check is at most this late. */
const SWEEP_MS = 1000;

/** The memory handler: the bus event handler, plus `stop` which writes every open streamed line (MEM-WRITE-016). */
export type MemoryHandler = ((ev: BusEvent) => Promise<void>) & { stop(): Promise<void> };

// @spec MEM-EVT-002
/** The memory region's event handler; index.ts subscribes it to both consumer groups. */
export function createMemoryHandler({ cfg, bus, store, admin, log, onBrainStatus, clock = Date.now }: MemoryDeps): MemoryHandler {
  // The streamed lines still open, in the order they opened; memory keeps them in memory only (MEM-WRITE-017).
  const open = new Map<string, OpenLine>();
  let sweep: ReturnType<typeof setInterval> | undefined;

  // @spec MEM-WRITE-013, MEM-WRITE-019
  const writeLine = async (line: OpenLine): Promise<void> => {
    if (line.skipInjected || line.text.length < 2) return;
    await store.remember("self", cfg.cohost.name, line.text).catch((err) => {
      log.warn({ err: String(err) }, "writing a streamed line failed; the line is lost");
    });
  };
  const stopSweep = (): void => {
    if (sweep !== undefined) clearInterval(sweep);
    sweep = undefined;
  };
  const startSweep = (): void => {
    if (sweep !== undefined) return;
    sweep = setInterval(() => {
      void sweepIdle().catch((err) => log.warn({ err: String(err) }, "idle streamed-line check failed"));
    }, SWEEP_MS);
    (sweep as { unref?: () => void }).unref?.(); // the bus keeps the process alive; this timer must not
  };
  const closeLine = async (id: string): Promise<void> => {
    const line = open.get(id);
    if (!line) return;
    open.delete(id);
    if (open.size === 0) stopSweep();
    await writeLine(line);
  };
  const closeAll = async (): Promise<void> => {
    for (const id of [...open.keys()]) await closeLine(id);
  };
  // @spec MEM-WRITE-015
  const sweepIdle = async (): Promise<void> => {
    const now = clock();
    for (const [id, line] of [...open]) if (now - line.lastRead >= LINE_IDLE_MS) await closeLine(id);
  };

  const handler = async (ev: BusEvent): Promise<void> => {
    switch (ev.type) {
      // @spec MEM-WRITE-001, MEM-WRITE-006, MEM-WRITE-008, MEM-WRITE-009, MEM-VIEWER-001, MEM-VIEWER-002, MEM-VIEWER-007, MEM-VIEWER-008, MEM-VIEWER-009, MEM-VIEWER-010, MEM-REG-005
      case "chat.message": {
        const d = ev.data as BusEvent<"chat.message">["data"];
        if (skipInjected(d)) break; // no viewer row, no memory.viewer, no memory
        const lim = textLimits(cfg);
        const user = intakeName(d.user, lim.nameMax);
        const text = boundText(d.text, lim.chatMax);
        // @spec MEM-VIEWER-007
        // A nameless viewer with no id is no viewer: no row and no announcement (the memory row is still written when addressed).
        const nameless = !d.userId && user === UNKNOWN_NAME;
        // @spec MEM-VIEWER-006
        // @spec MEM-VIEWER-008, MEM-VIEWER-009
        const key = viewerKey({ platform: d.platform, userId: d.userId, user });
        const v = nameless ? undefined : await store.touchViewer(key, user, { isSub: d.isSub }).catch((err) => {
          log.warn({ err: String(err), user }, "viewer upsert failed; no memory.viewer for this message");
          return undefined;
        });
        if (d.mentionsCohost) {
          // Announce who this is before the slow embed so the cortex has it when the reply is built.
          if (v) await bus.publish("memory.viewer", { user, platform: d.platform, ...(d.userId ? { userId: d.userId } : {}), isNew: v.isNew, msgCount: v.msgCount, regular: v.regular });
          await store.remember("chat", user, text, { platform: d.platform, userId: d.userId, messageId: d.messageId });
        }
        break;
      }
      // @spec MEM-FORGET-001, MEM-FORGET-002, MEM-FORGET-003, MEM-FORGET-004, MEM-FORGET-005, MEM-FORGET-006, MEM-FORGET-007
      case "chat.removed": {
        const d = ev.data as BusEvent<"chat.removed">["data"];
        await store.forgetChat(d).catch((err) => {
          log.warn({ err: String(err), platform: d.platform, scope: d.scope }, "forgetting removed chat failed; the stored lines stay");
        });
        break;
      }
      // @spec MEM-WRITE-002, MEM-WRITE-007, MEM-WRITE-008, MEM-VOICE-002
      case "speech.heard": {
        const d = ev.data as BusEvent<"speech.heard">["data"];
        if (skipInjected(d)) break;
        const lim = textLimits(cfg);
        const speaker = intakeName(d.speaker, lim.nameMax);
        // A speaker with a Discord id is a viewer who can accrue notes; a label with no id (an injected clip) is not.
        if (d.speakerId) {
          await store.touchSpeaker(d.speakerId, speaker).catch((err) => {
            log.warn({ err: String(err), speaker }, "speaker upsert failed; the utterance is still remembered");
          });
        }
        await store.remember("speech", speaker, boundText(d.text, lim.speechMax));
        break;
      }
      // @spec MEM-WRITE-003, MEM-WRITE-010
      case "brain.say": {
        const d = ev.data as BusEvent<"brain.say">["data"];
        if (d.more) {
          // A streamed line opens now and is written when it closes (MEM-WRITE-013..015).
          if (open.has(d.id)) {
            log.warn({ id: d.id }, "a streamed line opened twice; the second opening is dropped");
            break;
          }
          open.set(d.id, { text: d.text, lastSeq: 0, skipInjected: skipInjected(d), lastRead: clock() });
          startSweep();
          break;
        }
        if (skipInjected(d)) break; // a reply to an injected input
        if (d.text.length >= 2) await store.remember("self", cfg.cohost.name, d.text);
        break;
      }
      // @spec MEM-WRITE-011, MEM-WRITE-012, MEM-WRITE-013
      case "brain.clause": {
        const d = ev.data as BusEvent<"brain.clause">["data"];
        const line = open.get(d.id);
        if (!line) break; // no open line (not opened, closed, or lost at a restart): dropped (MEM-WRITE-012, MEM-WRITE-017)
        if (d.seq !== line.lastSeq + 1) {
          log.warn({ id: d.id, seq: d.seq, expected: line.lastSeq + 1 }, "streamed clause out of order; dropped");
          break;
        }
        line.lastSeq = d.seq;
        line.lastRead = clock();
        if (d.text !== "") line.text = line.text === "" ? d.text : `${line.text} ${d.text}`;
        if (d.last) await closeLine(d.id);
        break;
      }
      // @spec MEM-CONSOL-002, MEM-CONSOL-003, MEM-WRITE-014, MEM-WRITE-018
      case "brain.status": {
        const state = (ev.data as BusEvent<"brain.status">["data"]).state;
        onBrainStatus?.(state);
        if (state === "idle" || state === "muted") await closeAll();
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
        const viewers = await buildNotesReply(store, cfg.brain.memory, d.viewers, clock()).catch((err) => {
          // Neither the names nor any note text go in the log.
          log.warn({ err: String(err) }, "reading viewer notes failed; answering with none");
          return [];
        });
        await bus.publish("memory.notes.reply", { id: d.id, viewers });
        break;
      }
    }
  };
  return Object.assign(handler, {
    // @spec MEM-WRITE-016
    stop: async (): Promise<void> => {
      stopSweep();
      await closeAll();
    },
  });
}
