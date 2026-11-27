import type { Api } from "../../state/api";

export type CheckOutcome =
  | { kind: "accepted" }
  | { kind: "rejected" }
  /** Anything else (a network error, a `5xx`, a `403` from the Host or Origin check): store nothing and show it. */
  | { kind: "failed"; message: string };

/**
 * Checks a token the operator typed against the server BEFORE it is stored, sending it only as `Authorization: Bearer`
 * (DASH-ACC-004, DASH-ACC-012). The token goes to `PUT /secrets/access-check`, a path that is no secret path, so the route
 * checks the token first and writes nothing: 401 rejects, 404 accepts, and any other answer is a failure shown in the dialog.
 */
// @spec DASH-ACC-004, DASH-ACC-012
export async function checkToken(api: Pick<Api, "put">, token: string): Promise<CheckOutcome> {
  const r = await api.put("/secrets/access-check", { value: null }, { token });
  if (r.ok) return { kind: "failed", message: "The dashboard answered the check unexpectedly." };
  if (r.status === 401) return { kind: "rejected" };
  if (r.status === 404) return { kind: "accepted" };
  return { kind: "failed", message: r.status === 0 ? r.detail : `${r.status} ${r.detail}` };
}
