import type { TokenKind } from "../../state/types";

/** Sets a new control token and prints it once (settings-store STORE-TOK-001). */
export const CONTROL_NEW = "mise run config:token";

export const ENV_NAME: Record<TokenKind, string> = { control: "CONTROL_TOKEN" };
export const TOKEN_LABEL: Record<TokenKind, string> = { control: "Control token" };
/** What the token unlocks, in words (DASH-ACC-003, DASH-ACC-008). */
export const UNLOCKS: Record<TokenKind, string> = {
  control: "Needed to mute, say lines, save settings, send test inputs, control services, and read and edit viewer notes.",
};
