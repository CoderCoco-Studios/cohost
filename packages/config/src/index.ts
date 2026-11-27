
export * from "./schema.js";
export {
  unknownKeys, parseConfigText, coerceEmptyNumbers, ISOLATION_OVERRIDES, ISOLATION_ENV, encodeIsolation, decodeIsolation, isolationOverriddenKeys,
  type ConfigIssue, type ParsedConfigText, type SecretValues, type IsolationName, type IsolationOverrides,
} from "./pipeline.js";
export { updateSecrets, secretRepair } from "./secrets.js";
export { setConfigLogger } from "./diag.js";
export { ConfigError, type ConfigProblem, type ConfigProblemKind } from "./errors.js";
export { writeFileAtomic } from "./atomic.js";
export { ollamaModels, type OllamaModels } from "./models.js";
export * from "./editor.js";
export * from "./presentation.js";
export * from "./egress.js";
export { findWorkspaceRoot, configDir, dataDir, dotEnvPath, loadDotEnv } from "./paths.js";
export {
  createLogger, configLogger, loggingSettings, setLoggingSource, redact, resetLoggingForTest, type Logger, type CreateLoggerOptions, type TerminalOut, type LoggingSource,
} from "./logging.js";
export { formatPretty, escapeTerminal } from "./log-pretty.js";
export { UNIT_SETTINGS, unitSettings, unitsReadingSection, type UnitSettings, type DocumentName } from "./units.js";
export {
  loadConfig, loadPersonality, loadExpressions, earsListenerVerifier, readProjection, resetConfigCache, PROJECTION_FILE, PROJECTION_FORMAT, EARS_VERIFIER_PATH,
  type Projection, type LoadOptions,
} from "./projection.js";
export { OLLAMA_MODEL_SECTIONS } from "./models.js";
export {
  loadConfigFile, checkConfig, ensureFromExample, personalityPath, loadPersonalityFile, savePersonality, loadExpressionsFile, secretsPath, setSecretPaths,
} from "./files.js";
export { outboxPath, writePersonalityOutbox, readPersonalityOutbox, sha256Hex, type PersonalityOutbox } from "./outbox.js";
/**
 * The YAML reader and writer of this package, for `@cohost/store`'s export and import, which depends on no package outside the
 * workspace (settings-store STORE-PKG-002).
 */
export { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Required env var, throws a readable error if missing. */
// @spec CFG-ENV-007
export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (set it in .env)`);
  return v;
}
export function envOr(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// @spec CFG-URL-001, CFG-URL-002
export const urls = {
  redis: () => envOr("REDIS_URL", "redis://127.0.0.1:6379"),
  database: () => envOr("DATABASE_URL", "postgres://cohost:cohost@127.0.0.1:5432/cohost"),
  ollama: () => envOr("OLLAMA_URL", "http://127.0.0.1:11434"),
  tts: () => envOr("TTS_URL", "http://127.0.0.1:8880"),
  stt: () => envOr("STT_URL", "http://127.0.0.1:8000"),
  /** Voice's public base URL; loopback by default, compose overrides with `http://voice:8700`. */
  voice: () => envOr("VOICE_URL", `http://127.0.0.1:${envOr("VOICE_PORT", "8700")}`),
};
