/**
 * `@cohost/store`: the settings store (docs/intent/settings-store/). Imported only by the dashboard, `@cohost/control` and the
 * package's own task entry points (STORE-PKG-001).
 */
export {
  openStore, restoreBackup, checkStore, moveDamagedAside, peekStore, listBackups, dailyBackup, sectionOf, splitSettings, assembleSettings, Store, SCHEMA_VERSION, PERSONALITY_MAX_BYTES,
  BUSY_TIMEOUT_MS, BUSY_RETRY_MS, SEED_FILES,
  type StoreOptions, type StoreChange, type WriteOptions, type WriteResult, type StoreProblem, type StorePeek, type BackupFile,
} from "./store.js";
export { StoreError, NEWER_MESSAGE, type StoreErrorKind, type StoreIssue } from "./errors.js";
export { keyFilePath, storeFile, storeDir, backupDir } from "./paths.js";
export { KEY_PREFIX, formatKey, parseKey, keyId, type NoticeOut } from "./keys.js";
export {
  BearerChecker, MIN_TOKEN_LENGTH, TOKEN_SCRYPT, EARS_LISTENER_LABEL, earsListenerKey, generateToken, makeVerifier, parseVerifier,
  type BearerResult, type TokenVerifier,
} from "./token.js";
export {
  exportStore, readExport, readParts, openSecrets, planChange, importPlan, importToStore, EXPORT_SCRYPT, MIN_PASSPHRASE_LENGTH,
  type ExportSecrets, type ImportPlan, type ImportParts, type ImportSummary,
} from "./codec.js";
export { applyPersonalityOutbox, type OutboxResult, type OutboxStore } from "./outbox.js";
export {
  writeProjections, projectionOf, projectedUnits, personalityUnits, projectionsDir, projectionDir, MODELS_PROJECTION, type ProjectionUnit,
} from "./project.js";
export { credentialsMessage, messageText, pocketToken, getsMessage, MAX_MESSAGE_BYTES, POCKET_TOKEN_PATH, type CredentialsMessage } from "./deliver.js";
export { processIo, type CliIo } from "./cli/io.js";
