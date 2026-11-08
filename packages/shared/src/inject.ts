/**
 * Plumbing shared by the services that handle `inject.request` (chat, eyes, ears). The behaviour
 * is owned by the eyes LLD (Image Injection); the services import it so the copies cannot drift.
 */

// @spec EYES-INJ-015
/** Requests older than this are dropped (consumer groups resume after a restart). */
export const INJECT_STALE_MS = 60_000;

// @spec EYES-INJ-005, EARS-INJ-004, EYES-INJ-015
/**
 * Returns the URL to fetch when it lies under `<dashboardUrl>/uploads/` (same origin, no
 * credentials, normalised path), else undefined. Guards against the bus being used to make a
 * service fetch arbitrary URLs.
 */
export function uploadUrl(raw: string | undefined, dashboardUrl: string): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const base = new URL(dashboardUrl);
    if (u.origin !== base.origin || u.username || u.password) return undefined;
    const prefix = base.pathname.replace(/\/+$/, "") + "/uploads/";
    return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length ? u.href : undefined;
  } catch {
    return undefined;
  }
}
