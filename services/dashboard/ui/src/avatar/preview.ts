// The preview's two pure parts (DASH-AVP-035, DASH-AVP-036): the postMessage draft filter and the status line. No DOM.
import type { Framing } from "./framing";

/** A draft from the embedding window: a framing, a model by its stored name (`""` draws none), or a clear of both. */
export type Draft = { kind: "framing"; framing: Framing } | { kind: "model"; name: string } | { kind: "clear" };

export interface DraftContext {
  preview: boolean;
  /** The page's own origin; a message from any other origin is ignored. */
  origin: string;
  /** The embedding window, or null when the page is not framed. */
  parent: unknown;
}

export interface IncomingMessage { data: unknown; origin: string; source: unknown }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
};
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The draft a `postMessage` carries, or null: only in preview mode, only from the embedding window on the page's own origin,
 * and only one of the three exact shapes of DASH-AVP-036 with no extra field. The result is a fresh object, so no getter
 * or prototype of the message reaches the page.
 */
// @spec DASH-AVP-036, DASH-AVP-038
export function acceptDraft(msg: IncomingMessage, ctx: DraftContext): Draft | null {
  if (!ctx.preview || ctx.parent === null || ctx.parent === undefined) return null;
  if (msg.origin !== ctx.origin || msg.source !== ctx.parent) return null;
  const d = msg.data;
  if (!isObject(d)) return null;
  switch (d.type) {
    case "framing": {
      if (!sameKeys(d, ["type", "framing"]) || !isObject(d.framing) || !sameKeys(d.framing, ["zoom", "offsetY", "turn"])) return null;
      const f = d.framing;
      if (!finite(f.zoom) || f.zoom <= 0 || !finite(f.offsetY) || !finite(f.turn)) return null;
      return { kind: "framing", framing: { zoom: f.zoom, offsetY: f.offsetY, turn: f.turn } };
    }
    case "model": {
      if (!sameKeys(d, ["type", "name"]) || typeof d.name !== "string") return null;
      return { kind: "model", name: d.name };
    }
    case "clear":
      return sameKeys(d, ["type"]) ? { kind: "clear" } : null;
    default:
      return null;
  }
}

/** What the preview shows of the page's state (DASH-AVP-035): the socket, the model, its load and the driver. */
export interface StatusInput {
  socketOpen: boolean;
  model: { name: string } | null;
  load: { state: "idle" | "loading" | "ready" | "failed"; detail: string };
  status: { state: "off" | "waiting" | "live"; driver: string | null } | null;
}

/**
 * The one line the preview shows: the first of these that applies, or null when none does. Plain text only, the name and
 * the reason as given.
 */
// @spec DASH-AVP-035
export function statusLine(s: StatusInput): string | null {
  if (!s.socketOpen) return "Reconnecting";
  if (s.model === null) return "No model selected";
  if (s.load.state === "loading") return `Loading ${s.model.name}`;
  if (s.load.state === "failed") return `Could not load ${s.model.name}: ${s.load.detail}`;
  if (s.status !== null && s.status.driver !== null && s.status.driver !== "browser") return `avatar.driver is ${s.status.driver}; the renderer needs browser`;
  if (s.status === null || s.status.state !== "live") return "Waiting for the avatar";
  return null;
}
