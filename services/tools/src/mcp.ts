/**
 * The MCP client: one Streamable HTTP session per configured server (TOOL-MCP-001 to TOOL-MCP-028). A small client written over
 * `fetch`: initialize, the initialized notification, tools/list (paged), tools/call, the cancellation notification and the
 * optional GET stream for server notifications. A server is untrusted, so every answer is read to a cap, no redirect is
 * followed, a response is matched to its request by JSON-RPC id, and no text from a server reaches an event, a log line, a
 * detail or an error sentence: the text the owner and the model see is written here, and a result's content is the server's
 * only through the tool result itself.
 */
import { retryWithBackoff, type RetryOptions } from "@cohost/shared";
import type { Config } from "@cohost/config";
import { serverExternal } from "./catalog.js";
import { SourceFailed, type SourceCallResult, type SourceContentPart, type SourceState, type SourceTool, type ToolSource } from "./source.js";

/** The protocol version the client asks for at initialize. */
export const PROTOCOL_VERSION = "2025-06-18";

/** The seam of the MCP client a test or the service's own wiring may set (`ToolsEnv.mcp`). */
export interface McpEnv {
  /** The shared backoff's options: a partial of `RetryOptions` (`baseMs`, `maxMs`, `sleep`). */
  retry?: Partial<RetryOptions>;
  /** How long one initialize or list request of a connection attempt may take before the attempt fails. */
  setupTimeoutMs?: number;
}

/** The fixed limits of the transport: not settings. */
const SETUP_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 5_000;
const DELETE_TIMEOUT_MS = 1_000;
/** The most bytes of one response body, and of one stream event that never ends (TOOL-MCP-012, TOOL-MCP-016). */
const BODY_CAP = 1024 * 1024;
/** The most pages of one tools/list (TOOL-MCP-015) and the most raw tool entries across them. */
const MAX_PAGES = 50;
const MAX_RAW_TOOLS = 10_000;
const SESSION_HEADER = "mcp-session-id";
const DEFAULT_RETRY: RetryOptions = { baseMs: 1000, maxMs: 60_000 };

/** The sentences the service writes for the failures a call can show (TOOL-CALL-012). */
const TOO_LARGE_TEXT = "The server's response was too large and was not used.";
const REDIRECT_TEXT = "The server answered with a redirect, which is not followed.";
const SERVER_ERROR_TEXT = "The tool's server reported an error for that call.";

/** A failed request or session: the server is down until it is reconnected (TOOL-MCP-003). */
class Down extends Error {}
/** A 401 or 403: the server is `auth` (TOOL-MCP-006). */
class Refused extends Error {}
/** A 3xx answer: an error for the request, never followed (TOOL-MCP-013). */
class Redirected extends Error {}
/** A response body over the cap (TOOL-MCP-012). */
class TooLarge extends Error {}
/** A JSON-RPC error answer (TOOL-CALL-012). */
class RpcError extends Error {}

/** One connection: a session, its stream and its list timer, ended once (lost or stopped). */
interface Conn {
  session: string | undefined;
  ctl: AbortController;
  timer?: ReturnType<typeof setInterval>;
  lostBy?: "down" | "auth";
  lost: Promise<void>;
  end: () => void;
}

/** A JSON object, not an array and not null. */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Discards a body the client will not read, so its socket is released. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * The data of each complete `message` event of a stream, in order. Only `message` events (and events with no name) are read:
 * a legacy `endpoint` event is never used to pick an address (TOOL-MCP-022). A body over `cap` bytes stops the read. A stream
 * (`streaming`) is open-ended, so only one unfinished event is capped, not the total.
 */
// @spec TOOL-MCP-012, TOOL-MCP-022
async function* eventData(res: Response, streaming: boolean): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return;
  const dec = new TextDecoder();
  let buf = "";
  let total = 0;
  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try { chunk = await reader.read(); } catch { throw new Down(); }
      if (chunk.done) break;
      total += chunk.value!.byteLength;
      if (!streaming && total > BODY_CAP) throw new TooLarge();
      buf += dec.decode(chunk.value!, { stream: true });
      let m: RegExpMatchArray | null;
      while ((m = buf.match(/\r?\n\r?\n/)) !== null) {
        const block = buf.slice(0, m.index ?? 0);
        buf = buf.slice((m.index ?? 0) + m[0].length);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if ((event === "message" || event === "") && data.length > 0) yield data.join("\n");
      }
      if (streaming && buf.length > BODY_CAP) throw new TooLarge();
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The text of a body read to the cap (TOOL-MCP-012). */
async function readBody(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: { done: boolean; value?: Uint8Array };
    try { chunk = await reader.read(); } catch { throw new Down(); }
    if (chunk.done) break;
    total += chunk.value!.byteLength;
    if (total > BODY_CAP) {
      await reader.cancel().catch(() => undefined);
      throw new TooLarge();
    }
    chunks.push(chunk.value!);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The tools of a list as the client keeps them. A name is taken once (the first definition wins), a schema that is not an
 * object leaves the tool out, a non-string title is dropped, a non-boolean `readOnlyHint` is no annotation, and a
 * non-string description is empty (TOOL-MCP-017 to TOOL-MCP-020). The catalog applies the rest of the rules to these.
 */
// @spec TOOL-MCP-017, TOOL-MCP-018, TOOL-MCP-019, TOOL-MCP-020
export function toSourceTools(raw: readonly unknown[]): SourceTool[] {
  const out: SourceTool[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isObj(item) || typeof item.name !== "string") continue;
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    if (!isObj(item.inputSchema)) continue;
    const hint = isObj(item.annotations) ? item.annotations.readOnlyHint : undefined;
    out.push({
      name: item.name,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      description: typeof item.description === "string" ? item.description : "",
      parameters: item.inputSchema,
      ...(typeof hint === "boolean" ? { readOnlyHint: hint } : {}),
    });
  }
  return out;
}

/**
 * The call result of a tools/call answer. Only the content's text and types are kept; a resource link is never fetched and
 * is reported by its type alone (TOOL-MCP-023).
 */
// @spec TOOL-MCP-023
function toCallResult(v: unknown): SourceCallResult {
  if (!isObj(v) || !Array.isArray(v.content)) throw new Down();
  const content: SourceContentPart[] = [];
  for (const p of v.content) {
    if (!isObj(p)) { content.push({ type: "" }); continue; }
    content.push({ type: typeof p.type === "string" ? p.type : "", text: typeof p.text === "string" ? p.text : undefined });
  }
  return {
    content,
    ...(v.structuredContent !== undefined ? { structuredContent: v.structuredContent } : {}),
    ...(v.isError === true ? { isError: true } : {}),
  };
}

/** The header of the owner's secret (TOOL-MCP-005): `Authorization` by default, `Bearer` for that name only. */
// @spec TOOL-MCP-005
function secretHeader(header: string, token: string): Record<string, string> {
  if (token === "") return {};
  const name = header.trim() === "" ? "Authorization" : header;
  const value = name.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
  return { [name]: value };
}

/**
 * One configured server as a source of tools: one Streamable HTTP session at a time, reconnected with the shared backoff
 * when it drops (TOOL-MCP-001 to TOOL-MCP-004). It starts no process and reads no environment; the URL and the secret come
 * from `tools.servers.<name>`.
 */
// @spec TOOL-MCP-001, TOOL-MCP-002, TOOL-MCP-003
export class McpSource implements ToolSource {
  readonly name: string;
  readonly detail: string | undefined;
  private current: SourceState = "down";
  private tools: SourceTool[] = [];
  private conn: Conn | undefined;
  private readonly url: string;
  private readonly header: string;
  private readonly token: string;
  private readonly tokenOk: boolean;
  private readonly retry: RetryOptions;
  private readonly setupMs: number;
  private readonly catalogMs: number;
  private readonly stopCtl = new AbortController();
  private stopping = false;
  private started = false;
  private nextId = 0;
  private readonly listeners: (() => void)[] = [];

  constructor(name: string, entry: { url: string; header: string; token: string; external: boolean }, cfg: Config, env: McpEnv = {}) {
    this.name = name;
    this.url = entry.url;
    this.header = entry.header;
    this.token = entry.token;
    // A secret with a control character cannot be a header value: it is never sent (TOOL-MCP-005).
    this.tokenOk = !/[\u0000-\u001f\u007f]/.test(entry.token);
    this.retry = { ...DEFAULT_RETRY, ...env.retry };
    this.setupMs = env.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
    this.catalogMs = cfg.tools.catalog_ms;
    // TOOL-MCP-008: a plain http server off the LAN that is sent a secret is noted; the connection still goes ahead.
    const plain = new URL(entry.url).protocol === "http:";
    this.detail = plain && entry.token !== "" && serverExternal(entry, cfg.network?.lan ?? []) ? "credential sent without TLS" : undefined;
  }

  get state(): SourceState { return this.current; }

  list(): SourceTool[] { return this.tools; }

  onChange(listener: () => void): void { this.listeners.push(listener); }

  /** Connects in the background; the reconnect loop runs until the source is closed (TOOL-MCP-002, TOOL-MCP-003). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.supervise();
  }

  private emit(): void {
    for (const l of this.listeners) {
      try { l(); } catch { /* a listener that throws must not end the connection */ }
    }
  }

  private setState(s: SourceState): void {
    if (this.stopping || this.current === s) return;
    this.current = s;
    this.emit();
  }

  /** Connects, waits until the connection is lost, and connects again, until the source is closed. */
  private async supervise(): Promise<void> {
    let delayFirst = false;
    while (!this.stopping) {
      const conn: Conn | undefined = await retryWithBackoff(() => this.connect(), {
        ...this.retry,
        isStopped: () => this.stopping,
        // After a refused credential the first retry waits one base delay, so `auth` shows until a reconnect succeeds.
        firstDelayMs: delayFirst ? this.retry.baseMs : 0,
        onFailure: (err) => { if (!this.stopping) this.setState(err instanceof Refused ? "auth" : "down"); },
      });
      if (conn === undefined) return;
      delayFirst = false;
      await conn.lost;
      delayFirst = conn.lostBy === "auth";
    }
  }

  // @spec TOOL-MCP-002, TOOL-MCP-014, TOOL-MCP-021
  private async connect(): Promise<Conn> {
    if (!this.tokenOk) throw new Down();
    const signal = AbortSignal.any([this.stopCtl.signal, AbortSignal.timeout(this.setupMs)]);
    // TOOL-MCP-021: the client declares no capability: no sampling, roots or elicitation.
    const init = await this.exchange({ id: ++this.nextId, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "cohost-tools", version: "1" } } }, undefined, signal);
    if (!isObj(init.result)) throw new Down();
    const session = init.session;
    await this.notify("notifications/initialized", undefined, session, signal);
    const tools = await this.listAll(session, signal);
    const conn: Conn = this.newConn(session);
    this.conn = conn;
    this.tools = tools;
    this.setState("ok");
    this.emit();
    this.openStream(conn);
    conn.timer = setInterval(() => { void this.relist(conn); }, this.catalogMs); // TOOL-MCP-004
    return conn;
  }

  private newConn(session: string | undefined): Conn {
    let end!: () => void;
    const lost = new Promise<void>((r) => { end = r; });
    return { session, ctl: new AbortController(), lost, end };
  }

  /** Ends a connection once: the stream and the timer stop, the state follows, and the supervisor reconnects. */
  private lose(conn: Conn, by: "down" | "auth"): void {
    if (conn.lostBy !== undefined) return;
    conn.lostBy = by;
    if (this.conn === conn) this.conn = undefined;
    clearInterval(conn.timer);
    conn.ctl.abort();
    this.setState(by === "auth" ? "auth" : "down");
    conn.end();
  }

  // @spec TOOL-MCP-004, TOOL-MCP-003
  private async relist(conn: Conn): Promise<void> {
    if (conn.lostBy !== undefined || this.stopping) return;
    const signal = AbortSignal.any([conn.ctl.signal, AbortSignal.timeout(this.setupMs)]);
    try {
      const tools = await this.listAll(conn.session, signal);
      if (conn.lostBy !== undefined) return;
      if (JSON.stringify(tools) !== JSON.stringify(this.tools)) {
        this.tools = tools;
        this.emit();
      }
    } catch (err) {
      this.lose(conn, err instanceof Refused ? "auth" : "down");
    }
  }

  /**
   * Lists every page of tools/list. A page that is not a list, a cursor that is not a string, a cursor seen before, more than
   * 50 pages or more than 10 000 entries is a failed list (TOOL-MCP-015); a response over 1 MiB fails it too, before any tool is
   * taken (TOOL-MCP-016).
   */
  // @spec TOOL-MCP-015, TOOL-MCP-016
  private async listAll(session: string | undefined, signal: AbortSignal): Promise<SourceTool[]> {
    const raw: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new Down();
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, session, signal);
      if (!isObj(result) || !Array.isArray(result.tools)) throw new Down();
      for (const t of result.tools) {
        raw.push(t);
        if (raw.length > MAX_RAW_TOOLS) throw new Down();
      }
      const next = result.nextCursor;
      if (next === undefined || next === null) return toSourceTools(raw);
      if (typeof next !== "string" || next === "" || cursors.has(next)) throw new Down();
      cursors.add(next);
      cursor = next;
    }
  }

  private async request(method: string, params: unknown, session: string | undefined, signal: AbortSignal): Promise<unknown> {
    return (await this.exchange({ id: ++this.nextId, method, params }, session, signal)).result;
  }

  /** The request and its answer: the response whose JSON-RPC id is this request's (TOOL-MCP-024). */
  // @spec TOOL-MCP-024, TOOL-MCP-013
  private async exchange(msg: { id: number; method: string; params?: unknown }, session: string | undefined, signal: AbortSignal): Promise<{ result: unknown; session?: string }> {
    const req = this.linked(signal);
    try {
      const res = await this.send("POST", JSON.stringify({ jsonrpc: "2.0", ...msg }), session, req.signal, "application/json, text/event-stream");
      await this.checkStatus(res);
      const sid = res.headers.get(SESSION_HEADER) ?? undefined;
      const type = res.headers.get("content-type") ?? "";
      let answer: Record<string, unknown> | undefined;
      if (type.includes("text/event-stream")) answer = await this.firstAnswer(res, msg.id);
      else if (type.includes("application/json")) answer = this.parseAnswer(await readBody(res), msg.id);
      else { await discard(res); throw new Down(); }
      if (answer === undefined) throw new Down();
      if (answer.error !== undefined) throw new RpcError();
      if (!("result" in answer)) throw new Down();
      return { result: answer.result, ...(sid !== undefined ? { session: sid } : {}) };
    } finally {
      req.done();
    }
  }

  /** The answer with this id in a JSON body, or undefined when the body is not a JSON-RPC message for it. */
  private parseAnswer(text: string, id: number): Record<string, unknown> | undefined {
    let v: unknown;
    try { v = JSON.parse(text); } catch { return undefined; }
    return isObj(v) && v.id === id ? v : undefined;
  }

  /** The first event of an event-stream reply that answers this id; other messages in it are skipped. */
  private async firstAnswer(res: Response, id: number): Promise<Record<string, unknown> | undefined> {
    for await (const data of eventData(res, false)) {
      let v: unknown;
      try { v = JSON.parse(data); } catch { continue; }
      if (isObj(v) && v.id === id && ("result" in v || "error" in v)) return v;
    }
    return undefined;
  }

  /** Status rules of every request (TOOL-MCP-006, TOOL-MCP-013, TOOL-MCP-026). */
  // @spec TOOL-MCP-006, TOOL-MCP-013, TOOL-MCP-026
  private async checkStatus(res: Response): Promise<void> {
    if (res.status === 401 || res.status === 403) { await discard(res); throw new Refused(); }
    if (res.status >= 300 && res.status < 400) { await discard(res); throw new Redirected(); }
    // Any other non-2xx, a 404 for a session the server forgot included, is a failed request: the connection is replaced
    // and the call is not retried (TOOL-MCP-026).
    if (res.status < 200 || res.status >= 300) { await discard(res); throw new Down(); }
  }

  /** The one place a request leaves: the configured URL only, no redirect followed, the secret header on it (TOOL-MCP-013). */
  // @spec TOOL-MCP-013, TOOL-MCP-005
  private async send(method: "POST" | "GET" | "DELETE", body: string | undefined, session: string | undefined, signal: AbortSignal, accept: string): Promise<Response> {
    const headers: Record<string, string> = { ...secretHeader(this.header, this.token), accept };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (session !== undefined) headers[SESSION_HEADER] = session;
    if (session !== undefined) headers["mcp-protocol-version"] = PROTOCOL_VERSION;
    try {
      return await fetch(this.url, { method, headers, redirect: "manual", signal, ...(body !== undefined ? { body } : {}) });
    } catch {
      throw new Down();
    }
  }

  /** A notification: no id, no answer; the server answers 202 or any 2xx. */
  private async notify(method: string, params: unknown, session: string | undefined, signal: AbortSignal): Promise<void> {
    const req = this.linked(signal);
    try {
      const res = await this.send("POST", JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }), session, req.signal, "application/json, text/event-stream");
      await this.checkStatus(res);
      await discard(res);
    } finally {
      req.done();
    }
  }

  /**
   * An abort signal of the request that the client can end itself: it is aborted when the signal given fires, and `done`
   * aborts the request's own controller so that its socket is released once its answer is read or refused.
   */
  private linked(signal: AbortSignal): { signal: AbortSignal; done: () => void } {
    const ctl = new AbortController();
    const abort = (): void => ctl.abort();
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", abort, { once: true });
    return { signal: ctl.signal, done: () => { signal.removeEventListener("abort", abort); ctl.abort(); } };
  }

  /**
   * The GET stream for server notifications (TOOL-MCP-004). A server that refuses it is fine: the list timer still runs. A
   * `tools/list_changed` notification re-lists. A stream that ends or fails is a lost connection.
   */
  // @spec TOOL-MCP-004, TOOL-MCP-021
  private openStream(conn: Conn): void {
    void (async () => {
      let res: Response;
      try {
        res = await this.send("GET", undefined, conn.session, conn.ctl.signal, "text/event-stream");
      } catch {
        this.lose(conn, "down");
        return;
      }
      if (res.status === 401 || res.status === 403) { await discard(res); this.lose(conn, "auth"); return; }
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) { await discard(res); return; }
      try {
        for await (const data of eventData(res, true)) {
          let v: unknown;
          try { v = JSON.parse(data); } catch { continue; }
          // Server requests on the stream are not answered: the client declares no capability to answer them (TOOL-MCP-021).
          if (isObj(v) && v.method === "notifications/tools/list_changed") void this.relist(conn);
        }
      } catch {
        // a failed or over-long stream ends the connection below
      }
      this.lose(conn, "down");
    })();
  }

  /**
   * One tool call on the current session (TOOL-MCP-025). The call limit (the signal) aborts the request and sends a
   * cancellation, and no reconnect follows it (TOOL-MCP-028). A JSON-RPC error answer is an `error` result and keeps the session
   * (TOOL-MCP-027). A failed request, a session the server forgot and an over-long body reconnect the server and fail the call
   * (TOOL-MCP-026); a 401 or 403 makes it `auth`; a 3xx is an error for the call and changes no state (TOOL-MCP-013).
   */
  // @spec TOOL-MCP-025, TOOL-MCP-026, TOOL-MCP-027, TOOL-MCP-028, TOOL-MCP-013, TOOL-CALL-011, TOOL-CALL-012
  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult> {
    const conn = this.conn;
    if (conn === undefined || this.current !== "ok") throw new Down();
    const id = ++this.nextId;
    const sig = AbortSignal.any([signal, conn.ctl.signal]);
    try {
      const answer = await this.exchange({ id, method: "tools/call", params: { name: tool, arguments: args } }, conn.session, sig);
      return toCallResult(answer.result);
    } catch (err) {
      if (signal.aborted) {
        // The call limit passed: the pipeline has already answered; a best-effort cancellation follows, no reconnect (TOOL-MCP-028).
        if (!this.stopping) this.cancel(conn, id);
        throw new Down();
      }
      if (this.stopping) throw err;
      if (err instanceof RpcError) return { content: [{ type: "text", text: SERVER_ERROR_TEXT }], isError: true };
      if (err instanceof Redirected) throw new SourceFailed(REDIRECT_TEXT);
      if (err instanceof TooLarge) { this.lose(conn, "down"); throw new SourceFailed(TOO_LARGE_TEXT); }
      this.lose(conn, err instanceof Refused ? "auth" : "down");
      throw new Down();
    }
  }

  /** The best-effort cancellation of a call, naming its request id; nothing waits on it (TOOL-CALL-011). */
  // @spec TOOL-CALL-011
  private cancel(conn: Conn, requestId: number): void {
    const signal = AbortSignal.any([this.stopCtl.signal, AbortSignal.timeout(CANCEL_TIMEOUT_MS)]);
    this.notify("notifications/cancelled", { requestId, reason: "the call limit passed" }, conn.session, signal).catch(() => undefined);
  }

  /** Stops the source: the connection attempt, the stream and the timer end, and the session is closed when it can be (TOOL-SVC-008). */
  async close(): Promise<void> {
    this.stopping = true;
    this.stopCtl.abort();
    const conn = this.conn;
    if (conn === undefined) return;
    const session = conn.session;
    this.lose(conn, "down");
    if (session !== undefined) {
      const res = await fetch(this.url, {
        method: "DELETE",
        headers: { ...secretHeader(this.header, this.token), [SESSION_HEADER]: session },
        redirect: "manual",
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      }).catch(() => undefined);
      if (res !== undefined) await discard(res);
    }
  }
}

/** The MCP sources of the configured servers, one per `tools.servers` entry, in its order (TOOL-MCP-002). */
// @spec TOOL-MCP-001, TOOL-MCP-002
export function mcpSources(cfg: Config, env: McpEnv = {}): ToolSource[] {
  return Object.entries(cfg.tools.servers).map(([name, entry]) => new McpSource(name, entry, cfg, env));
}
