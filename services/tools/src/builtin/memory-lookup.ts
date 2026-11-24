/**
 * The built-in `memory_lookup` tool (TOOL-MEM-001 to TOOL-MEM-006): asks the memory service through its recall events and
 * renders the answer as one line per memory. It never reads a database; the memory service answers with the same `id`.
 */
import { randomUUID } from "node:crypto";
import type { BusEvent, Publisher } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import type { DepStatus } from "../catalog.js";
import { SourceFailed, type SourceCallResult } from "../source.js";
import { boundText, quoteUntrusted, speakerLabel } from "@cohost/shared/untrusted";
import { zoned } from "./format.js";
import type { BuiltinSeams, BuiltinTool } from "./types.js";

type Memory = BusEvent<"memory.recall.reply">["data"]["memories"][number];
export const DEFAULT_K = 4;
const K_MAX = 8;
const FIXED_LINE = "- (2026-11-01) Mock viewer: A fixed mock memory line.";

/** The arguments the tool accepts: a non-blank `query`, and an integer `k` from 1 to 8 when given (TOOL-MEM-001). */
export function acceptsLookup(args: Record<string, unknown>): boolean {
  if (typeof args.query !== "string" || args.query.trim() === "") return false;
  if (args.k === undefined) return true;
  return Number.isInteger(args.k) && (args.k as number) >= 1 && (args.k as number) <= K_MAX;
}

export class MemoryLookup {
  /** Resolves a pending lookup by its request id; a reply with any other id is no answer to this tool (TOOL-MEM-003). */
  private readonly waiting = new Map<string, (memories: Memory[] | undefined) => void>();
  private state: DepStatus = "n/a";

  constructor(
    private readonly cfg: Config,
    private readonly seams: BuiltinSeams,
    private readonly bus: Pick<Publisher, "publish">,
    private readonly log: Pick<Logger, "warn">,
    private readonly deadlineMs: number,
    private readonly mock: boolean,
  ) {}

  tool(): BuiltinTool {
    return {
      name: "memory_lookup",
      description: "Looks up what the co-host remembers about a query, when the memories it was given were not the ones it needed. Takes query (text) and k (1 to 8, default 4).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." },
          k: { type: "integer", minimum: 1, maximum: K_MAX, default: DEFAULT_K, description: "How many memories to return." },
        },
        required: ["query"],
      },
      label: "read",
      accepts: acceptsLookup,
      call: (args, signal) => this.call(args, signal),
    };
  }

  /** The dependency `memory` as the last lookup left it: `n/a` before the first, `ok` after an answer, `down` after none. */
  dep(): DepStatus {
    return this.mock ? "n/a" : this.state;
  }

  /** A `memory.recall.reply` the service received; only the reply whose id a pending lookup holds is an answer. */
  reply(data: { id: string; memories: Memory[] }): void {
    this.waiting.get(data.id)?.(data.memories);
  }

  /** Ends the waits this tool holds: a lookup in flight is answered by its own deadline, so nothing is left scheduled. */
  stop(): void {
    for (const done of [...this.waiting.values()]) done(undefined);
  }

  // @spec TOOL-MEM-001, TOOL-MEM-002, TOOL-MEM-003, TOOL-MEM-004, TOOL-MEM-005
  private async call(args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult> {
    const { viewer_text: viewer, cohost } = this.cfg;
    if (this.mock) return { content: [{ type: "text", text: FIXED_LINE }] };
    const query = [...(args.query as string).trim()].slice(0, viewer.max_chars).join("");
    const k = typeof args.k === "number" ? args.k : DEFAULT_K;
    const id = randomUUID();
    const answer = this.wait(id, signal);
    try {
      await this.bus.publish("memory.recall.request", { id, query, k });
    } catch {
      this.waiting.get(id)?.(undefined);
      this.log.warn({ id }, "memory recall request was not published");
    }
    const memories = await answer;
    if (memories === undefined) {
      this.state = "down";
      throw new SourceFailed("The memory service did not answer in time.");
    }
    this.state = "ok";
    // The text is quoted as the cortex quotes a recalled memory: chat and note memories are untrusted quotes, the
    // co-host's own speech and self lines are bounded text (TOOL-MEM-004).
    const lines = memories.slice(0, k).map((m) => {
      // Speech and self lines take the speech limit, as cortex renders them (brain.input_limits.speech_max_chars).
      const text = m.kind === "speech" || m.kind === "self"
        ? boundText(m.text, this.cfg.brain.input_limits.speech_max_chars)
        : quoteUntrusted(m.text, viewer.max_chars);
      return `- (${zoned(m.ts, cohost.timezone).date}) ${speakerLabel(m.who, viewer.max_name_chars)}: ${text}`;
    });
    return { content: [{ type: "text", text: lines.length > 0 ? lines.join("\n") : "Nothing was recalled for that query." }] };
  }

  /** Holds a pending lookup until its reply, its deadline (TOOL-MEM-005) or the end of its call (`undefined`). */
  private wait(id: string, signal: AbortSignal): Promise<Memory[] | undefined> {
    return new Promise((resolve) => {
      let cancel: () => void = () => {};
      const done = (memories: Memory[] | undefined): void => {
        cancel();
        signal.removeEventListener("abort", onAbort);
        this.waiting.delete(id);
        resolve(memories);
      };
      const onAbort = (): void => done(undefined);
      cancel = this.seams.schedule(() => done(undefined), this.deadlineMs);
      this.waiting.set(id, done);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
