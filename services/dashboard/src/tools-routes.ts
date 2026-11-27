import type http from "node:http";
import { pass, type Gate } from "./access.js";
import type { Publisher } from "@cohost/bus";
import { BodyTooLarge, readText } from "./body.js";

export interface ToolRouteDeps {
  bus: Publisher;
  /** The one lock (DASH-CTRL-011). */
  gate: Gate;
}

/**
 * `POST /tools/answer { id, allow }` publishes `tool.answer` for a confirmation prompt. Always token-gated, the token is
 * judged before the body, and nothing but `id` and `allow` reaches the bus. The dashboard keeps no record of answers.
 */
// @spec DASH-TOOL-001, DASH-TOOL-002
export async function handleToolAnswer(d: ToolRouteDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/tools/answer") return false;
  if (!(await pass(d.gate, req, res, "json"))) return true; // the one gate (DASH-CTRL-011)
  let raw: string;
  try { raw = await readText(req); } catch (e) {
    if (e instanceof BodyTooLarge) { res.writeHead(413); res.end("body too large"); return true; }
    throw e;
  }
  let j: unknown;
  try { j = JSON.parse(raw); } catch { res.writeHead(400); res.end("body must be JSON"); return true; }
  if (typeof j !== "object" || j === null || Array.isArray(j)) { res.writeHead(400); res.end("body must be a JSON object"); return true; }
  const { id, allow } = j as Record<string, unknown>;
  if (typeof id !== "string" || id.length < 1 || id.length > 256 || typeof allow !== "boolean") {
    res.writeHead(400); res.end("body must be { id: string of 1 to 256 characters, allow: boolean }");
    return true;
  }
  await d.bus.publish("tool.answer", { id, allow });
  res.writeHead(202); res.end();
  return true;
}
