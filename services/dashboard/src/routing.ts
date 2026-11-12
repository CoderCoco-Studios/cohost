import type http from "node:http";
import { RoutingPatch, type Publisher } from "@cohost/bus";

export interface RoutingDeps {
  bus: Publisher;
  /** Returns false (after sending 401) when the bearer gate rejects the request. */
  authorize: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  body: (req: http.IncomingMessage) => Promise<string>;
}

/**
 * `POST /mouth/routing`: re-route mouth's outputs without a restart by sending it a `set_routing` command. The body is
 * `{"outputs": {<id>: {"enabled"?, "gain_db"?}}}`. The dashboard keeps no routing state: mouth applies or rejects the command
 * and reports the routing as its heartbeat detail, which `GET /services` serves. Returns true when the request was this route's.
 */
// @spec DASH-ROUTE-001, DASH-ROUTE-002, DASH-ROUTE-003
export async function handleMouthRouting(d: RoutingDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/mouth/routing") return false;
  if (!d.authorize(req, res)) return true;
  const bad = (why: string) => { res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); res.end(why); return true; };
  let raw: unknown;
  try { raw = JSON.parse(await d.body(req)); } catch (err) {
    if (err instanceof SyntaxError) return bad("body must be JSON");
    throw err; // a body over the cap is the caller's 413
  }
  const outputs = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as { outputs?: unknown }).outputs : undefined;
  const parsed = RoutingPatch.safeParse(outputs);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return bad(parsed.success ? "outputs must name at least one output" : `bad outputs: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  await d.bus.publish("control", { cmd: "set_routing", target: "mouth", routing: parsed.data });
  res.writeHead(204);
  res.end();
  return true;
}
