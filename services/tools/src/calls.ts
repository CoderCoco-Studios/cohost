/**
 * The call pipeline: look up, admit, confirm, call, shape, publish (TOOL-CALL-001). Each `tool.request` ends in
 * exactly one `tool.result` (TOOL-SVC-007); a result is never retried (TOOL-CALL-020).
 */
import type { BusEvent, EventInput } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import { type KnownTool, type Mode, type Snapshot } from "./catalog.js";
import type { SourceCallResult } from "./source.js";

export type ToolRequest = BusEvent<"tool.request">["data"];
export type Origin = ToolRequest["origin"];
export type ToolResult = EventInput<"tool.result">;
export type ConfirmRequest = EventInput<"tool.confirm">;
type Status = ToolResult["status"];
type Reason = NonNullable<ToolResult["reason"]>;

export interface CallLimits {
  timeoutMs: number;
  confirmTimeoutMs: number;
  maxConcurrent: number;
  maxResultChars: number;
}

export interface CallDeps {
  mode: Mode;
  limits: CallLimits;
  /** The catalog as it is now, read at each request (TOOL-ORIG-006: the service's own catalog). */
  snapshot: () => Snapshot;
  publish: (result: ToolResult) => void;
  publishConfirm: (confirm: ConfirmRequest) => void;
  log: Pick<Logger, "info" | "warn">;
}

/** The sentence the service writes for each refusal (TOOL-CALL-018); no text from a server. */
const REFUSAL_TEXT: Record<Extract<Reason, "unknown_tool" | "not_enabled" | "acts_not_allowed" | "not_approved" | "definition_changed" | "server_down" | "origin_not_allowed" | "invalid_arguments" | "busy" | "denied" | "unconfirmed" | "shutdown">, string> = {
  unknown_tool: "No tool of that name is known.",
  not_enabled: "That tool is not enabled.",
  acts_not_allowed: "That tool acts, and the owner has not allowed it to.",
  not_approved: "The owner has not approved that tool yet.",
  definition_changed: "That tool changed after the owner approved it.",
  server_down: "The server for that tool is not connected.",
  origin_not_allowed: "That tool is not allowed for this reply.",
  invalid_arguments: "The arguments for that tool were not accepted.",
  busy: "Too many tool calls are running; try again later.",
  denied: "The owner denied that call.",
  unconfirmed: "The owner did not confirm that call in time.",
  shutdown: "The tool service is stopping.",
};
const TIMEOUT_TEXT = "The tool did not answer within its time limit.";
const UNAVAILABLE_TEXT = "The tool could not be reached.";

/** The content types a bracketed note names; any other type from a server is `other` (TOOL-CALL-013). */
const NOTE_TYPES: ReadonlySet<string> = new Set(["image", "audio", "resource"]);
/** The most argument bytes a call accepts (TOOL-CALL-021). */
export const ARGUMENTS_MAX_BYTES = 64 * 1024;

interface Outcome {
  status: Status;
  reason?: Reason;
  content: string;
  truncated?: boolean;
}

type Decision = "allow" | "deny" | "expired" | "shutdown";
const DECISION_OUTCOME: Record<Exclude<Decision, "allow">, Outcome> = {
  deny: { status: "refused", reason: "denied", content: REFUSAL_TEXT.denied },
  expired: { status: "refused", reason: "unconfirmed", content: REFUSAL_TEXT.unconfirmed },
  shutdown: { status: "refused", reason: "shutdown", content: REFUSAL_TEXT.shutdown },
};

/** An admitted request: its slot is held until its result is published. */
interface Admitted {
  /** Publishes `refused` `shutdown` and cancels the call (TOOL-SVC-008). */
  stop: () => void;
}

/** A pending confirmation: the window's end, and how to end the wait (TOOL-CONF-005, TOOL-CONF-007). */
interface Pending {
  expiresAt: number;
  decide: (d: Decision) => void;
}

/** What `handle` gives its body: the outcome helpers, and a way to record the admitted entry it owns. */
interface Helpers {
  finish: (o: Outcome) => ToolResult;
  refuse: (reason: Extract<Reason, keyof typeof REFUSAL_TEXT>) => ToolResult;
  admit: (entry: Admitted) => void;
}

/** The origin table (TOOL-ORIG-002 to TOOL-ORIG-005): the one definition of who may call which tool. */
// @spec TOOL-ORIG-002, TOOL-ORIG-003, TOOL-ORIG-004, TOOL-ORIG-005
export function originAllows(tool: KnownTool, origin: Origin): boolean {
  switch (origin) {
    case "speech":
    case "dashboard":
      return true;
    case "reminder":
      return tool.effect === "read";
    case "chat":
    case "guest":
      return tool.chat && tool.effect === "read";
    default:
      return false; // vision and idle
  }
}

/** The shaped text and status of a source's answer (TOOL-CALL-013 to TOOL-CALL-016). */
// @spec TOOL-CALL-013, TOOL-CALL-014, TOOL-CALL-015, TOOL-CALL-016
export function shape(r: SourceCallResult, maxChars: number): Outcome {
  const texts: string[] = [];
  const notes: string[] = [];
  for (const part of r.content ?? []) {
    if (part.type === "text") texts.push(typeof part.text === "string" ? part.text : "");
    else notes.push(`[${NOTE_TYPES.has(part.type) ? part.type : "other"}]`);
  }
  let body = texts.join("\n");
  if (texts.length === 0 && r.structuredContent !== undefined) body = JSON.stringify(r.structuredContent) ?? "";
  let content = [body, notes.join(" ")].filter((x) => x.length > 0).join(" ");
  let truncated = false;
  if (content.length > maxChars) {
    content = `${content.slice(0, maxChars - 1)}…`;
    truncated = true;
  }
  if (r.isError === true) return { status: "error", reason: "tool_error", content, truncated };
  return { status: "ok", content, truncated };
}

export class CallPipeline {
  private readonly admitted = new Map<string, Admitted>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: CallDeps) {}

  /**
   * Runs one request through the pipeline and publishes its one result. `readAt` is the performance clock and
   * `readWall` the epoch time at which the service read the request. Resolves with the published result, or
   * `undefined` for a duplicate id, which publishes nothing (TOOL-CALL-022).
   */
  // @spec TOOL-CALL-001, TOOL-CALL-019, TOOL-CALL-020, TOOL-CALL-022, TOOL-SVC-007, TOOL-ORIG-001, TOOL-ORIG-006
  async handle(req: ToolRequest, readAt: number, readWall: number): Promise<ToolResult | undefined> {
    if (this.admitted.has(req.id)) {
      this.deps.log.warn({ id: req.id }, "duplicate tool.request id while the first is admitted: no result published");
      return undefined;
    }
    let published: ToolResult | undefined;
    let mine: Admitted | undefined;
    // Frees only this request's own entry (a map entry is never another request's to delete).
    const finish = (o: Outcome): ToolResult => {
      if (published !== undefined) return published;
      if (mine !== undefined && this.admitted.get(req.id) === mine) this.admitted.delete(req.id);
      const durationMs = Math.round(performance.now() - readAt);
      const result: ToolResult = {
        id: req.id,
        tool: req.tool,
        status: o.status,
        ...(o.reason !== undefined ? { reason: o.reason } : {}),
        content: o.content,
        durationMs,
        ...(o.truncated === true ? { truncated: true as const } : {}),
        ...(this.deps.mode === "mock" ? { mock: true as const } : {}),
      };
      published = result;
      this.deps.publish(result);
      // TOOL-SVC-009: the tool, the origin, the status and the duration only.
      this.deps.log.info({ tool: req.tool, origin: req.origin, status: o.status, durationMs }, "tool call ended");
      return result;
    };
    const refuse = (reason: Extract<Reason, keyof typeof REFUSAL_TEXT>): ToolResult =>
      finish({ status: "refused", reason, content: REFUSAL_TEXT[reason] });
    try {
      return await this.run(req, readAt, readWall, {
        finish,
        refuse,
        admit: (entry) => { mine = entry; },
      });
    } catch {
      // A source or a snapshot that fails in the service's own code still ends the request with one result (TOOL-CALL-012).
      return finish({ status: "error", reason: "unavailable", content: UNAVAILABLE_TEXT });
    }
  }

  private async run(
    req: ToolRequest,
    readAt: number,
    readWall: number,
    h: Helpers,
  ): Promise<ToolResult> {
    const { finish, refuse } = h;

    // 1. Look up (TOOL-CALL-001 order).
    const known = this.deps.snapshot().byName.get(req.tool);
    if (known === undefined) return refuse("unknown_tool"); // TOOL-CALL-002
    if (!known.enabled) return refuse("not_enabled");
    if (known.label !== "read" && !known.acts) return refuse("acts_not_allowed"); // TOOL-CALL-003
    if (this.deps.mode === "live") { // TOOL-CALL-004: no pin is checked in mock mode
      if (known.recordedHash === "") return refuse("not_approved");
      if (known.hash !== known.recordedHash) return refuse("definition_changed");
    }
    if (known.serverState === "down" || known.serverState === "auth") return refuse("server_down"); // TOOL-CALL-005
    if (!originAllows(known, req.origin)) return refuse("origin_not_allowed"); // TOOL-CALL-006
    if (Buffer.byteLength(JSON.stringify(req.arguments) ?? "", "utf8") > ARGUMENTS_MAX_BYTES) return refuse("invalid_arguments"); // TOOL-CALL-021

    // 2. Admit (TOOL-CALL-009): a confirmation waiting holds a slot too.
    if (this.admitted.size >= this.deps.limits.maxConcurrent) return refuse("busy");
    const ctl = new AbortController();
    const entry: Admitted = {
      stop: () => {
        finish({ status: "refused", reason: "shutdown", content: REFUSAL_TEXT.shutdown });
        ctl.abort();
      },
    };
    this.admitted.set(req.id, entry);
    h.admit(entry);

    // 3. Confirm (TOOL-CONF-001, TOOL-CONF-006, TOOL-CONF-008). The built-in timer is not in this set.
    const skip = !known.confirm && req.round === 1 && !req.injected
      && (req.origin === "dashboard" || (req.origin === "speech" && req.listed));
    if (known.effect === "acts" && this.deps.mode === "live" && !skip) {
      const decision = await this.confirm(req, readWall + this.deps.limits.confirmTimeoutMs); // TOOL-CONF-002
      if (decision !== "allow") return finish(DECISION_OUTCOME[decision]);
    }

    // 4. Call (TOOL-CALL-010, TOOL-CALL-011): the call limit starts when the call is sent.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), this.deps.limits.timeoutMs);
      });
      const sent = (async () => known.source.call(known.own, req.arguments, ctl.signal))();
      const outcome = await Promise.race([
        sent.then((r) => ({ kind: "answer" as const, r }), () => ({ kind: "failed" as const })),
        timedOut,
      ]);
      if (outcome.kind === "timeout") {
        ctl.abort();
        return finish({ status: "timeout", content: TIMEOUT_TEXT });
      }
      if (outcome.kind === "failed") return finish({ status: "error", reason: "unavailable", content: UNAVAILABLE_TEXT }); // TOOL-CALL-012

      // 5. Shape (a malformed result throws here and ends as unavailable) and 6. publish (TOOL-CALL-019).
      return finish(shape(outcome.r, this.deps.limits.maxResultChars));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Publishes `tool.confirm` and waits for one answer or the window's end (TOOL-CONF-003 to TOOL-CONF-005). */
  // @spec TOOL-CONF-001, TOOL-CONF-002, TOOL-CONF-005, TOOL-CONF-007
  private confirm(req: ToolRequest, expiresAt: number): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const decide = (d: Decision): void => {
        clearTimeout(timer);
        if (this.pending.get(req.id)?.decide === decide) this.pending.delete(req.id);
        resolve(d);
      };
      const timer = setTimeout(() => decide("expired"), Math.max(0, expiresAt - Date.now()));
      this.pending.set(req.id, { expiresAt, decide });
      this.deps.publishConfirm({ id: req.id, tool: req.tool, arguments: req.arguments, origin: req.origin, expiresAt });
    });
  }

  /**
   * The owner's answer to a pending call. One answer per call: the first decides and the call is no longer pending.
   * An answer for an unknown, finished or already answered call is ignored, and so is one that arrives after the
   * window's end, even before the window's timer has fired (TOOL-CONF-007).
   */
  // @spec TOOL-CONF-003, TOOL-CONF-004, TOOL-CONF-007
  answer(id: string, allow: boolean): void {
    const p = this.pending.get(id);
    if (p === undefined) return;
    if (Date.now() > p.expiresAt) return;
    p.decide(allow ? "allow" : "deny");
  }

  /** Ends every request in flight and every pending confirmation with `refused` `shutdown` (TOOL-SVC-008). */
  // @spec TOOL-SVC-008
  shutdown(): void {
    for (const p of [...this.pending.values()]) p.decide("shutdown");
    for (const a of [...this.admitted.values()]) a.stop();
  }
}
