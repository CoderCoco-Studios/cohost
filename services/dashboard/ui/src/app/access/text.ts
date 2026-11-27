import type { TokenKind } from "../../state/types";

export const CONTROL_FIND = "grep ^CONTROL_TOKEN= .env";
/** The exact line that adds a control token to a dashboard started without one (DASH-ACC-009). */
export const CONTROL_LINE = 'echo "CONTROL_TOKEN=$(openssl rand -hex 24)" >> .env';

export const ENV_NAME: Record<TokenKind, string> = { control: "CONTROL_TOKEN" };
export const TOKEN_LABEL: Record<TokenKind, string> = { control: "Control token" };
/** What the token unlocks, in words (DASH-ACC-003, DASH-ACC-008). */
export const UNLOCKS: Record<TokenKind, string> = {
  control: "Needed to mute, say lines, save settings, send test inputs, control services, and read and edit viewer notes.",
};
