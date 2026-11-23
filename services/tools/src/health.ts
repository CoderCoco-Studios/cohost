/**
 * The heartbeat's dependencies and detail, from the catalog (TOOL-SVC-004 to TOOL-SVC-006, TOOL-MCP-010).
 */
import type { DepStatus, Snapshot } from "./catalog.js";

export interface Health {
  deps: Record<string, DepStatus>;
  detail: string;
  /** True while a dependency is `down`: the service reports `degraded`. */
  degraded: boolean;
}

/**
 * A server with at least one listed, enabled tool is the dependency `mcp.<name>`: `ok` while connected, `down` when
 * not (`auth` included), `n/a` in mock mode. The detail parts are the offered count, `no tools enabled`, each down
 * server and `off LAN: <names>`, joined by `; ` in that order, and name no URL (TOOL-SVC-006).
 */
// @spec TOOL-SVC-004, TOOL-SVC-006, TOOL-MCP-010
export function healthOf(snap: Snapshot): Health {
  const deps: Record<string, DepStatus> = {};
  for (const s of snap.servers) {
    if (!snap.enabledNames.some((n) => n.startsWith(`${s.name}__`))) continue;
    deps[`mcp.${s.name}`] = s.state === "mock" ? "n/a" : s.state === "ok" ? "ok" : "down";
  }
  const offered = snap.tools.filter((t) => t.offered).length;
  const parts = [`${offered} tools offered`];
  if (snap.enabledNames.length === 0) parts.push("no tools enabled");
  for (const s of snap.servers) {
    if (deps[`mcp.${s.name}`] !== "down") continue;
    parts.push(s.state === "auth" ? `${s.name} refused its credential` : `${s.name} down`);
  }
  const external = snap.servers.filter((s) => s.external).map((s) => s.name);
  if (external.length > 0) parts.push(`off LAN: ${external.join(", ")}`);
  return { deps, detail: parts.join("; "), degraded: Object.values(deps).includes("down") };
}
