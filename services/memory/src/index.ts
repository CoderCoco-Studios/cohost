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
 * Consolidation ("sleep") is reflect.ts, run between streams. Viewer notes are
 * tidied by a pass (consolidation.ts) the scheduler starts when enough notes are
 * dirty, while the cortex is idle; consolidate.ts runs one after shutdown.
 */
import { runMemory } from "./main.js";

void runMemory(); // the shared bootstrap logs a fatal error and exits 1 (MEM-START-006)
