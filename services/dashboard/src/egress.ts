import type http from "node:http";
import { egressDestinations, type Config } from "@cohost/config";

/**
 * `GET /egress`: every destination private data is sent to under the stored settings, read from the settings store on every
 * request (`config`, the store's assembled configuration, STORE-DB-010). Ungated, full-surface listener only (the LAN allow-list
 * has no path to it). The body names hosts and engines and never a secret value. A configuration that cannot be assembled answers
 * 500 with the store's error and is never cached.
 */
// @spec DASH-EGR-001, DASH-EGR-002, DASH-EGR-003, DASH-EGR-004
export function handleEgress(config: () => Config, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method !== "GET" || url.pathname !== "/egress") return false;
  let destinations: ReturnType<typeof egressDestinations>;
  try {
    destinations = egressDestinations(config());
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
    return true;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ destinations }));
  return true;
}
