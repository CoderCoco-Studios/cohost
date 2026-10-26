import type http from "node:http";
import { randomUUID } from "node:crypto";
import type { Publisher } from "@cohost/bus";
import type { UploadKind, UploadStore } from "./uploads.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4"]);
const PLATFORMS = ["twitch", "youtube", "discord"] as const;
type Platform = (typeof PLATFORMS)[number];
const TEXT_LIMIT = 64 * 1024;

export interface InjectDeps {
  bus: Publisher;
  uploads: UploadStore;
  /** `urls.dashboard()`: what eyes/ears will fetch uploads from. */
  dashboardUrl: string;
  /** Returns false (after sending 401) when the bearer gate rejects the request. */
  authorize: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
}

function send(res: http.ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) { res.writeHead(status); res.end(); return; }
  res.writeHead(status, { "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

/** Collects a body up to `max` bytes. Over the cap the rest is drained and discarded. */
function readBody(req: http.IncomingMessage, max: number): Promise<{ data: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let tooLarge = Number.isFinite(declared) && declared > max;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > max) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => resolve({ data: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

const flag = (v: string | null): boolean => v === "1" || v === "true";

/** Serves GET /uploads/:id, POST /inject/{text,image,audio}. Returns false when the path is not ours. */
export async function handleInject(d: InjectDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    const id = url.pathname.slice("/uploads/".length);
    const up = d.uploads.get(id);
    if (!up) { send(res, 404, "not found"); return true; }
    res.writeHead(200, { "content-type": up.contentType, "content-length": up.data.length, "cache-control": "no-store" });
    res.end(up.data);
    return true;
  }
  if (req.method !== "POST") return false;
  if (url.pathname === "/inject/text") { await injectText(d, req, res); return true; }
  if (url.pathname === "/inject/image") { await injectBinary(d, req, res, url, "image"); return true; }
  if (url.pathname === "/inject/audio") { await injectBinary(d, req, res, url, "audio"); return true; }
  return false;
}

async function injectText(d: InjectDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!d.authorize(req, res)) return;
  const { data, tooLarge } = await readBody(req, TEXT_LIMIT);
  if (tooLarge) return send(res, 413, "body too large");
  let j: unknown;
  try { j = JSON.parse(data.toString("utf8")); } catch { return send(res, 400, "body must be JSON"); }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return send(res, 400, "body must be a JSON object");
  const b = j as Record<string, unknown>;

  const level = b.level;
  if (level !== "service" && level !== "bus") return send(res, 400, "level must be 'service' or 'bus'");
  const as = b.as ?? "chat";
  if (as !== "chat" && as !== "speech" && as !== "vision") return send(res, 400, "as must be chat, speech or vision");
  if (typeof b.text !== "string" || b.text.trim() === "") return send(res, 400, "text must be a non-blank string");
  if (b.remember !== undefined && typeof b.remember !== "boolean") return send(res, 400, "remember must be a boolean");
  if (b.user !== undefined && typeof b.user !== "string") return send(res, 400, "user must be a string");
  if (b.platform !== undefined && !PLATFORMS.includes(b.platform as Platform)) return send(res, 400, "platform must be twitch, youtube or discord");
  if (b.isMod !== undefined && typeof b.isMod !== "boolean") return send(res, 400, "isMod must be a boolean");
  if (b.isSub !== undefined && typeof b.isSub !== "boolean") return send(res, 400, "isSub must be a boolean");
  if (level === "service" && as !== "chat") return send(res, 400, "service-level text injection supports only as: chat; use level: bus for speech/vision");

  const remember = b.remember === true;
  const user = b.user as string | undefined;
  const platform = b.platform as Platform | undefined;
  const id = randomUUID();
  const text = b.text.replace(/\s+/g, " ").trim();

  if (level === "service") {
    await d.bus.publish("inject.request", {
      id, target: "chat", kind: "text", text: b.text,
      meta: {
        ...(user ? { user } : {}), ...(platform ? { platform } : {}),
        ...(typeof b.isMod === "boolean" ? { isMod: b.isMod } : {}), ...(typeof b.isSub === "boolean" ? { isSub: b.isSub } : {}),
      },
      remember,
    });
  } else if (as === "chat") {
    await d.bus.publish("chat.message", {
      platform: platform ?? "twitch", user: user || "injected_viewer", text,
      isMod: b.isMod === true, isSub: b.isSub === true,
      injected: true, remember,
    });
  } else if (as === "speech") {
    await d.bus.publish("speech.heard", { speaker: user || "injected", text, durationMs: 0, injected: true, remember });
  } else {
    await d.bus.publish("vision.summary", { text, changed: true, injected: true, remember });
  }
  send(res, 202, { id });
}

async function injectBinary(d: InjectDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL, kind: UploadKind): Promise<void> {
  if (!d.authorize(req, res)) return;
  const level = url.searchParams.get("level") ?? "service";
  if (level === "bus") return send(res, 400, "bus-level injection is text only: use POST /inject/text");
  if (level !== "service") return send(res, 400, "level must be 'service' or 'bus'");
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(kind === "image" ? IMAGE_TYPES : AUDIO_TYPES).has(contentType)) {
    req.resume();
    return send(res, 415, `unsupported content type '${contentType}'`);
  }
  const { data, tooLarge } = await readBody(req, d.uploads.maxBytes(kind));
  if (tooLarge) return send(res, 413, `${kind} exceeds ${d.uploads.maxBytes(kind)} bytes`);
  if (data.length === 0) return send(res, 400, "empty body");

  const uploadId = d.uploads.put(kind, contentType, data);
  const user = url.searchParams.get("user") || undefined;
  const id = randomUUID();
  await d.bus.publish("inject.request", {
    id,
    target: kind === "image" ? "eyes" : "ears",
    kind,
    url: `${d.dashboardUrl.replace(/\/+$/, "")}/uploads/${uploadId}`,
    meta: user ? { user } : undefined,
    remember: flag(url.searchParams.get("remember")),
  });
  send(res, 202, { id });
}
