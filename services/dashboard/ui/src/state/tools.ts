// What the page knows about tool calling, read from the feed: the pending `tool.confirm` calls and the latest `tool.catalog`.
// Everything here arrives from a tool server or the model, so it is untrusted: every function turns it into plain strings,
// booleans and numbers (never markup), and the components render those as React text children only.

/** The unit whose Test sheet text input is a tool call, not a chat message (DASH-INJ-011). */
export const TOOLS_UNIT = "tools";

/** Longest text shown for one argument value (DASH-TOOL-003). */
export const ARG_CUT = 200;
/** Longest start of a tool result a feed row shows. */
export const RESULT_CUT = 200;

/**
 * A call waiting for the owner's answer. `args` is the raw `arguments` member; `deadline` is by the page's own clock (DASH-TOOL-004).
 * `redacted` is set when this connection was sent the call without its arguments (DASH-FEED-011): the owner cannot see what
 * they would allow, so Allow is off (DASH-TOOL-005).
 */
export interface PendingConfirm {
  id: string;
  tool: string;
  args: unknown;
  origin: string;
  deadline: number;
  redacted: boolean;
}

export interface CatalogServer { name: string; state: string; external: boolean; leftOut: number; detail: string }
export interface CatalogTool {
  name: string;
  description: string;
  label: "read" | "acts" | "unlabelled";
  effect: "read" | "acts";
  enabled: boolean;
  acts: boolean;
  chat: boolean;
  confirm: boolean;
  offered: boolean;
  server?: string;
  hash?: string;
  reason?: string;
}
export interface ToolCatalog { intervalMs: number; mode: string; servers: CatalogServer[]; tools: CatalogTool[] }

/** The latest catalog, and whether three of its intervals passed by the page's own clock without another (DASH-TOOL-023). */
export interface CatalogState { data: ToolCatalog; stale: boolean }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The catalog an event's data carries, or undefined when it is not an object. Members of the wrong type read as absent. */
export function parseCatalog(data: unknown): ToolCatalog | undefined {
  if (!isObj(data)) return undefined;
  const interval = typeof data.intervalMs === "number" && Number.isFinite(data.intervalMs) && data.intervalMs > 0 ? data.intervalMs : 30000;
  const servers = (Array.isArray(data.servers) ? data.servers : []).filter(isObj).map((s): CatalogServer => ({
    name: str(s.name), state: str(s.state), external: s.external === true,
    leftOut: typeof s.left_out === "number" && Number.isFinite(s.left_out) && s.left_out > 0 ? Math.floor(s.left_out) : 0,
    detail: str(s.detail),
  }));
  const tools = (Array.isArray(data.tools) ? data.tools : []).filter(isObj).filter((t) => typeof t.name === "string").map((t): CatalogTool => ({
    name: str(t.name), description: str(t.description),
    label: t.label === "read" || t.label === "acts" ? t.label : "unlabelled",
    effect: t.effect === "acts" ? "acts" : "read",
    enabled: t.enabled === true, acts: t.acts === true, chat: t.chat === true, confirm: t.confirm !== false, offered: t.offered === true,
    ...(typeof t.server === "string" && t.server !== "" ? { server: t.server } : {}),
    ...(typeof t.hash === "string" && t.hash !== "" ? { hash: t.hash } : {}),
    ...(typeof t.reason === "string" ? { reason: t.reason } : {}),
  }));
  return { intervalMs: interval, mode: str(data.mode), servers, tools };
}

const ORIGINS: Record<string, string> = {
  dashboard: "the dashboard", speech: "your voice", guest: "a guest", chat: "stream chat", vision: "what the co-host sees", reminder: "a reminder", idle: "an idle moment",
};
/** Who asked, in words; an origin the page does not know is not echoed as a bare code. */
// @spec DASH-TOOL-003
export const originWords = (origin: unknown): string =>
  typeof origin === "string" && Object.prototype.hasOwnProperty.call(ORIGINS, origin) ? ORIGINS[origin]! : "an unknown source";

/** `text` cut to `max` characters, with an ellipsis when it was cut. */
export const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One argument value as text, cut at `ARG_CUT`: a string as it is, anything else as its JSON (a nested object or a long list is cut as a whole). */
export function argText(v: unknown): string {
  if (typeof v === "string") return cut(v, ARG_CUT);
  let json: string | undefined;
  try { json = JSON.stringify(v); } catch { json = undefined; }
  return cut(json ?? String(v), ARG_CUT);
}

/** The arguments of a call as key and cut value text; anything that is not an object has none. */
export function argLines(args: unknown): { key: string; text: string }[] {
  return isObj(args) ? Object.entries(args).map(([key, v]) => ({ key, text: argText(v) })) : [];
}

const REASONS: Record<string, string> = {
  unknown_tool: "unknown tool", not_enabled: "not enabled", acts_not_allowed: "not allowed to act", not_approved: "not approved", definition_changed: "definition changed since approval",
  origin_not_allowed: "origin not allowed", invalid_arguments: "invalid arguments", server_down: "server down", busy: "busy", denied: "denied", unconfirmed: "not confirmed in time",
  shutdown: "shutting down", tool_error: "tool error", unavailable: "unavailable", limit: "limit reached",
};
/** A `tool.result` reason code in words. */
export const reasonWords = (reason: string): string => REASONS[reason] ?? reason.replace(/_/g, " ");
