import type http from "node:http";
import type { Publisher } from "@cohost/bus";
import { BodyTooLarge, readText } from "./body.js";
import { NO_TOKEN_DETAIL, tokenRefusal, type TokenGate } from "./access.js";

export interface ToolRouteDeps {
  bus: Publisher;
  /** Who must present the control token (DASH-CTRL-011). */
  gate: TokenGate;
}

const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void => {
  if (body === undefined) { res.writeHead(status, headers); res.end(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

/**
 * Judges the control token for a tool route where it is required (DASH-CTRL-011): 403 when none is configured, 401 with
 * `www-authenticate: Bearer` when the request's is missing or wrong. Returns true when the request may proceed.
 */
// @spec DASH-TOOL-002, DASH-INJ-011
export function requireToolToken(gate: TokenGate, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const refusal = tokenRefusal(gate, req.headers.authorization);
  if (refusal === "none") { send(res, 403, { ok: false, detail: NO_TOKEN_DETAIL }); return false; }
  if (refusal === "wrong") { send(res, 401, { ok: false, detail: "unauthorized" }, { "www-authenticate": "Bearer" }); return false; }
  return true;
}

/**
 * `POST /tools/answer { id, allow }` publishes `tool.answer` for a confirmation prompt. Gated by the control token where it is
 * required, judged before the body, and nothing but `id` and `allow` reaches the bus. The dashboard keeps no record of answers.
 */
// @spec DASH-TOOL-001
export async function handleToolAnswer(d: ToolRouteDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "POST" || url.pathname !== "/tools/answer") return false;
  if (!requireToolToken(d.gate, req, res)) { req.resume(); return true; }
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
