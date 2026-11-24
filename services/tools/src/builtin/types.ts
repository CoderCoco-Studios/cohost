/**
 * The seams of the built-in tools (`ToolsEnv.builtin`, TOOL-CLOCK-001, TOOL-STRM-003, TOOL-MEM-002, TOOL-TIMER-005): the
 * `fetch` of every platform call, the epoch clock and the one scheduler of every wait. Production passes none of them and
 * gets the process's; the tests pass a fake clock and a scripted `fetch`.
 */
import type { SourceCallResult } from "../source.js";

export type BuiltinName = "clock" | "stream_info" | "memory_lookup" | "timer";

/** Starts a wait for `ms` and returns the function that cancels it: the wait's `fn` never runs after that. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

export interface BuiltinSeams {
  fetch: typeof fetch;
  now: () => number;
  schedule: Scheduler;
}

/** One built-in tool as the catalog and the pipeline see it. */
export interface BuiltinTool {
  readonly name: BuiltinName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  /** `timer` is `acts`; the other three are `read` (TOOL-CAT-004). */
  readonly label: "read" | "acts";
  /** Whether the arguments are accepted. A refused request never reaches `call` (TOOL-CALL-007). */
  accepts(args: Record<string, unknown>): boolean;
  /** Runs the tool. A failure is a `SourceFailed` with the reason it ends with. */
  call(args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult>;
}
