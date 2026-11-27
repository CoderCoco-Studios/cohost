/**
 * reflect — run after a stream (`mise run reflect`, which runs it through the unit runner as the memory unit).
 *
 * Reads everything remembered since the last reflection, asks the LLM what
 * the co-host should carry forward, and appends it to the "## Learned"
 * section of the personality, through the personality outbox that the unit runner applies to the settings store. This is how
 * the personality drifts over time instead of resetting every stream.
 */
import { loadPersonality, writePersonalityOutbox } from "@cohost/config";
import { createChatProvider } from "@cohost/llm";
import { createMemoryEmbedder, createStore } from "./backend.js";
import { runReflectCommand } from "./reflect-run.js";
import { startOneShot } from "./oneshot.js";

// @spec MEM-START-007
const { log, cfg } = await startOneShot("reflect");
const llm = createChatProvider(cfg.llm);
const memory = createStore(cfg, createMemoryEmbedder(cfg), log);

// The personality is read from the projection; the new text goes to the outbox with the hash of the text read, and the unit
// runner (or the next dashboard start) writes it into the settings store (settings-store STORE-OUT-001, STORE-OUT-002).
let read: string | undefined;
const fromProjection = (): string => (read = loadPersonality());
// @spec STORE-OUT-001, MEM-REFLECT-007
const toOutbox = (text: string): void => { writePersonalityOutbox(read ?? fromProjection(), text); };
await runReflectCommand({ cfg, llm, memory, log, loadPersonality: fromProjection, savePersonality: toOutbox, now: () => new Date() });
