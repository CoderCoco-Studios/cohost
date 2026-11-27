/**
 * The credentials message of a unit (settings-store STORE-DLV-002): what the control plane hands a started unit in memory, never
 * on disk, through `docker exec -i` into the container's `tmpfs` or a pipe to a host-run program. Built here because only the
 * store can decrypt; carried by `@cohost/control`.
 */
import { EARS_VERIFIER_PATH, UNIT_SETTINGS, secretPathMatches, type UnitSettings } from "@cohost/config";
import type { Store } from "./store.js";

/** The largest message a unit accepts, bytes (STORE-DLV-002; `@cohost/shared` refuses a larger one). */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** The credential the `tts-pocket` container receives as `/run/cohost/hf_token` (STORE-DLV-006). */
export const POCKET_TOKEN_PATH = "voice.pocket.hf_token";

/** A unit's credentials message (STORE-DLV-002). */
export interface CredentialsMessage {
  format: 1;
  unit: string;
  revision: number;
  credentials: Record<string, string>;
  state_key?: string;
}

/** Whether `unit` gets a credentials message: it declares a secret path or a state key (STORE-DLV-002). */
export function getsMessage(unit: Pick<UnitSettings, "secrets" | "stateKey">): boolean {
  return unit.secrets.length > 0 || unit.stateKey;
}

/**
 * The message of `unit`, or undefined for a unit that declares no secret path and no state key. `credentials` holds each
 * declared secret path the store holds (the wildcard expanded to the servers of the stored `tools` section, a token of a server
 * the section no longer holds left out), plus `ears.http.verifier` from `keys.ears-listener` for `ears` alone; `state_key` is
 * the unit's state key, created when absent (STORE-STATE-001), for a unit whose entry sets `stateKey`.
 */
// @spec STORE-DLV-002, STORE-STATE-001
export function credentialsMessage(store: Store, unitId: string, units: readonly UnitSettings[] = UNIT_SETTINGS): CredentialsMessage | undefined {
  const unit = units.find((u) => u.id === unitId);
  if (unit === undefined || !getsMessage(unit)) return undefined;
  const stateKey = unit.stateKey ? store.stateKey(unit.id) : undefined;
  return store.snapshot(() => {
    const servers = Object.keys(((store.settingsTree().tools as { servers?: unknown } | undefined)?.servers ?? {}) as Record<string, unknown>);
    const credentials: Record<string, string> = {};
    for (const path of store.secretPaths()) {
      if (!unit.secrets.some((p) => secretPathMatches(path, p))) continue;
      const server = /^tools\.servers\.([^.]+)\.token$/.exec(path)?.[1];
      if (server !== undefined && !servers.includes(server)) continue;
      const value = store.secret(path);
      if (value !== undefined && value !== "") credentials[path] = value;
    }
    if (unit.id === "ears") {
      const key = store.earsListenerKey();
      if (key !== undefined) credentials[EARS_VERIFIER_PATH] = key;
    }
    return { format: 1 as const, unit: unit.id, revision: store.revision(), credentials, ...(stateKey ? { state_key: stateKey.toString("base64url") } : {}) };
  });
}

/** The message's text, refused when it is larger than `MAX_MESSAGE_BYTES` (the error names the unit, never a value). */
export function messageText(message: CredentialsMessage): string {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) throw new Error(`the credentials message of ${message.unit} is larger than ${MAX_MESSAGE_BYTES} bytes`);
  return text;
}

/** The Pocket engine's token (STORE-DLV-006): `voice.pocket.hf_token`, or the empty string when the store holds none. */
// @spec STORE-DLV-006
export function pocketToken(store: Store): string {
  return store.secret(POCKET_TOKEN_PATH) ?? "";
}
