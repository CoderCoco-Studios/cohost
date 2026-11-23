/**
 * Shared harness of the tools service tests. Not a test file.
 *
 * These tests fix the seams the implementation must offer (the issue's "internal ToolSource interface"):
 *
 * - `../src/main.js` exports `runTools(env: ToolsEnv)`, modelled on `runSalience`: `env` carries the `runService`
 *   replacements (`loadConfig`, `createBus`, `onShutdown`, `exit`, `log`, `stopTimeoutMs`) and `createSources`,
 *   which builds the live tool sources from the config. It is not called in mock mode (no connection is opened).
 * - `../src/source.js` exports the types `ToolSource`, `SourceTool` and `SourceCallResult` used below.
 */
import { after } from "node:test";
import { event, FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import type { EventType, Handler, SubscribeOptions } from "@cohost/bus";
import { runTools, type ToolsBus } from "../src/main.js";
import type { SourceCallResult, SourceTool, ToolSource } from "../src/source.js";

export { event, waitFor };

/** A FakeBus that records the consumer-group calls and the Redis-side calls `main` makes, with the subscription handler kept. */
export class ToolsFakeBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeOptions<EventType>[] = [];
  handler?: Handler<EventType>;
  stopped = false;
  async resetGroup(group: string): Promise<void> { this.calls.push(`resetGroup:${group}`); }
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    this.calls.push(`subscribe:${opts.group}`);
    this.subscribed.push(opts as SubscribeOptions<EventType>);
    this.handler = handler as unknown as Handler<EventType>;
  }
  override async putTimer(id: string, json: string): Promise<void> { this.calls.push("putTimer"); return super.putTimer(id, json); }
  override async deleteTimer(id: string): Promise<void> { this.calls.push("deleteTimer"); return super.deleteTimer(id); }
  override async listTimers(): Promise<{ id: string; json: string }[]> { this.calls.push("listTimers"); return super.listTimers(); }
  stop(): void { this.calls.push("bus.stop"); this.stopped = true; }
}

/** A tool source whose behaviour the test scripts: it stands for an MCP server (live) and records every call it gets. */
export class FakeSource implements ToolSource {
  state: "ok" | "down" | "auth" | "mock" = "ok";
  detail: string | undefined;
  calls: { tool: string; args: Record<string, unknown>; signal: AbortSignal }[] = [];
  closed = false;
  private listeners: (() => void)[] = [];
  constructor(
    readonly name: string,
    public defs: SourceTool[],
    public impl: (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<SourceCallResult> = async (tool) => text(`ran ${tool}`),
    private onClose: () => void = () => {},
  ) {}
  list(): SourceTool[] { return this.defs; }
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult> {
    this.calls.push({ tool, args, signal });
    return this.impl(tool, args, signal);
  }
  onChange(cb: () => void): void { this.listeners.push(cb); }
  /** Tell the service the server's tools or state changed. */
  change(): void { for (const l of this.listeners) l(); }
  async close(): Promise<void> { this.closed = true; this.onClose(); }
}

/**
 * A source definition: the server's own tool name, `hint` as its `readOnlyHint` annotation, and the hash the source computes.
 * `null` as `hint` means the server gives no annotation (label `unlabelled`); `undefined` is not a value here (a default parameter would
 * take it for `true`).
 */
export function def(own: string, over: Partial<SourceTool> = {}, hint: boolean | null = true): SourceTool {
  return { name: own, description: `desc of ${own}`, parameters: { type: "object" }, readOnlyHint: hint ?? undefined, hash: `h-${own}`, ...over };
}
export const text = (t: string): SourceCallResult => ({ content: [{ type: "text", text: t }] });
/** A call that never answers until the abort signal fires, then rejects as an aborted fetch does. */
export const hang = (_t: string, _a: unknown, signal: AbortSignal): Promise<SourceCallResult> =>
  new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
/** A call that never settles at all, even on abort. */
export const stuck = (): Promise<SourceCallResult> => new Promise(() => {});

export const SERVER_URL = "https://search.example.com/mcp";
/** The `tools.servers` entry of the usual fixture server `search`. */
export const search = { url: SERVER_URL };
/** An approved, enabled, read-only entry for the fixture tool `search__<own>`. */
export const on = (own: string, over: Record<string, unknown> = {}) => ({ enabled: true, hash: `h-${own}`, ...over });

export interface Started {
  bus: ToolsFakeBus;
  /** The teardown steps `runService` registered with `onShutdown`. */
  shutdown: (() => void | Promise<void>)[];
  exits: number[];
  log: ReturnType<typeof recordingLog>;
  sourcesBuilt: number;
  /** Publish a bus event to the service's subscription handler. */
  send: <T extends EventType>(type: T, data: Parameters<typeof event<T>>[1]) => Promise<void>;
  request: (over?: Record<string, unknown>) => Promise<string>;
  answer: (id: string, allow: boolean) => Promise<void>;
  results: () => ReturnType<ToolsFakeBus["of"]> & Record<string, unknown>[];
  catalogs: () => { servers: any[]; tools: any[]; mode: string; intervalMs: number }[];
  /** The latest catalog's entry for a tool. */
  entry: (name: string) => any;
  stop: () => Promise<void>;
  cfgLoads: number;
}

/** Every service a test started and did not stop: stopped after the file's tests, so a failing test cannot keep the runner alive. */
const started: Started[] = [];
after(async () => { for (const s of started) await s.stop(); });

let seq = 0;
/** Starts the service on a ToolsFakeBus with `tools` as the config section and `extra` as other sections. */
export async function startTools(
  tools: Record<string, unknown> = {},
  sources: ToolSource[] = [],
  extra: Record<string, unknown> = {},
  bus: ToolsFakeBus = new ToolsFakeBus(),
): Promise<Started> {
  const shutdown: (() => void | Promise<void>)[] = [];
  let stopped = false;
  const exits: number[] = [];
  const log = recordingLog();
  const s: Started = {
    bus, shutdown, exits, log, sourcesBuilt: 0, cfgLoads: 0,
    send: async (type, data) => { await bus.handler!(event(type, data) as never); },
    request: async (over = {}) => {
      const id = `req-${++seq}`;
      await s.send("tool.request", { id, tool: "search__web", arguments: {}, origin: "speech", round: 1, listed: false, ...over } as never);
      return id;
    },
    answer: (id, allow) => s.send("tool.answer", { id, allow }),
    results: () => bus.of("tool.result") as never,
    catalogs: () => bus.of("tool.catalog") as never,
    entry: (name) => s.catalogs().at(-1)!.tools.find((t) => t.name === name),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      for (const fn of [...shutdown].reverse()) await fn();
    },
  };
  await runTools({
    loadConfig: () => { s.cfgLoads++; return testConfig({ ...extra, tools }); },
    createBus: () => bus as unknown as ToolsBus,
    onShutdown: (fn: () => void | Promise<void>) => { shutdown.push(fn); },
    exit: (code: number) => { exits.push(code); },
    log: log.log,
    createSources: () => { s.sourcesBuilt++; return sources; },
  } as never);
  started.push(s);
  return s;
}

/** The result for `id`, once published. */
export async function resultOf(s: Started, id: string): Promise<Record<string, any>> {
  await waitFor(() => s.results().some((r) => r.id === id), `result ${id}`);
  return s.results().find((r) => r.id === id)!;
}
