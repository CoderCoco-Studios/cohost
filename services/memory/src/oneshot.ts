/**
 * The start of the memory one-shots (`consolidate`, `reembed`, `reflect`): they run as the `memory` unit, so they receive the
 * memory unit's credentials message before they load the configuration from its projection (settings-store STORE-DLV-004).
 * They never open the bus, so a one-shot that waits for its message says so once in its log instead of in a heartbeat.
 */
import { createLogger, loadConfig, type Config, type Logger } from "@cohost/config";
import { CREDENTIALS_FD_ENV, WAITING_FOR_CREDENTIALS, receiveCredentials } from "@cohost/shared";

/**
 * The one-shot's logger and configuration. A message that is refused, or a configuration that does not load, is logged through
 * the one-shot's own logger and ends the process with status 1, before any store is opened or model called (MEM-START-007).
 */
// @spec MEM-START-007, STORE-DLV-004
export async function startOneShot(name: string): Promise<{ log: Logger; cfg: Config }> {
  const log = createLogger(name);
  let cfg: Config;
  try {
    if (!process.env[CREDENTIALS_FD_ENV]) log.info(WAITING_FOR_CREDENTIALS);
    const { credentials } = await receiveCredentials("memory", { log });
    cfg = loadConfig({ credentials, unit: "memory" });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err)); // no store opened, no model called
    process.exit(1);
  }
  return { log, cfg };
}
