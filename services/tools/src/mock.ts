/**
 * Mock mode: no MCP server is reached. Each configured server is a mock source whose tools are the `tools.allow`
 * entries named for it, labelled by their `effect` key, and whose calls answer a fixed text with the arguments
 * (TOOL-MOCK-001 to TOOL-MOCK-004).
 */
import type { Config } from "@cohost/config";
import type { SourceCallResult, SourceTool, ToolSource } from "./source.js";

class MockSource implements ToolSource {
  readonly state = "mock" as const;

  constructor(readonly name: string, private readonly tools: SourceTool[]) {}

  list(): SourceTool[] { return this.tools; }

  // @spec TOOL-MOCK-004
  async call(tool: string, args: Record<string, unknown>): Promise<SourceCallResult> {
    return { content: [{ type: "text", text: `mock ${this.name}__${tool} answered ${JSON.stringify(args)}` }] };
  }

  onChange(): void { /* a mock source never changes */ }

  async close(): Promise<void> { /* nothing to close */ }
}

/**
 * The mock sources of the configured servers, in `tools.servers` order. An `allow` entry names its server with the
 * first `__` (server names hold no `_`); an entry for a server that is not configured is no tool (TOOL-MOCK-003).
 */
// @spec TOOL-MOCK-001, TOOL-MOCK-002, TOOL-MOCK-003
export function mockSources(cfg: Config): ToolSource[] {
  const allowed = Object.entries(cfg.tools.allow);
  return Object.keys(cfg.tools.servers).map((server) => {
    const tools: SourceTool[] = [];
    for (const [key, entry] of allowed) {
      const at = key.indexOf("__");
      if (at < 0 || key.slice(0, at) !== server) continue;
      const readOnlyHint = entry.effect === "read" ? true : entry.effect === "acts" ? false : undefined;
      tools.push({ name: key.slice(at + 2), description: "a mock tool", parameters: { type: "object" }, readOnlyHint });
    }
    return new MockSource(server, tools);
  });
}
