/**
 * The built-in `clock` tool (TOOL-CLOCK-001): the current time, date, weekday and zone, one sentence; arguments ignored.
 */
import { zoned } from "./format.js";
import type { BuiltinTool } from "./types.js";

// @spec TOOL-CLOCK-001
export function clockTool(zone: string, now: () => number): BuiltinTool {
  return {
    name: "clock",
    description: "Tells the current time, date, weekday and time zone of the co-host. Takes no arguments.",
    parameters: { type: "object", properties: {} },
    label: "read",
    accepts: () => true,
    async call() {
      const t = zoned(now(), zone);
      return { content: [{ type: "text", text: `It is ${t.time} on ${t.weekday}, ${t.date} in ${zone}.` }] };
    },
  };
}
