/**
 * The seam between the tools service and the sources of its tools: an MCP server (live, #206) or the mock
 * (`mock.ts`). The catalog and the call pipeline see only these types, so a source plugs in without either
 * changing. A source keeps its own connection; it never reads the bus.
 */

/** A source's state: `ok` connected, `down` not reachable, `auth` refused its credential, `mock` a canned source. */
export type SourceState = "ok" | "down" | "auth" | "mock";

/** One tool as its source lists it: the source's own name for it, not the qualified `<server>__<tool>` name. */
export interface SourceTool {
  name: string;
  title?: string | undefined;
  /** The description as the source gives it; the catalog cuts it (TOOL-CAT-003). */
  description: string;
  /** The JSON Schema of the arguments, as the source gives it. */
  parameters: Record<string, unknown>;
  /** The server's `readOnlyHint` annotation; absent when the server gives none (label `unlabelled`). */
  readOnlyHint?: boolean | undefined;
}

/** One content part of a call's result, as the protocol gives it. Only `text` parts carry text. */
export interface SourceContentPart {
  type: string;
  text?: string | undefined;
  [key: string]: unknown;
}

/** What a source answers to one call. */
export interface SourceCallResult {
  content: SourceContentPart[];
  structuredContent?: unknown;
  /** The server flagged the result as an error (TOOL-CALL-016). */
  isError?: boolean | undefined;
}

export interface ToolSource {
  /** The server's name in `tools.servers`. */
  readonly name: string;
  readonly state: SourceState;
  /** An extra sentence for the server's catalog detail, when the source has one to give. */
  readonly detail?: string | undefined;
  /** The tools the source lists now, in the source's own order. */
  list(): SourceTool[];
  /**
   * Calls one tool by its own name. The signal fires when the call limit passes or the service stops; the source
   * sends its cancellation on it. A rejection is a failure of the source (TOOL-CALL-012).
   */
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult>;
  /** Registers a listener the source calls when its tools or its state changed. */
  onChange(listener: () => void): void;
  close(): Promise<void>;
}
