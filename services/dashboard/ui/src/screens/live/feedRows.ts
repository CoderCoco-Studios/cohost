import { RESULT_CUT, cut, reasonWords } from "../../state/tools";
import type { FeedEvent } from "../../state/types";

/** The Activity filter choices (DASH-UI-026). */
export type FeedFilter = "all" | "conversation" | "vision" | "system";

export const FILTERS: { value: FeedFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "conversation", label: "Conversation" },
  { value: "vision", label: "Vision" },
  { value: "system", label: "System" },
];

const CONVERSATION: ReadonlySet<string> = new Set(["chat.message", "brain.say", "speech.heard"]);

/** Whether a rendered event type belongs to a filter: Conversation and Vision are named, System is every other rendered type. */
export function inFilter(filter: FeedFilter, type: string): boolean {
  if (filter === "all") return true;
  if (filter === "conversation") return CONVERSATION.has(type);
  if (filter === "vision") return type === "vision.summary";
  return !CONVERSATION.has(type) && type !== "vision.summary";
}

/** The plain kind label of each rendered type (DASH-UI-027). */
const KIND: Record<string, string> = {
  "chat.message": "Chat", "brain.say": "Co-host", "vision.summary": "Vision", "speech.heard": "Speech", "brain.status": "Status",
  control: "Control", "service.lifecycle": "Service", "inject.request": "Test", "inject.result": "Test",
  "voice.utterance": "Voice", "voice.playing": "Voice", "voice.done": "Voice",
  "tool.request": "Tool", "tool.result": "Tool", "tool.timer": "Tool",
};
export const kindLabel = (type: string): string => KIND[type] ?? type;

/** The style class of a row: chat, say, vision and speech get their own; every other rendered type is a status row (faint). */
export function rowClass(type: string): string {
  switch (type) {
    case "chat.message": return "chat";
    case "brain.say": return "say";
    case "vision.summary": return "vision";
    case "speech.heard": return "speech";
    default: return "status";
  }
}

/** A field of an event's data as text; anything that is not a string or number reads as empty, so a malformed event never throws. */
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

/** The text of a row, as a plain string (React renders it as text; no markup is ever built from it, DASH-UI-030). */
export function rowText(ev: FeedEvent): string {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "chat.message": return `${s(d.user)}: ${s(d.text)}`;
    case "brain.say": return s(d.text);
    case "vision.summary": return s(d.text);
    case "speech.heard": return `${s(d.speaker)}: ${s(d.text)}`;
    case "brain.status": return s(d.state) + (s(d.detail) ? ` · ${s(d.detail)}` : "");
    case "control": return s(d.cmd) + (s(d.target) ? ` → ${s(d.target)}` : "") + (s(d.text) ? ` "${s(d.text)}"` : "");
    case "service.lifecycle": return `${s(d.action)} ${s(d.service)} by ${s(d.by)} · ${d.ok ? "ok" : "FAILED"}${s(d.detail) ? ` (${s(d.detail)})` : ""}`;
    case "inject.request": return `→ ${s(d.target)} ${s(d.kind)}${s(d.text) ? ` "${s(d.text)}"` : ""}${d.remember ? " (remember)" : ""}`;
    case "inject.result": return `${d.ok ? "ok" : "FAILED"}${s(d.detail) ? ` · ${s(d.detail)}` : ""}`;
    case "voice.utterance": return `audio ready ${Math.round(Number(d.durationMs) || 0)}ms`;
    case "voice.playing": case "voice.done": return s(d.sink);
    case "tool.request": return `asked for ${s(d.tool)}`;
    case "tool.result": return toolResultText(d);
    case "tool.timer": return d.missed === true ? `timer missed: ${s(d.note)}` : `timer went off: ${s(d.note)}`;
    default: return "";
  }
}

/** A tool result in one line: the tool, the status in words (a refusal or error with its reason), how long it took and the start of its content (DASH-UI-002). */
// @spec DASH-UI-002, DASH-TOOL-024
function toolResultText(d: Record<string, unknown>): string {
  const status = s(d.status);
  const reason = s(d.reason) ? reasonWords(s(d.reason)) : "";
  const words = status === "timeout" ? "timed out" : status === "refused" ? (reason ? `refused: ${reason}` : "refused") : status === "error" ? (reason ? `error: ${reason}` : "error") : status;
  const ms = Math.round(Number(d.durationMs) || 0);
  const content = typeof d.content === "string" ? d.content.trim() : "";
  return [s(d.tool), words, `${ms} ms`].filter((x) => x !== "").join(" · ") + (content ? ` · ${cut(content, RESULT_CUT)}` : "");
}

/** The small extras a row shows after its text (as the design draws them): a chat line's platform, a co-host line's emotion and the reason it spoke. */
export function rowExtras(ev: FeedEvent): { tag?: string; because?: string } {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  if (ev.type === "chat.message") return s(d.platform) ? { tag: s(d.platform) } : {};
  if (ev.type === "brain.say") return { ...(s(d.emotion) ? { tag: s(d.emotion) } : {}), ...(s(d.reason) ? { because: s(d.reason) } : {}) };
  return {};
}

/** The badges of a row: an injected input, and whether it was stored in memory (DASH-UI-002). */
export function rowBadges(ev: FeedEvent): string[] {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  return d.injected === true ? ["injected", ...(d.remember === true ? ["remembered"] : [])] : [];
}

/** The time zone abbreviation of the page's locale at `ms` ("PST", "UTC"). */
export function zoneAbbreviation(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "local";
}

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A row's time in the viewer's local zone, with the date when the event is not from today (DASH-UI-026). */
export function rowTime(ms: number, now: number): { date?: string; clock: string; iso: string } {
  const at = new Date(ms);
  const clock = at.toLocaleTimeString([], { hour12: false });
  const iso = Number.isFinite(at.getTime()) ? at.toISOString() : "";
  return sameDay(at, new Date(now)) ? { clock, iso } : { date: at.toLocaleDateString(undefined, { month: "short", day: "numeric" }), clock, iso };
}
