import type http from "node:http";
import { randomUUID } from "node:crypto";
import { EventPayloads, type EventType, type Publisher } from "@cohost/bus";
import { SERVICE_MANIFEST, type HealthState, type ServiceDef } from "@cohost/control";
import { readBody } from "./body.js";
import type { UploadKind, UploadStore } from "./uploads.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const AUDIO_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4"]);
const PLATFORMS = ["twitch", "youtube", "discord"] as const;
type Platform = (typeof PLATFORMS)[number];
const TEXT_LIMIT = 64 * 1024;

/**
 * The base URL eyes and ears fetch uploads from: `DASHBOARD_URL` when set and non-empty, else the host gateway at the
 * LAN listener's port (`DASHBOARD_LAN_PORT`, default 3001).
 */
// @spec DASH-INJ-005
export function uploadBase(env: NodeJS.ProcessEnv): string {
  const url = env.DASHBOARD_URL?.trim();
  if (url) return url;
  return `http://host.docker.internal:${env.DASHBOARD_LAN_PORT?.trim() || "3001"}`;
}

export interface InjectDeps {
  bus: Publisher;
  uploads: UploadStore;
  /** `urls.dashboard()`: what eyes/ears will fetch uploads from. */
  dashboardUrl: string;
  /** Returns false (after sending 401) when the bearer gate rejects the request. */
  authorize: (req: http.IncomingMessage, res: http.ServerResponse) => boolean;
  /** The derived health state of a unit (the tracker's snapshot with the Compose overlay); undefined for a unit not in it. */
  stateOf: (unit: string) => HealthState | undefined;
  /** The control plane's units: what `POST /inject/event` accepts for `unit`, and which `type`s for it. */
  units?: readonly Pick<ServiceDef, "id" | "pnpmFilter" | "test">[];
}

function send(res: http.ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) { res.writeHead(status); res.end(); return; }
  res.writeHead(status, { "content-type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
}

const flag = (v: string | null): boolean => v === "1" || v === "true";

/**
 * Answers `409 service not running` and returns true when the unit an injection is for is `down` or `unknown`; the
 * caller then publishes and stores nothing.
 */
// @spec MOD-TEST-005
function refuseNotRunning(d: InjectDeps, res: http.ServerResponse, unit: string): boolean {
  const state = d.stateOf(unit) ?? "unknown";
  if (state !== "down" && state !== "unknown") return false;
  send(res, 409, { ok: false, detail: `service not running: ${unit}` });
  return true;
}

/** Serves GET /uploads/:id, POST /inject/{text,image,audio,event}. Returns false when the path is not ours. */
export async function handleInject(d: InjectDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  // @spec DASH-INJ-007
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
  if (url.pathname === "/inject/event") { await injectEvent(d, req, res); return true; }
  return false;
}

const SERVICE_KINDS = new Set(["text", "image", "audio"]);

/** The slice of a bus event's zod object that `injectEvent` uses. */
interface EventSchema {
  shape?: Record<string, unknown>;
  safeParse(v: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
}

/**
 * `POST /inject/event { unit, type, data }`: publishes one bus event as a test input to a unit, after checking the unit,
 * that the type is one of its declared inputs and that the data is valid for the type. The answer's id is the published
 * event's bus id.
 */
// @spec MOD-TEST-002, MOD-TEST-003, MOD-TEST-004, MOD-TEST-005, MOD-TEST-006
async function injectEvent(d: InjectDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!d.authorize(req, res)) return;
  const { data: raw, tooLarge } = await readBody(req, TEXT_LIMIT);
  if (tooLarge) return send(res, 413, "body too large");
  let j: unknown;
  try { j = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, "body must be JSON"); }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return send(res, 400, "body must be a JSON object");
  const { unit, type, data } = j as Record<string, unknown>;

  const def = typeof unit === "string" ? (d.units ?? SERVICE_MANIFEST).find((u) => u.id === unit && u.pnpmFilter !== undefined) : undefined;
  if (!def) return send(res, 400, "unit must be a unit of the stack");
  if (typeof type !== "string" || SERVICE_KINDS.has(type) || !def.test.inputs.includes(type)) {
    return send(res, 400, `type must be one of ${def.id}'s test inputs: ${def.test.inputs.filter((i) => !SERVICE_KINDS.has(i)).join(", ") || "none"}`);
  }
  const schema = (EventPayloads as unknown as Record<string, EventSchema | undefined>)[type];
  if (!schema) return send(res, 400, `${type} is not a bus event type`);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return send(res, 400, { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  if (refuseNotRunning(d, res, def.id)) return;
  const payload = { ...parsed.data, ...("injected" in (schema.shape ?? {}) ? { injected: true } : {}) };
  const id = await d.bus.publish(type as EventType, payload as never);
  send(res, 202, { id });
}

// @spec DASH-INJ-001, DASH-INJ-002, DASH-INJ-003, DASH-INJ-004
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

  if (level === "service" && refuseNotRunning(d, res, "chat")) return;
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

// @spec DASH-INJ-005, DASH-INJ-006
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
  if (refuseNotRunning(d, res, kind === "image" ? "eyes" : "ears")) return;

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
