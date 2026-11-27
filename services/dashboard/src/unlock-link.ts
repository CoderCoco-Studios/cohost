/**
 * `mise run dashboard:unlock`: asks the running dashboard for a fresh unlock link and prints it (DASH-UNL-007). The request
 * carries the control token (`POST /unlock/link`, DASH-UNL-006), so it gives nothing the token does not already give.
 */
import { loadDotEnv } from "@cohost/config";
import { peekStore, processIo, type StoreOptions } from "@cohost/store";
import { unlockBase } from "./access.js";
import { recoveryAddress } from "./recovery.js";

export interface UnlockLinkDeps {
  env?: NodeJS.ProcessEnv;
  /** Asks for the token on the terminal without echo; undefined when there is no terminal. */
  askToken?: () => Promise<string> | undefined;
  /** Where the settings store is (tests); the default otherwise. */
  store?: Pick<StoreOptions, "dataDir">;
}

/**
 * The link, or why there is none. The token is `CONTROL_TOKEN` of this process's own environment when set (a password
 * manager's runner), else asked for on the terminal without echo. The port is read from the stored `dashboard` section through
 * a read-only open, the schema default when the store cannot be read, as config recovery mode reads it.
 */
// @spec DASH-UNL-007, STORE-TOK-005
export async function freshUnlockLink(d: UnlockLinkDeps = {}): Promise<{ ok: true; url: string } | { ok: false; why: string }> {
  const env = d.env ?? process.env;
  let token = (env.CONTROL_TOKEN ?? "").trim();
  if (token === "") {
    const asked = d.askToken ? d.askToken() : process.stdin.isTTY ? processIo().askHidden("control token: ") : undefined;
    if (asked === undefined) return { ok: false, why: "no control token given: set CONTROL_TOKEN in this command's environment, or run it in a terminal to be asked for it" };
    token = (await asked).trim();
    if (token === "") return { ok: false, why: "no control token given" };
  }
  const bind = env.DASHBOARD_HOST?.trim() || "127.0.0.1";
  const base = unlockBase(bind, recoveryAddress(peekStore(d.store)).port);
  let res: Response;
  try {
    res = await fetch(`${base}/unlock/link`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  } catch {
    return { ok: false, why: `the dashboard is not running at ${base}: start it with mise run dashboard (it prints an unlock link itself)` };
  }
  const body = (await res.json().catch(() => ({}))) as { url?: unknown; detail?: unknown };
  if (res.ok && typeof body.url === "string") return { ok: true, url: body.url };
  if (res.status === 401) return { ok: false, why: `the dashboard at ${base} refused the control token: check it against your password manager (mise run config:token sets a new one)` };
  return { ok: false, why: `the dashboard at ${base} answered ${res.status}${typeof body.detail === "string" ? `: ${body.detail}` : ""}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The token is the one this command was started with, never one `.env` holds; `.env` gives only DASHBOARD_HOST.
  const own = process.env.CONTROL_TOKEN;
  loadDotEnv();
  const r = await freshUnlockLink({ env: { ...process.env, CONTROL_TOKEN: own } });
  if (r.ok) { process.stdout.write(`Unlock this browser: ${r.url}\n`); process.exit(0); }
  process.stderr.write(`dashboard:unlock: ${r.why}\n`);
  process.exit(1);
}
