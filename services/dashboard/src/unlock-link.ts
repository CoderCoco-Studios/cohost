/**
 * `mise run dashboard:unlock`: asks the running dashboard for a fresh unlock link and prints it (DASH-UNL-007). The request
 * carries `CONTROL_TOKEN` (`POST /unlock/link`, DASH-UNL-006), so it gives nothing the token does not already give.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, loadDotEnv } from "@cohost/config";
import { controlTokenProblem } from "@cohost/control";
import { unlockBase } from "./access.js";
import { recoveryAddress } from "./recovery.js";

/** The link, or why there is none. The port is read the way config recovery mode reads it, so a broken config.yaml still gives it. */
// @spec DASH-UNL-007
export async function freshUnlockLink(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; url: string } | { ok: false; why: string }> {
  const problem = controlTokenProblem(env);
  if (problem !== undefined) return { ok: false, why: `${problem}; the dashboard does not start without it` };
  const token = env.CONTROL_TOKEN!.trim();
  let text: string | undefined;
  try { text = readFileSync(join(configDir(), "config.yaml"), "utf8"); } catch { text = undefined; }
  const bind = env.DASHBOARD_HOST?.trim() || "127.0.0.1";
  const base = unlockBase(bind, recoveryAddress(text).port);
  let res: Response;
  try {
    res = await fetch(`${base}/unlock/link`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  } catch {
    return { ok: false, why: `the dashboard is not running at ${base}: start it with mise run dashboard (it prints an unlock link itself)` };
  }
  const body = (await res.json().catch(() => ({}))) as { url?: unknown; detail?: unknown };
  if (res.ok && typeof body.url === "string") return { ok: true, url: body.url };
  if (res.status === 401) return { ok: false, why: `the dashboard at ${base} refused CONTROL_TOKEN from .env: restart the dashboard if .env changed after it started` };
  return { ok: false, why: `the dashboard at ${base} answered ${res.status}${typeof body.detail === "string" ? `: ${body.detail}` : ""}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDotEnv();
  const r = await freshUnlockLink();
  if (r.ok) { process.stdout.write(`Unlock this browser: ${r.url}\n`); process.exit(0); }
  process.stderr.write(`dashboard:unlock: ${r.why}\n`);
  process.exit(1);
}
