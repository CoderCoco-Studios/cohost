/**
 * The built-in tools: `clock`, `stream_info`, `memory_lookup` and `timer` (TOOL-CAT-001). They are listed first, under their
 * bare names, with no server and no hash (TOOL-PIN-005). This module builds them from the config and the seams and owns the
 * waits they share: the one scheduler, and a bounded wait of `tools.timeout_ms` that ends before the call limit does.
 */
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { DepStatus } from "../catalog.js";
import { clockTool } from "./clock.js";
import { MemoryLookup } from "./memory-lookup.js";
import { StreamInfo } from "./stream-info.js";
import { TimerTool, MAX_DELAY_MS, type TimerBus, type TimerStore } from "./timer.js";
import type { BuiltinSeams, BuiltinTool, Scheduler } from "./types.js";

export type { BuiltinSeams, BuiltinTool, Scheduler } from "./types.js";

/** The fraction of the call limit a built-in wait may use, so it ends before the pipeline's own timeout (TOOL-MEM-005). */
export const DEADLINE_SHARE = 0.9;

/** The seams a test or an embedder may replace; each one left out takes the process's own. */
export interface BuiltinEnv {
  fetch?: typeof fetch;
  now?: () => number;
  schedule?: Scheduler;
}

export interface BuiltinOptions {
  cfg: Config;
  mode: "live" | "mock";
  bus: TimerBus & Pick<Publisher, "publish">;
  log: Pick<Logger, "info" | "warn" | "error">;
  env: BuiltinEnv;
}

const defaultSchedule: Scheduler = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** The four built-in tools, with their state: the stream and memory dependencies and the timers. */
// @spec TOOL-CAT-001, TOOL-CAT-013, TOOL-MOCK-005, TOOL-MOCK-006
export class BuiltinTools {
  /** `clock`, `stream_info`, `memory_lookup`, `timer`, in that order. */
  readonly tools: BuiltinTool[];
  private readonly cfg: Config;
  private readonly mock: boolean;
  private readonly stream: StreamInfo;
  private readonly memory: MemoryLookup;
  private readonly timers: TimerTool;

  constructor(o: BuiltinOptions) {
    this.cfg = o.cfg;
    this.mock = o.mode === "mock";
    const seams: BuiltinSeams = {
      fetch: o.env.fetch ?? ((input, init) => fetch(input, init)),
      now: o.env.now ?? (() => Date.now()),
      schedule: o.env.schedule ?? defaultSchedule,
    };
    const deadlineMs = Math.min(Math.floor(o.cfg.tools.timeout_ms * DEADLINE_SHARE), MAX_DELAY_MS);
    this.stream = new StreamInfo(o.cfg, seams, deadlineMs, this.mock);
    this.memory = new MemoryLookup(o.cfg, seams, o.bus, o.log, deadlineMs, this.mock);
    const store: TimerStore = this.mock ? memoryStore() : {
      put: (id, json) => o.bus.putTimer(id, json),
      delete: (id) => o.bus.deleteTimer(id),
      list: () => o.bus.listTimers(),
    };
    this.timers = new TimerTool(o.cfg, seams, o.bus, store, o.log, this.mock);
    this.tools = [clockTool(o.cfg.cohost.timezone, seams.now), this.stream.tool(), this.memory.tool(), this.timers.tool()];
  }

  /** The heartbeat's dependencies of the enabled built-ins (TOOL-STRM-007, TOOL-MEM-006); none for a disabled one. */
  deps(): Record<string, DepStatus> {
    const out: Record<string, DepStatus> = {};
    if (this.enabled("stream_info")) Object.assign(out, this.stream.deps(true));
    if (this.enabled("memory_lookup")) out.memory = this.memory.dep();
    if (this.mock) for (const k of Object.keys(out)) out[k] = "n/a";
    return out;
  }

  /** Reads the stored timers and arms them; live mode only. */
  async start(): Promise<void> {
    await this.timers.load();
  }

  /** Routes a `memory.recall.reply` to the lookup waiting for it. */
  memoryReply(data: BusEvent<"memory.recall.reply">["data"]): void {
    this.memory.reply(data);
  }

  /** Cancels the waits of the timers and ends the lookups in flight (TOOL-SVC-008). */
  stop(): void {
    this.timers.stop();
    this.memory.stop();
  }

  private enabled(name: string): boolean {
    return this.cfg.tools.allow[name]?.enabled === true;
  }
}

/** The mock store: timers in the service's memory, no key touched (TOOL-MOCK-006). */
function memoryStore(): TimerStore {
  const held = new Map<string, string>();
  return {
    put: async (id, json) => { held.set(id, json); },
    delete: async (id) => { held.delete(id); },
    list: async () => [...held].map(([id, json]) => ({ id, json })),
  };
}

