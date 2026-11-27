import { linkSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dataDir, outboxPath, readPersonalityOutbox, sha256Hex } from "@cohost/config";
import type { Store } from "./store.js";

/** What applying the reflection outbox did: nothing to apply, applied, or kept and why. */
export type OutboxResult =
  | { applied: false; reason: "none" }
  | { applied: true; revision: number }
  | { applied: false; reason: "conflict" | "invalid"; message: string };

/** The part of the store the applier uses. */
export type OutboxStore = Pick<Store, "revision" | "personality" | "write">;

/**
 * Applies the reflection pass's outbox (STORE-OUT-002). It first claims the outbox by renaming it to a private name, so an
 * outbox a later pass writes meanwhile is a new file this call never deletes. It takes the store revision before reading the
 * personality, and writes the outbox's `text` as the `personality` document only when the SHA-256 of that personality equals
 * the outbox's `base` and the revision is still the one it took; then it deletes the claimed file. Otherwise it puts the claimed
 * outbox back (unless a newer one took its place) and reports why: `conflict` when the personality or the store changed,
 * `invalid` when the outbox is not `{base, text}` or the write is refused. The caller (the unit runner after `reflect`, the
 * dashboard at its start) logs the message and rewrites the personality projections after an apply.
 */
// @spec STORE-OUT-002
export function applyPersonalityOutbox(store: OutboxStore, data: string = dataDir()): OutboxResult {
  const file = outboxPath(data);
  const claimed = `${file}.applying-${process.pid}-${randomBytes(4).toString("hex")}`;
  const revision = store.revision();
  try {
    renameSync(file, claimed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { applied: false, reason: "none" };
    throw e;
  }
  /** Puts the claimed outbox back where a newer one has not been written; a newer one supersedes it. */
  const giveBack = (): void => {
    try { linkSync(claimed, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    unlinkSync(claimed);
  };
  let outbox;
  try {
    outbox = readPersonalityOutbox(data, claimed)!;
  } catch (e) {
    giveBack();
    return { applied: false, reason: "invalid", message: `the reflection's block in ${file} was not applied: ${(e as Error).message}` };
  }
  const current = store.personality() ?? "";
  if (sha256Hex(current) !== outbox.base) {
    giveBack();
    return { applied: false, reason: "conflict", message: `the reflection's block in ${file} was not applied because the personality changed after the pass read it` };
  }
  const result = store.write({ personality: outbox.text }, { expectedRevision: revision });
  if (!result.ok) {
    giveBack();
    if ("conflict" in result && result.conflict) {
      return { applied: false, reason: "conflict", message: `the reflection's block in ${file} was not applied because the settings store changed while it was applied; it is kept for the next try` };
    }
    return { applied: false, reason: "invalid", message: `the reflection's block in ${file} was not applied: ${result.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}` };
  }
  unlinkSync(claimed);
  return { applied: true, revision: result.revision };
}
