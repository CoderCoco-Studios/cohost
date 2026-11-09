import type http from "node:http";
import { randomUUID } from "node:crypto";
import type { BusEvent, EventInput, Publisher } from "@cohost/bus";
import { bearerOk } from "@cohost/control";

/** How long a `/viewers` route waits for memory's `memory.viewers.reply`. */
export const REPLY_TIMEOUT_MS = 3000;
const BODY_LIMIT = 64 * 1024;

type Request = EventInput<"memory.viewers.request">;
/** A `memory.viewers.request` without its correlation id, which the client assigns. */
export type ViewersOp = Request extends infer R ? (R extends { id: string } ? Omit<R, "id"> : never) : never;
export type ViewersReply = BusEvent<"memory.viewers.reply">["data"];

// @spec CFG-ENV-009
/** `VIEWERS_TOKEN` from the process environment (never from config.yaml): trimmed, undefined when unset or blank. */
export function viewersTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.VIEWERS_TOKEN?.trim() || undefined;
}

// @spec DASH-VIEWERS-008
/** Publishes `memory.viewers.request`s and matches memory's replies, which the feed's bus tail hands to `onReply`. */
export class ViewersClient {
  private pending = new Map<string, (r: ViewersReply) => void>();

  constructor(private bus: Publisher, private timeoutMs: number = REPLY_TIMEOUT_MS) {}

  /** A reply that matches no waiting request (late, foreign or duplicated) is dropped. */
  onReply(ev: BusEvent<"memory.viewers.reply">): void {
    this.pending.get(ev.data.id)?.(ev.data);
  }

  /** The reply, or undefined when none arrives in time. Rejects when the request cannot be published. */
  async request(op: ViewersOp): Promise<ViewersReply | undefined> {
    const id = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    const reply = new Promise<ViewersReply | undefined>((resolve) => {
      this.pending.set(id, resolve);
      timer = setTimeout(() => resolve(undefined), this.timeoutMs);
    });
    try {
      await this.bus.publish("memory.viewers.request", { id, ...op } as Request);
      return await reply;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
}

export interface ViewersDeps {
  client: ViewersClient;
  /** `VIEWERS_TOKEN`; unset or empty locks every `/viewers` route (403). */
  token: string | undefined;
}

class BodyTooLarge extends Error {}

function send(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const text = typeof payload === "string";
  res.writeHead(status, {
    "content-type": text ? "text/plain; charset=utf-8" : "application/json",
    ...(text ? {} : { "cache-control": "no-store" }),
    ...headers,
  });
  res.end(text ? payload : JSON.stringify(payload));
}

/** The body as text, up to 64 KiB; past the cap the rest is drained and `BodyTooLarge` thrown. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > BODY_LIMIT) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => (tooLarge ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

const decode = (s: string): string | undefined => { try { return decodeURIComponent(s); } catch { return undefined; } };
const nonBlank = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";

// @spec DASH-VIEWERS-007, DASH-VIEWERS-009
/** Serves every `/viewers` route; returns false when the path is not one of ours. */
export async function handleViewers(d: ViewersDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/viewers" && !url.pathname.startsWith("/viewers/")) return false;
  if (!d.token) {
    req.resume();
    send(res, 403, "The Viewers page is locked: set VIEWERS_TOKEN in .env (a long random secret) and restart the dashboard.");
    return true;
  }
  if (!bearerOk(req.headers.authorization, d.token)) {
    req.resume();
    send(res, 401, "unauthorized", { "www-authenticate": "Bearer" });
    return true;
  }

  const seg = url.pathname.split("/").slice(2); // after "/viewers"
  let op: ViewersOp | undefined;

  if (req.method === "GET") {
    // @spec DASH-VIEWERS-001, DASH-VIEWERS-002
    if (seg.length === 0 || (seg.length === 1 && seg[0] === "")) {
      const q = url.searchParams.get("q");
      op = q ? { op: "list", query: q } : { op: "list" };
    } else if (seg.length === 1) {
      const key = decode(seg[0]!);
      if (key) op = { op: "get", key };
    }
  } else if (req.method === "POST") {
    let json: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new SyntaxError("not an object");
      json = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof BodyTooLarge) send(res, 413, "body too large");
      else send(res, 400, "body must be a JSON object");
      return true;
    }
    const { reason } = json;
    if (reason !== undefined && typeof reason !== "string") { send(res, 400, "reason must be a string"); return true; }
    const key = seg.length >= 1 ? decode(seg[0]!) : undefined;
    if (seg.length === 1 && seg[0] === "regular") {
      // @spec DASH-VIEWERS-006
      const { regular, key: k, name } = json;
      if (typeof regular !== "boolean" || !(nonBlank(k) || nonBlank(name))) { send(res, 400, "body needs a boolean regular and a key or a name"); return true; }
      op = nonBlank(k) ? { op: "set_regular", key: k, regular } : { op: "set_regular", name: name as string, regular };
    }
    if (!op && seg.length === 3 && seg[0] === "deletions" && seg[2] === "restore") {
      // @spec DASH-VIEWERS-004
      op = { op: "restore", deletionId: decode(seg[1]!) ?? "" };
    } else if (!op && seg.length === 4 && seg[1] === "notes" && seg[3] === "delete" && key) {
      // @spec DASH-VIEWERS-003
      const noteId = decode(seg[2]!);
      if (noteId) op = reason === undefined ? { op: "delete_note", noteId } : { op: "delete_note", noteId, reason };
    } else if (!op && seg.length === 2 && seg[1] === "clear" && key) {
      // @spec DASH-VIEWERS-005
      op = reason === undefined ? { op: "clear", key } : { op: "clear", key, reason };
    }
  } else {
    req.resume();
  }

  if (!op) { send(res, 404, "not found"); return true; }

  // @spec DASH-VIEWERS-008
  const reply = await d.client.request(op);
  if (!reply) send(res, 504, { ok: false, detail: "memory did not answer" });
  else if (reply.ok) send(res, 200, reply.data ?? {});
  else send(res, reply.error === "not_found" ? 404 : 500, { ok: false, error: reply.error ?? "failed", detail: reply.detail ?? (reply.error === "not_found" ? "not found" : "memory failed") });
  return true;
}
