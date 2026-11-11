import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@cohost/config";

/** The user token as twurple hands it to `onRefresh` and takes it in `addUserForToken`. */
export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number | null;
  obtainmentTimestamp: number;
  scope: string[];
}

/** `<dataDir()>/chat/twitch-token.json`: chat writes only under its own data directory. */
export const tokenFile = (): string => join(dataDir(), "chat", "twitch-token.json");

interface TokenFile extends StoredToken { envRefreshToken: string }

function isTokenFile(x: unknown): x is TokenFile {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return typeof t.accessToken === "string" && typeof t.refreshToken === "string" && typeof t.envRefreshToken === "string"
    && (t.expiresIn === null || typeof t.expiresIn === "number")
    && typeof t.obtainmentTimestamp === "number"
    && Array.isArray(t.scope) && t.scope.every((s) => typeof s === "string");
}

// @spec CHAT-TW-012
/**
 * The stored token, when it was written from the `.env` refresh token that is still current. A missing, unreadable or
 * malformed file, or one written from a different `.env` refresh token (the operator re-authorised), is `undefined`.
 */
export function loadStoredToken(file: string, envRefreshToken: string): StoredToken | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isTokenFile(parsed) || parsed.envRefreshToken !== envRefreshToken) return undefined;
    const { envRefreshToken: _from, ...token } = parsed;
    return token;
  } catch {
    return undefined;
  }
}

// @spec CHAT-TW-011
/** Write the token (temp file, then rename) readable by its owner only; throws when it cannot. */
export function saveStoredToken(file: string, token: StoredToken, envRefreshToken: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const body: TokenFile = {
    accessToken: token.accessToken, refreshToken: token.refreshToken, expiresIn: token.expiresIn,
    obtainmentTimestamp: token.obtainmentTimestamp, scope: token.scope, envRefreshToken,
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  renameSync(tmp, file);
}
