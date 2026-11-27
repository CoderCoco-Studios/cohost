import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, type Logger } from "@cohost/config";
import { readStateFile, writeStateFile } from "@cohost/shared";

/** The user token as twurple hands it to `onRefresh` and takes it in `addUserForToken`. */
export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  obtainmentTimestamp: number;
  scope: string[];
}

/** `<dataDir()>/chat/twitch-token.enc`: chat writes only under its own data directory, encrypted under its state key. */
export const tokenFile = (): string => join(dataDir(), "chat", "twitch-token.enc");

interface TokenFile extends StoredToken { startingRefreshToken: string }

function isTokenFile(x: unknown): x is TokenFile {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.accessToken === "string" && typeof t.refreshToken === "string" && typeof t.startingRefreshToken === "string"
    && (t.expiresIn === null || typeof t.expiresIn === "number")
    && typeof t.obtainmentTimestamp === "number"
    && Array.isArray(t.scope) && t.scope.every((s) => typeof s === "string");
}

// @spec CHAT-TW-012, STORE-STATE-002
/**
 * The stored token, decrypted under the unit's state key, when it was written from the `chat.twitch.refresh_token` that is
 * still current. A missing, undecryptable (one warning naming the file), unreadable or malformed file, one written from a
 * different `chat.twitch.refresh_token` (the operator re-authorised), or no state key, is `undefined`.
 */
export function loadStoredToken(file: string, startingRefreshToken: string, key: Buffer | undefined, log?: Pick<Logger, "warn">): StoredToken | undefined {
  if (!key) return undefined;
  try {
    const text = readStateFile(file, "chat", key, log);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (!isTokenFile(parsed) || parsed.startingRefreshToken !== startingRefreshToken) return undefined;
    const { startingRefreshToken: _from, ...token } = parsed;
    return token;
  } catch {
    return undefined;
  }
}

// @spec CHAT-TW-011, STORE-STATE-002
/**
 * Writes the token encrypted under the unit's state key (temp file, then rename) readable by its owner only; throws when it
 * cannot, or when there is no state key (nothing is written in plaintext).
 */
export function saveStoredToken(file: string, token: StoredToken, startingRefreshToken: string, key: Buffer | undefined): void {
  if (!key) throw new Error("no state key was delivered, so the token is not saved");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body: TokenFile = {
    accessToken: token.accessToken, refreshToken: token.refreshToken, expiresIn: token.expiresIn,
    obtainmentTimestamp: token.obtainmentTimestamp, scope: token.scope, startingRefreshToken,
  };
  writeStateFile(file, "chat", key, JSON.stringify(body));
}
