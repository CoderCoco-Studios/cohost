import type { TokenKind } from "../../state/types";

export const CONTROL_FIND = "grep ^CONTROL_TOKEN= .env";
/** The exact line that adds a viewers token: the installer does not generate one (DASH-ACC-003). */
export const VIEWERS_LINE = 'echo "VIEWERS_TOKEN=$(openssl rand -hex 24)" >> .env';

export const ENV_NAME: Record<TokenKind, string> = { control: "CONTROL_TOKEN", viewers: "VIEWERS_TOKEN" };
export const TOKEN_LABEL: Record<TokenKind, string> = { control: "Control token", viewers: "Viewers token" };
/** What each token unlocks, in words (DASH-ACC-003, DASH-ACC-008). */
export const UNLOCKS: Record<TokenKind, string> = {
  control: "Needed to mute, say lines, save settings, send test inputs and control services.",
  viewers: "Needed to read and edit viewer notes.",
};
