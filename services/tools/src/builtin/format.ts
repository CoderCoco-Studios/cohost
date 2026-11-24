/**
 * Formatting the built-in tools share: the wall time in `cohost.timezone`, durations, and the bound of text that
 * came from outside (a platform title, a memory). Nothing here reads a clock; every time is passed in.
 */
import { boundText } from "@cohost/shared/untrusted";

export const MINUTE_MS = 60_000;
/** The longest a platform title or category is shown, in code points (TOOL-STRM-002). */
export const PLATFORM_TEXT_MAX = 100;

interface Formatters { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat; weekday: Intl.DateTimeFormat }
const formatters = new Map<string, Formatters>();

function formattersFor(zone: string): Formatters {
  let f = formatters.get(zone);
  if (f === undefined) {
    f = {
      date: new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }),
      time: new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }),
      weekday: new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }),
    };
    formatters.set(zone, f);
  }
  return f;
}

/** The instant as the zone's calendar date (`2026-11-24`), weekday, time (`03:05:09`) and its hour and minute (`03:05`). */
export function zoned(at: number, zone: string): { date: string; weekday: string; time: string; clock: string } {
  const f = formattersFor(zone);
  const time = f.time.format(at);
  return { date: f.date.format(at), weekday: f.weekday.format(at), time, clock: time.slice(0, 5) };
}

/** A span as words: `1 hour 30 minutes`, `2 hours`, `under a minute`. */
export function duration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (rest > 0) parts.push(`${rest} minute${rest === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" ") : "under a minute";
}

/** Text from a platform or a memory, bounded to one line with control and bidi characters removed (TOOL-STRM-002). */
export function platformText(raw: string, max = PLATFORM_TEXT_MAX): string {
  return boundText(raw, max);
}
