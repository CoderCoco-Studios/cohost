import { ModuleSchema } from "@cohost/config";
import { Module } from "@cohost/modules";
import type { ChatEvent, ChatMessage, ChatProvider, ChatRequest, ChatResult, ToolCall } from "@cohost/llm";
import type { BusEvent, EventInput, EventType } from "@cohost/bus";
import { FakeBus, event, recordingLog, silentLog, testConfig, waitFor } from "@cohost/testing";
import { Cortex } from "../src/cortex.js";
import type { CriticInput, CriticOutput } from "../src/critic.js";

// Shared harness of provisional.test.ts and interject.test.ts: a cortex over a scripted model that can be held open before and
// after its text, a bus that hands the cortex its own lines back and answers `tool.request`, and builders for the three events a
// provisional think reacts to (cortex-design.md, Provisional think).

export type Req = BusEvent<"tool.request">["data"];

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};
const snap = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** Waits for `p`, rejecting as a real provider's stream does when the signal aborts. */
const until = (p: Promise<void>, signal?: AbortSignal): Promise<void> =>
  signal === undefined ? p : Promise.race([p, new Promise<void>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  })]);

/** One round the scripted model plays. `gate` holds the stream before anything is yielded, `hold` after the text and before `done`. */
export interface Round {
  text?: string;
  calls?: ToolCall[];
  finish?: ChatResult["finish"];
  gate?: Promise<void>;
  hold?: Promise<void>;
}
export const call = (id: string, name = "clock"): ToolCall => ({ id, name, arguments: {} });

export class ProvLlm implements ChatProvider {
  readonly name = "fake";
  readonly model = "fake";
  /** The rounds the next `stream()` calls play; a call past the end replies `[happy] hey chat!`. */
  rounds: Round[] = [];
  calls: ChatMessage[][] = [];
  opts: (ChatRequest | undefined)[] = [];
  /** Per call: whether the signal was aborted when the stream stopped, and whether the stream has stopped at all. */
  endedAborted: boolean[] = [];
  ended: boolean[] = [];
  async chat(): Promise<string> { throw new Error("the reply must be read with stream()"); }
  async complete(): Promise<ChatResult> { throw new Error("the reply must be read with stream()"); }
  async ping() { return true; }
  async *stream(msgs: ChatMessage[], opts?: ChatRequest): AsyncGenerator<ChatEvent> {
    const n = this.calls.length;
    this.calls.push(snap(msgs));
    this.opts.push(opts);
    const round = this.rounds[n] ?? { text: "[happy] hey chat!" };
    try {
      if (round.gate) await until(round.gate, opts?.signal);
      if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const text = round.text ?? "";
      if (text) yield { type: "text", delta: text };
      if (round.hold) await until(round.hold, opts?.signal);
      if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
      const calls = round.calls ?? [];
      for (const c of calls) yield { type: "tool_call", call: c };
      const message = { role: "assistant" as const, content: text, ...(calls.length ? { toolCalls: calls } : {}) };
      yield { type: "done", result: { text, toolCalls: calls, finish: round.finish ?? (calls.length ? "tool_calls" : "stop"), message } };
    } finally {
      this.endedAborted[n] = opts?.signal?.aborted ?? false;
      this.ended[n] = true;
    }
  }
}

export class ProvBus extends FakeBus {
  cortex?: Cortex;
  requests: Req[] = [];
  /** Wall time of each `tool.request`, and a hook run when each `brain.say` is published (before the cortex reads it back). */
  reqAt: number[] = [];
  onSay?: (data: BusEvent<"brain.say">["data"]) => void;
  /** The delay of each tool answer in ms; none answers nothing. */
  answerAfterMs?: number;
  override async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "brain.say") this.onSay?.(data as never);
    const id = await super.publish(type, data);
    if (type === "brain.say" || type === "brain.clause") await this.cortex?.onEvent(event(type, data, "cortex"));
    if (type === "tool.request") {
      const req = this.published.at(-1)!.data as Req;
      this.requests.push(req);
      this.reqAt.push(Date.now());
      if (this.answerAfterMs !== undefined) {
        setTimeout(() => void this.cortex?.onEvent(event("tool.result", { id: req.id, tool: req.tool, status: "ok", content: "it is noon", durationMs: 1 }, "tools")), Math.max(1, this.answerAfterMs));
      }
    }
    return id;
  }
}

export type CriticKind = "rules" | "llm" | "http";
export interface SetupOpts {
  cortex?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  recallK?: number;
  kind?: CriticKind;
  critic?: (i: CriticInput) => CriticOutput | Promise<CriticOutput>;
  /** Offers a `clock` tool to the model. */
  withTool?: boolean;
}
export function setup(o: SetupOpts = {}) {
  const kind = o.kind ?? "rules";
  const cfg = testConfig({
    brain: {
      memory: { recall_k: o.recallK ?? 0 },
      cortex: {
        recall_timeout_ms: 30, clause_min_chars: 10, clause_max_chars: 60, max_clauses: 8, hold_limit_ms: 5000,
        ...(kind === "rules" ? {} : { critic: kind === "llm" ? { kind } : { kind, url: "http://critic.invalid" } }),
        ...(o.cortex ?? {}),
      },
    },
    tools: { timeout_ms: 200, confirm_timeout_ms: 400, reply: { filler_after_ms: 60_000 }, ...(o.tools ?? {}) },
  });
  const bus = new ProvBus();
  const llm = new ProvLlm();
  const rec = recordingLog();
  const criticCalls: CriticInput[] = [];
  const run = async (i: CriticInput) => { criticCalls.push(i); return (o.critic ?? (() => ({ ok: true })))(i); };
  const critic = kind === "rules"
    ? new Module<CriticInput, CriticOutput>("critic", ModuleSchema.parse({}), {} as never, { rules: run as never }, silentLog)
    : ({ kind, run } as unknown as Module<CriticInput, CriticOutput>);
  const cortex = new Cortex({ cfg, bus, llm, critic, log: rec.log, loadPersonality: () => "You are Coco." });
  bus.cortex = cortex;
  if (o.withTool) {
    void cortex.onEvent(event("tool.catalog", {
      intervalMs: 600_000, mode: "live", servers: [{ name: "builtin", state: "ok", external: false }],
      tools: [{ name: "clock", description: "clock tool", parameters: { type: "object", properties: {} }, label: "read", effect: "read", enabled: true, acts: false, chat: false, confirm: true, offered: true }],
    }, "tools"));
  }
  return {
    cfg, bus, llm, cortex, rec, criticCalls,
    statuses: () => bus.of("brain.status").map((s) => s.state),
    says: () => bus.of("brain.say"),
    clauses: () => bus.of("brain.clause"),
    /** Events of the streamed line in publish order. */
    line: () => bus.published.filter((p) => p.type === "brain.say" || p.type === "brain.clause").map((p) => p.data as { text: string; seq?: number; last?: true; more?: true }),
    types: () => bus.published.map((p) => p.type),
  };
}
export type S = ReturnType<typeof setup>;

// ---- the events a provisional think reacts to ----

export const EARLY = "hey Coco what time";
export const FINAL = "hey Coco what time is it?";
type FocusInput = EventInput<"attention.focus">;

/** A provisional `attention.focus` on the early text of utterance `u1`, `seq` 0. */
export const provisional = (over: Partial<FocusInput> = {}): BusEvent<"attention.focus"> =>
  event("attention.focus", {
    reason: "mentioned", score: 1, provisional: true, utteranceId: "u1", seq: 0, timing: { audioEndedAt: 100 },
    focus: { kind: "speech", source: "mic", who: "Chris", text: EARLY, mention: false }, ...over,
  }, "salience");
/** An ordinary `attention.focus`; for the same utterance and text as `provisional()` it is a confirmation (CTX-PROV-020). */
export const ordinary = (over: Partial<FocusInput> = {}): BusEvent<"attention.focus"> =>
  event("attention.focus", {
    reason: "mentioned", score: 1, utteranceId: "u1", timing: { audioEndedAt: 150, closedAt: 140, heardAt: 160 },
    focus: { kind: "speech", source: "mic", who: "Chris", text: EARLY, mention: false }, ...over,
  }, "salience");
type Resolve = EventInput<"attention.resolve">;
export const confirm = (over: Record<string, unknown> = {}): BusEvent<"attention.resolve"> =>
  event("attention.resolve", {
    utteranceId: "u1", seq: 0, outcome: "confirm", reason: "mentioned", score: 1,
    focus: { kind: "speech", source: "mic", who: "Chris", text: FINAL, mention: false },
    timing: { audioEndedAt: 150, closedAt: 140, heardAt: 160 }, ...over,
  } as Resolve, "salience");
export const withdraw = (reason: "resumed" | "muted" | "paused" | "forgotten" | "superseded" | "timeout" = "resumed", over: Record<string, unknown> = {}): BusEvent<"attention.resolve"> =>
  event("attention.resolve", { utteranceId: "u1", seq: 0, outcome: "withdraw", reason, ...over } as Resolve, "salience");
export const chatFocus = (): BusEvent<"attention.focus"> =>
  event("attention.focus", { reason: "engaged", score: 1, focus: { kind: "chat", who: "bob", platform: "twitch", text: "hello there Coco", mention: false } }, "salience");
export const control = (cmd: string, extra: Record<string, unknown> = {}) => event("control", { cmd, ...extra } as never);

/** A reflex line of salience's: pending until `endOther`. */
export const other = (s: S, id = "reflex") => s.cortex.onEvent(event("brain.say", { id, text: "a reflex line", emotion: "neutral" }, "salience"));
export const endOther = (s: S, id = "reflex") => s.cortex.onEvent(event("voice.done", { id, seq: 0, sink: "x" }));

/** Waits for the model's `n`th stream to stop and the think to take what it read. */
export async function streamed(s: S, n = 0): Promise<void> {
  await waitFor(() => s.llm.ended[n] === true, `stream ${n} ended`);
  await sleep(20);
}
/** Waits for the model's `n`th stream to open and the think to take its first text. */
export async function opened(s: S, n = 0): Promise<void> {
  await waitFor(() => s.llm.calls.length > n, `stream ${n} opened`);
  await sleep(20);
}
/** The user message of the model's `n`th call, which holds the transcript. */
export const userMsg = (s: S, n = 0): string => s.llm.calls[n]!.find((m) => m.role === "user")!.content as string;
export const systemMsg = (s: S, n = 0): string => s.llm.calls[n]![0]!.content as string;
/** An event as plain JSON, so an absent member and an `undefined` one compare alike. */
export const J = <T>(x: T): T => JSON.parse(JSON.stringify(x));
