/**
 * Shared harness of the MCP client tests. Not a test file.
 *
 * These tests fix the seams the MCP client must offer, as `helpers.ts` does for the pipeline:
 *
 * - `runTools(env)` builds the live sources itself when `env.createSources` is absent: one MCP source per `tools.servers`
 *   entry (`src/mcp.ts`), none in mock mode.
 * - `env.mcp` is the client's own seam: `retry` is a `Partial<RetryOptions>` handed to the shared `retryWithBackoff`
 *   (`baseMs`, `maxMs`, `sleep`), and `setupTimeoutMs` bounds one initialize or list request of a connection attempt.
 */
import { definitionHash, labelOf } from "../src/catalog.js";
import { FakeBus } from "@cohost/testing";
import { startTools, waitFor, type Started } from "./helpers.js";
import { toolJson, type FakeMcp, type ToolJson } from "./mcp-server.js";

export { waitFor, toolJson };
export type { Started };

/** The pin the catalog computes for the tool a server lists as `tool`, for the server called `server`. */
export function pinOfJson(tool: ToolJson, server = "search"): string {
  const hint = (tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint;
  return definitionHash({
    name: `${server}__${String(tool.name)}`,
    title: typeof tool.title === "string" ? tool.title : undefined,
    description: typeof tool.description === "string" ? tool.description : "",
    parameters: tool.inputSchema as Record<string, unknown>,
    label: labelOf(typeof hint === "boolean" ? hint : undefined),
  });
}

/** An enabled, approved `tools.allow` entry for the tool a server lists as `tool`. */
export const approved = (tool: ToolJson, over: Record<string, unknown> = {}, server = "search") => ({ enabled: true, hash: pinOfJson(tool, server), ...over });

/** The shared-backoff delays as a test drives them: `sleep` waits until the test releases it. */
export class Backoff {
  delays: number[] = [];
  private waiting: (() => void)[] = [];
  sleep = (ms: number): Promise<void> => new Promise((resolve) => { this.delays.push(ms); this.waiting.push(resolve); });
  /** Resolves when the client is waiting out a delay. */
  next(): Promise<void> { return waitFor(() => this.waiting.length > 0, "the client waiting out a backoff delay"); }
  /** Ends every wait in progress. */
  release(): void { for (const r of this.waiting.splice(0)) r(); }
  get retry() { return { baseMs: 7, maxMs: 50, sleep: this.sleep }; }
}

/** Fast real timers for tests that are not about the delays. */
export const fastRetry = { baseMs: 5, maxMs: 20 };

/** A `tools.servers` entry for a fake server. */
export const entry = (srv: FakeMcp, over: Record<string, unknown> = {}) => ({ url: srv.url, ...over });

/** Starts the service on a ToolsFakeBus with the real MCP client. */
export function startMcp(
  tools: Record<string, unknown>,
  opts: { catalogMs?: number; mcp?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
): Promise<Started> {
  return startTools({ timeout_ms: 5000, ...tools }, [], opts.extra ?? {}, undefined, { mcp: { relistGapMs: 20, retry: fastRetry, ...(opts.mcp ?? {}) }, catalogMs: opts.catalogMs });
}

export const catalogServer = (s: Started, name: string) => s.catalogs().at(-1)?.servers.find((x) => x.name === name);
export const catalogTool = (s: Started, name: string) => s.catalogs().at(-1)?.tools.find((t) => t.name === name);
export const waitServer = (s: Started, name: string, state: string, ms = 4000) =>
  waitFor(() => catalogServer(s, name)?.state === state, `server ${name} ${state}`, ms);
export const lastHealth = (s: Started) => s.bus.health.at(-1)!;

/** Every text the service put out: events, heartbeats and log lines, for a grep. */
export function everythingOut(s: Started): string {
  return JSON.stringify([(s.bus as FakeBus).published, s.bus.health, s.log.lines]);
}
