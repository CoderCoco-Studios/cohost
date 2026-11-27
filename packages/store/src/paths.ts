import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dataDir } from "@cohost/config";
import { StoreError } from "./errors.js";

/** The store's directory, `<dataDir()>/store` (STORE-DB-002). */
export const storeDir = (data: string = dataDir()): string => join(data, "store");
/** The database file, `<dataDir()>/store/cohost.db`. */
export const storeFile = (data: string = dataDir()): string => join(storeDir(data), "cohost.db");
/** Where backups go, `<dataDir()>/store/backups` (STORE-DB-008). */
export const backupDir = (data: string = dataDir()): string => join(storeDir(data), "backups");

/**
 * The master key file (STORE-KEY-001): `COHOST_KEY_FILE` when set and non-empty, else `$XDG_CONFIG_HOME/cohost/master.key`
 * when that is set and non-empty, else `.config/cohost/master.key` under the home directory. Outside the checkout on purpose,
 * so a copy of the checkout, of `data/` or of a backup carries no key. Under the test environment (`COHOST_TEST_ENV` set) there
 * is no default: resolving one throws.
 */
// @spec STORE-KEY-001
export function keyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COHOST_KEY_FILE;
  if (override) return resolve(override);
  const xdg = env.XDG_CONFIG_HOME;
  const fallback = join(xdg ? resolve(xdg) : join(homedir(), ".config"), "cohost", "master.key");
  // The test environment (scripts/test-env.sh) has no default key path: a test that got here would read or create the
  // owner's key file, so it fails instead (deployment DEPLOY-TOOL-022).
  if (env.COHOST_TEST_ENV) {
    throw new StoreError("usage", `COHOST_TEST_ENV is set but COHOST_KEY_FILE is not: refusing the default key file ${fallback}; a test must point COHOST_KEY_FILE at a temporary file`);
  }
  return fallback;
}

/** A UTC timestamp as `yyyymmddThhmmssZ`, the suffix of backups and of a damaged store moved aside. */
export function stamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
