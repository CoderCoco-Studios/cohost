import type { Api } from "../../state/api";
import type { TokenKind } from "../../state/types";

export type CheckOutcome =
  | { kind: "accepted" }
  | { kind: "rejected" }
  /** The dashboard has no such token configured (`403`): store nothing and say what to set. */
  | { kind: "not-set-up" }
  /** Anything else (a network error, a `5xx`, a `403` from the Host or Origin check): store nothing and show it. */
  | { kind: "failed"; message: string };

const ENV: Record<TokenKind, string> = { control: "CONTROL_TOKEN", viewers: "VIEWERS_TOKEN" };

/**
 * Checks a token the operator typed against the server BEFORE it is stored, sending it only as `Authorization: Bearer`
 * (DASH-ACC-004, DASH-ACC-012). The control token goes to `PUT /secrets/access-check`, a path that is no secret path, so
 * the route checks the token first and writes nothing: 401 rejects, 404 accepts. The viewers token goes to
 * `GET /viewers`: 200 and 504 accept (504 only means memory did not answer after the token passed), 401 rejects.
 * A 403 counts as "not set up" only when its message names the variable; a 403 from the Host or Origin check is a failure.
 */
// @spec DASH-ACC-004, DASH-ACC-012
export async function checkToken(api: Pick<Api, "get" | "put">, kind: TokenKind, token: string): Promise<CheckOutcome> {
  const r = kind === "control" ? await api.put("/secrets/access-check", { value: null }, { token }) : await api.get("/viewers", { token });
  if (r.ok) return kind === "viewers" ? { kind: "accepted" } : { kind: "failed", message: "The dashboard answered the check unexpectedly." };
  if (r.status === 401) return { kind: "rejected" };
  if (kind === "control" && r.status === 404) return { kind: "accepted" };
  if (kind === "viewers" && r.status === 504) return { kind: "accepted" };
  if (r.status === 403 && r.detail.includes(ENV[kind])) return { kind: "not-set-up" };
  return { kind: "failed", message: r.status === 0 ? r.detail : `${r.status} ${r.detail}` };
}
