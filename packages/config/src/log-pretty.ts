/**
 * The `pretty` terminal form of a log entry (config design, "Logging"): one line of local time, padded level, logger name and
 * message, the scalar fields as `key=value` on that line, then the message's further lines and every object, array or error
 * field indented below. It reads the JSON line pino serialised for the entry, so the file and the terminal start from the
 * same text.
 */

const LEVEL_NAMES: Record<number, string> = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
/** ANSI foreground colour of each level name (CFG-LOG-009). */
const LEVEL_COLOURS: Record<string, number> = { FATAL: 31, ERROR: 31, WARN: 33, INFO: 32, DEBUG: 34, TRACE: 90 };
/** Fields the layout already shows (time, level, name, message) or that are noise on one machine (pid, hostname). */
const OMITTED = new Set(["time", "level", "name", "msg", "pid", "hostname"]);

/** Every C0 and C1 control character and DEL except the tab, and the bidirectional overrides and isolates (CFG-LOG-010). */
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
/** A string value that must be quoted: empty, or holding whitespace, `=`, `"` or a control character (CFG-LOG-007). */
const NEEDS_QUOTES = /^$|[\s="\u0000-\u001f\u007f-\u009f]/;

/** `text` with every character a terminal would act on written as a `\u` escape of its code point. */
export function escapeTerminal(text: string): string {
  return text.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** `HH:MM:SS.mmm` in the process's local time zone. */
function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function scalar(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  return escapeTerminal(NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value);
}

const isErrorLike = (v: object): v is { stack: string } & Record<string, unknown> =>
  !Array.isArray(v) && typeof (v as { stack?: unknown }).stack === "string";

/** The lines below an object, array or error field: its stack and leftover properties, or its indented JSON. */
function blockLines(value: object): string[] {
  if (isErrorLike(value)) {
    const lines = value.stack.split("\n");
    const rest = Object.fromEntries(Object.entries(value).filter(([k]) => k !== "type" && k !== "message" && k !== "stack"));
    if (Object.keys(rest).length > 0) lines.push(JSON.stringify(rest));
    return lines;
  }
  return (JSON.stringify(value, null, 2) ?? "").split("\n");
}

/**
 * The terminal text of one pino JSON line, ending in a line feed. `colour` wraps the level name in its ANSI colour; without
 * it the text holds no escape sequence. A line that is not a JSON object prints escaped, as it came.
 */
// @spec CFG-LOG-005, CFG-LOG-006, CFG-LOG-007, CFG-LOG-008, CFG-LOG-009, CFG-LOG-010
export function formatPretty(line: string, colour: boolean): string {
  let entry: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an entry");
    entry = parsed as Record<string, unknown>;
  } catch {
    return `${escapeTerminal(line.replace(/\n$/, ""))}\n`;
  }
  const level = typeof entry.level === "number" ? (LEVEL_NAMES[entry.level] ?? `L${entry.level}`) : (typeof entry.level === "string" ? entry.level.toUpperCase() : "");
  const label = colour && LEVEL_COLOURS[level] ? `\u001b[${LEVEL_COLOURS[level]}m${level}\u001b[39m` : level;
  const time = clock(typeof entry.time === "number" ? entry.time : Date.now());
  const name = typeof entry.name === "string" ? entry.name : "";
  const msg = typeof entry.msg === "string" ? entry.msg : entry.msg === undefined ? "" : JSON.stringify(entry.msg);
  const [first = "", ...more] = msg.split("\n");

  let head = `${time} ${label}${" ".repeat(Math.max(0, 5 - level.length))} ${escapeTerminal(name)}: ${escapeTerminal(first)}`;
  const blocks: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    if (OMITTED.has(key)) continue;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      head += ` ${escapeTerminal(key)}=${scalar(value)}`;
    } else if (typeof value === "object") {
      blocks.push(`    ${escapeTerminal(key)}:`, ...blockLines(value).map((l) => `      ${escapeTerminal(l)}`));
    }
  }
  const lines = [head, ...more.map((l) => (l === "" ? "" : `    ${escapeTerminal(l)}`)), ...blocks];
  return `${lines.join("\n")}\n`;
}
