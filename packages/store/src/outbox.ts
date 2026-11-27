import { unlinkSync } from "node:fs";
import { dataDir, outboxPath, readPersonalityOutbox, sha256Hex } from "@cohost/config";
import type { Store } from "./store.js";

/** What applying the reflection outbox did: nothing to apply, applied, or kept because the personality changed. */
export type OutboxResult =
  | { applied: false; reason: "none" }
  | { applied: true; revision: number }
  | { applied: false; reason: "conflict" | "invalid"; message: string };

/**
 * Applies the reflection pass's outbox (STORE-OUT-002): when the SHA-256 of the stored personality equals the outbox's `base`,
 * writes its `text` as the `personality` document and deletes the outbox; otherwise keeps the outbox and reports why. The
 * caller (the unit runner after `reflect`, the dashboard at its start) logs the message and rewrites the personality
 * projections after an apply.
 */
// @spec STORE-OUT-002
export function applyPersonalityOutbox(store: Store, data: string = dataDir()): OutboxResult {
  const outbox = readPersonalityOutbox(data);
  if (outbox === undefined) return { applied: false, reason: "none" };
  const current = store.personality() ?? "";
  if (sha256Hex(current) !== outbox.base) {
    return { applied: false, reason: "conflict", message: `the reflection's block in ${outboxPath(data)} was not applied because the personality changed after the pass read it` };
  }
  const result = store.write({ personality: outbox.text });
  if (!result.ok) {
    const why = "conflict" in result && result.conflict ? "the store changed during the write" : result.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    return { applied: false, reason: "invalid", message: `the reflection's block in ${outboxPath(data)} was not applied: ${why}` };
  }
  unlinkSync(outboxPath(data));
  return { applied: true, revision: result.revision };
}
