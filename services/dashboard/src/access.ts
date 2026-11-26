import { bearerOk } from "@cohost/control";

/**
 * Who must present the control token. `required` is true exactly when the full surface is bound to a non-loopback address:
 * the token is for requests from another machine, and on loopback no route asks for it (DASH-CTRL-011). `token` is the
 * configured control token (`CONTROL_TOKEN`), undefined when none is.
 */
export interface TokenGate {
  required: boolean;
  token: string | undefined;
}

/** Why a request is refused for the control token: none configured where one is required, or the request's is missing or wrong. */
export type TokenRefusal = "none" | "wrong";

/**
 * The one rule every route the control token gates applies, in normal mode and in config recovery mode: no refusal while the
 * token is not required (its `Authorization` header is then ignored); otherwise `none` when no token is configured (startup
 * keeps that from arising, DASH-CTRL-010) and `wrong` when the header is missing or does not match in constant time.
 */
// @spec DASH-CTRL-011, DASH-CTRL-010
export function tokenRefusal(gate: TokenGate, authorization: string | undefined): TokenRefusal | undefined {
  if (!gate.required) return undefined;
  if (gate.token === undefined) return "none";
  return bearerOk(authorization, gate.token) ? undefined : "wrong";
}

/** The detail of a refusal for want of a configured control token; it names the two settings an operator needs (DASH-CTRL-010). */
export const NO_TOKEN_DETAIL = "this needs the control token, and none is configured: set CONTROL_TOKEN in .env with CONTROL_ENABLED=1 and restart the dashboard";

