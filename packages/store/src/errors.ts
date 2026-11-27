/**
 * Why the store refused: a damaged file, a store newer than this build, a missing, wrong or exposed master key, a write blocked by
 * another program, settings that fail validation, or a caller's mistake. No message carries a credential, a key or the token
 * (STORE-SET-007).
 */
export type StoreErrorKind = "damaged" | "newer" | "key-missing" | "key-wrong" | "key-mode" | "busy" | "invalid" | "usage";

/** One problem of a value, by its dotted path (`llm.model`, `tools.servers.search.token`). */
export interface StoreIssue { path: string; message: string }

export class StoreError extends Error {
  readonly kind: StoreErrorKind;
  readonly issues: readonly StoreIssue[];
  constructor(kind: StoreErrorKind, message: string, issues: readonly StoreIssue[] = []) {
    super(message);
    this.name = "StoreError";
    this.kind = kind;
    this.issues = issues;
  }
}

/** The message the store gives for a store newer than this build (STORE-DB-004). */
export const NEWER_MESSAGE = "the settings store is newer than this build: update cohost";
