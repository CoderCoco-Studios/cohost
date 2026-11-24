/**
 * The MCP client: one Streamable HTTP session per configured server (TOOL-MCP-001 to TOOL-MCP-028). A small client written over
 * `fetch`: initialize, the initialized notification, tools/list (paged), tools/call, the cancellation notification and the
 * optional GET stream for server notifications. A server is untrusted, so every answer is read to a cap, no redirect is
 * followed, a response is matched to its request by JSON-RPC id, and no text from a server reaches an event, a log line, a
 * detail or an error sentence: the text the owner and the model see is written here, and a result's content is the server's
 * only through the tool result itself.
 */
import { offLanHost, type Config } from "@cohost/config";
import type { RetryOptions } from "@cohost/shared";
import { SourceFailed, type SourceCallResult, type SourceContentPart, type SourceState, type SourceTool, type ToolSource } from "./source.js";

/** The protocol version the client asks for at initialize. */
export const PROTOCOL_VERSION = "2025-06-18";

/** The seam of the MCP client a test or the service's own wiring may set (`ToolsEnv.mcp`). */
export interface McpEnv {
  /** The backoff's options: a partial of `RetryOptions` (`baseMs`, `maxMs`, `sleep`). */
  retry?: Partial<RetryOptions>;
  /** How long one initialize or list request of a connection attempt may take before the attempt fails. */
  setupTimeoutMs?: number;
  /** The least time between two re-lists of one connection (TOOL-MCP-004). */
  relistGapMs?: number;
}

/** The fixed limits of the transport: not settings. */
const SETUP_TIMEOUT_MS = 10_000;
const CANCEL_TIMEOUT_MS = 5_000;
const DELETE_TIMEOUT_MS = 1_000;
/** A connection that stays up this long resets the reconnect backoff; a shorter one counts as a failure. */
const MIN_UP_MS = 10_000;
/** The most bytes of one response body, and of one stream event that never ends (TOOL-MCP-012, TOOL-MCP-016). */
const BODY_CAP = 1024 * 1024;
/** The most pages of one tools/list (TOOL-MCP-015) and the most raw tool entries across them. */
const MAX_PAGES = 50;
const MAX_RAW_TOOLS = 10_000;
/** A re-list runs at most this often (TOOL-MCP-004); a server's own requests are answered this many at a time, and this many a second (TOOL-MCP-021). */
const MIN_RELIST_GAP_MS = 1000;
const ANSWERS_IN_FLIGHT = 1;
const ANSWERS_PER_SECOND = 5;
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
/** A response body or stream event over the cap (TOOL-MCP-012). */
class TooLarge extends Error {}
/** A JSON-RPC error answer (TOOL-CALL-012). */
class RpcError extends Error {}

/** One connection: a session, its stream and its list timer, ended once (lost or stopped). */
interface Conn {
  session: string | undefined;
  ctl: AbortController;
  timer?: ReturnType<typeof setInterval>;
  lostBy?: "down" | "auth";
  /** A list is running; a notification that arrives meanwhile sets `dirty` and one more list runs after it (TOOL-MCP-004). */
  relisting: boolean;
  dirty: boolean;
  /** When the last list ended and how long it took: the next list waits for the gap, which scales with the list (TOOL-MCP-004). */
  lastListEnd: number;
  lastListMs: number;
  waiting?: ReturnType<typeof setTimeout>;
  lost: Promise<void>;
  end: () => void;
}

/** A JSON object, not an array and not null. */
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Discards a body the client will not read, so its socket is released. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** The data of a `message` event block, or undefined for any other event (TOOL-MCP-022: an `endpoint` event is never read). */
function messageOf(block: string): string | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return (event === "message" || event === "") && data.length > 0 ? data.join("\n") : undefined;
}

/**
 * The data of each complete `message` event of a stream, in order, read in one pass. The body is read to the cap: a reply
 * (`streaming` false) is capped in total, and an event that never ends is capped in any case; a GET stream (`streaming` true)
 * is open-ended in total. Text is searched once, as it arrives, so a long event costs time linear in its size (TOOL-MCP-012).
 */
// @spec TOOL-MCP-012, TOOL-MCP-022
export async function* eventData(res: Response, streaming: boolean): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return;
  const dec = new TextDecoder();
  let total = 0;
  let parts: string[] = [];
  let size = 0;
  let lastNL = false;
  let held = "";
  try {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try { chunk = await reader.read(); } catch { throw new Down(); }
      if (chunk.done) break;
      total += chunk.value!.byteLength;
      if (!streaming && total > BODY_CAP) throw new TooLarge(); // a reply's total (TOOL-MCP-012)
      let text = held + dec.decode(chunk.value!, { stream: true });
      held = "";
      if (text.endsWith("\r")) { held = "\r"; text = text.slice(0, -1); }
      text = text.replace(/\r\n/g, "\n");
      // An empty chunk or a lone carriage return carries no line end: the state of the last line is kept as it was.
      if (text === "") continue;
      let pos = 0;
      // a blank line can straddle two chunks: the newline at the end of the last one and the one at the start of this one
      if (lastNL && text.startsWith("\n")) {
        parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
        const d = messageOf(parts.join(""));
        parts = []; size = 0;
        if (d !== undefined) yield d;
        pos = 1;
        lastNL = false;
      }
      for (let k = text.indexOf("\n\n", pos); k >= 0; k = text.indexOf("\n\n", pos)) {
        const piece = text.slice(pos, k);
        parts.push(piece);
        size += piece.length;
        if (size > BODY_CAP) throw new TooLarge(); // one event that never ends (TOOL-MCP-012)
        const d = messageOf(parts.join(""));
        parts = []; size = 0;
        if (d !== undefined) yield d;
        pos = k + 2;
      }
      const rest = text.slice(pos);
      parts.push(rest);
      size += rest.length;
      if (size > BODY_CAP) throw new TooLarge();
      lastNL = rest.endsWith("\n");
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
 * object leaves the tool out, a non-string title is dropped, a non-boolean `readOnlyHint` is no annotation, and a non-string
 * description is empty (TOOL-MCP-017 to TOOL-MCP-020). A schema too deep or too large is passed on, and the catalog leaves it
 * out and counts it (TOOL-CAT-002, TOOL-MCP-018).
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

/** The JSON of a value, or undefined when it cannot be serialized: a comparison must never throw. */
function safeJson(v: unknown): string | undefined {
  try { return JSON.stringify(v); } catch { return undefined; }
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
 * One configured server as a source of tools: one Streamable HTTP session at a time, reconnected with backoff when it drops
 * (TOOL-MCP-001 to TOOL-MCP-004). It starts no process and reads no environment; the URL and the secret come from
 * `tools.servers.<name>`.
 */
// @spec TOOL-MCP-001, TOOL-MCP-002, TOOL-MCP-003
export class McpSource implements ToolSource {
  readonly name: string;
  readonly detail: string | undefined;
  private current: SourceState = "down";
  private tools: SourceTool[] = [];
  /** The JSON of `tools` as last published, compared with each new list (serialized once per list). */
  private toolsKey: string | undefined;
  private conn: Conn | undefined;
  private readonly url: string;
  private readonly header: string;
  private readonly token: string;
  private readonly tokenOk: boolean;
  private readonly retry: RetryOptions;
  private readonly setupMs: number;
  private readonly catalogMs: number;
  private readonly relistGapMs: number;
  private answersInFlight = 0;
  private answerTimes: number[] = [];
  /** The session of a connection still being set up, so that a close during it can still end the session (TOOL-SVC-008). */
  private inflightSession: string | undefined;
  private readonly stopCtl = new AbortController();
  private stopping = false;
  private started = false;
  private nextId = 0;
  private readonly listeners: (() => void)[] = [];

  // @spec TOOL-MCP-007, TOOL-MCP-008
  constructor(name: string, entry: { url: string; header: string; token: string; external: boolean }, cfg: Config, env: McpEnv = {}) {
    this.name = name;
    this.url = entry.url;
    this.header = entry.header;
    this.token = entry.token;
    // A secret must be a header value: no control character, and no character above U+00FF (TOOL-MCP-005). Otherwise it is never sent.
    this.tokenOk = [...entry.token].every((c) => { const n = c.charCodeAt(0); return n >= 32 && n !== 127 && n <= 255; });
    this.retry = { ...DEFAULT_RETRY, ...env.retry };
    this.setupMs = env.setupTimeoutMs ?? SETUP_TIMEOUT_MS;
    this.catalogMs = cfg.tools.catalog_ms;
    this.relistGapMs = env.relistGapMs ?? MIN_RELIST_GAP_MS;
    // TOOL-MCP-008: the note is about the host, not the `external` mark: a plain http secret to a host off the LAN is noted.
    const url = new URL(entry.url);
    const host = url.hostname;
    const offLan = host === "" || offLanHost(host, cfg.network?.lan ?? []);
    const notes: string[] = [];
    if (!this.tokenOk) notes.push("credential cannot be sent: it has a character a header cannot carry, so it is not sent");
    if (url.protocol === "http:" && entry.token !== "" && offLan) notes.push("credential sent without TLS");
    this.detail = notes.length > 0 ? notes.join("; ") : undefined;
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

  /** The wait after the n-th consecutive failure: base, doubled, capped; none before the first (TOOL-MCP-003). */
  private delayFor(n: number): number {
    return n <= 0 ? 0 : Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** Math.min(n - 1, 60));
  }

  /** Waits `ms` with the shared sleep (a test's fake when it gives one), ending at once when the source closes. */
  private pause(ms: number): Promise<void> {
    if (ms <= 0 || this.stopping) return Promise.resolve();
    const signal = this.stopCtl.signal;
    // The listener and the timer are released whichever ends the wait first, so waits do not pile up listeners (TOOL-MCP-003).
    const held: { stop?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
    const wait = this.retry.sleep ? this.retry.sleep(ms) : new Promise<void>((r) => { held.timer = setTimeout(r, ms); });
    const stopped = new Promise<void>((r) => { held.stop = () => r(); signal.addEventListener("abort", held.stop, { once: true }); });
    return Promise.race([wait, stopped]).finally(() => {
      clearTimeout(held.timer);
      if (held.stop !== undefined) signal.removeEventListener("abort", held.stop);
    });
  }

  /**
   * Connects, waits until the connection is lost, and connects again, until the source is closed. A failed attempt and a
   * connection that did not stay up for `MIN_UP_MS` both count as failures, so a server that accepts and drops the connection
   * is retried on the backoff, not in a loop. Only a connection that stayed up resets the count (TOOL-MCP-003).
   */
  // @spec TOOL-MCP-003
  private async supervise(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      let conn: Conn;
      try {
        conn = await this.connect();
      } catch (err) {
        if (this.stopping) return;
        failures++;
        this.setState(err instanceof Refused ? "auth" : "down");
        await this.pause(this.delayFor(failures));
        continue;
      }
      const upSince = Date.now();
      await conn.lost;
      if (this.stopping) return;
      failures = Date.now() - upSince >= MIN_UP_MS ? 0 : failures + 1;
      // After a refused credential the first retry waits one base delay, so `auth` shows until a reconnect succeeds.
      if (conn.lostBy === "auth") failures = Math.max(failures, 1);
      await this.pause(this.delayFor(failures));
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
    this.inflightSession = session;
    try {
      await this.notify("notifications/initialized", undefined, session, signal);
      const listStart = Date.now();
      const tools = await this.listAll(session, signal);
      const listEnd = Date.now();
      if (this.stopping) throw new Down();
      const conn = this.newConn(session);
      // The connect list counts for the gap to the first re-list, as any list does (TOOL-MCP-004).
      conn.lastListEnd = listEnd;
      conn.lastListMs = listEnd - listStart;
      this.conn = conn;
      this.inflightSession = undefined;
      this.tools = tools;
      this.toolsKey = safeJson(tools);
      this.setState("ok");
      this.emit();
      void this.runStream(conn);
      conn.timer = setInterval(() => { void this.relist(conn); }, this.catalogMs); // TOOL-MCP-004
      return conn;
    } catch (err) {
      // A session that initialized but did not list is closed on the server, so the next attempt starts clean.
      this.inflightSession = undefined;
      if (session !== undefined && !this.stopping) void this.deleteSession(session);
      throw err;
    }
  }

  private newConn(session: string | undefined): Conn {
    let end!: () => void;
    const lost = new Promise<void>((r) => { end = r; });
    return { session, ctl: new AbortController(), relisting: false, dirty: false, lastListEnd: Date.now(), lastListMs: 0, lost, end };
  }

  /** Ends a connection once: the stream and the timer stop, the state follows, and the supervisor reconnects. */
  private lose(conn: Conn, by: "down" | "auth"): void {
    if (conn.lostBy !== undefined) return;
    conn.lostBy = by;
    if (this.conn === conn) this.conn = undefined;
    clearInterval(conn.timer);
    clearTimeout(conn.waiting);
    conn.ctl.abort();
    this.setState(by === "auth" ? "auth" : "down");
    conn.end();
  }

  /**
   * Lists again on a notification or on the timer. One list runs at a time: a request that arrives meanwhile marks the list
   * `dirty` and one more list runs after it, so a burst of notifications costs at most two lists (TOOL-MCP-004).
   */
  // @spec TOOL-MCP-004, TOOL-MCP-003
  private async relist(conn: Conn): Promise<void> {
    if (conn.lostBy !== undefined || this.stopping) return;
    if (conn.relisting || conn.waiting !== undefined) { conn.dirty = true; return; }
    // The gap starts when the last list ended and is at least four times that list's duration, so a slow server's lists cannot
    // keep the service busy (TOOL-MCP-004).
    const gap = Math.max(this.relistGapMs, 4 * conn.lastListMs);
    const wait = conn.lastListEnd + gap - Date.now();
    if (wait > 0) {
      conn.waiting = setTimeout(() => { conn.waiting = undefined; void this.relist(conn); }, wait);
      return;
    }
    conn.relisting = true;
    conn.dirty = false;
    const started = Date.now();
    try {
      const signal = AbortSignal.any([conn.ctl.signal, AbortSignal.timeout(this.setupMs)]);
      let tools: SourceTool[];
      try {
        tools = await this.listAll(conn.session, signal);
      } catch (err) {
        this.lose(conn, err instanceof Refused ? "auth" : "down");
        return;
      }
      if (conn.lostBy !== undefined) return;
      // The catalog is published only when the list changed (main.ts compares the published catalog).
      const next = safeJson(tools);
      if (next === undefined || next !== this.toolsKey) {
        this.tools = tools;
        this.toolsKey = next;
        this.emit();
      }
    } finally {
      conn.relisting = false;
      conn.lastListEnd = Date.now();
      conn.lastListMs = conn.lastListEnd - started;
    }
    if (conn.dirty && conn.lostBy === undefined) void this.relist(conn);
  }

  /**
   * Lists every page of tools/list. A page that is not a list, a cursor that is not a non-empty string, a repeated cursor, more
   * than 50 pages or more than 10 000 entries is a failed list (TOOL-MCP-015); a response over 1 MiB fails it too, before any
   * tool is taken (TOOL-MCP-016).
   */
  // @spec TOOL-MCP-015, TOOL-MCP-016
  private async listAll(session: string | undefined, signal: AbortSignal): Promise<SourceTool[]> {
    const raw: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Down();
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

  /** The first event of an event-stream reply that answers this id; other messages in it are skipped (TOOL-MCP-024). */
  // @spec TOOL-MCP-024
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
  private async send(method: "POST" | "GET", body: string | undefined, session: string | undefined, signal: AbortSignal, accept: string): Promise<Response> {
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
    await this.post(JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }), session, signal);
  }

  /** Posts one JSON-RPC message that expects no answer body, and checks its status. */
  private async post(body: string, session: string | undefined, signal: AbortSignal): Promise<void> {
    const req = this.linked(signal);
    try {
      const res = await this.send("POST", body, session, req.signal, "application/json, text/event-stream");
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
   * Keeps the GET stream for server notifications open (TOOL-MCP-004). A stream that ends on its own is not a lost
   * connection: a `ping` decides. If the server answers, the stream is reopened after a backoff that resets only after a
   * stream stayed open for `MIN_UP_MS`; if it does not, the connection is lost (TOOL-MCP-003). A server that refuses the stream
   * (405, or any non-stream answer) is fine: the list timer still runs.
   */
  // @spec TOOL-MCP-003, TOOL-MCP-004, TOOL-MCP-026
  private async runStream(conn: Conn): Promise<void> {
    let fails = 0;
    while (conn.lostBy === undefined && !this.stopping) {
      const since = Date.now();
      const ended = await this.streamOnce(conn);
      if (!ended || conn.lostBy !== undefined || this.stopping) return;
      if (!(await this.probe(conn))) { this.lose(conn, "down"); return; }
      fails = Date.now() - since >= MIN_UP_MS ? 1 : fails + 1;
      await this.pause(this.delayFor(fails));
    }
  }

  /** One GET stream. Returns true when it ended (or failed) while the connection was open, false when it is not open. */
  private async streamOnce(conn: Conn): Promise<boolean> {
    let res: Response;
    try {
      res = await this.send("GET", undefined, conn.session, conn.ctl.signal, "text/event-stream");
    } catch {
      return true;
    }
    if (res.status === 401 || res.status === 403) { await discard(res); this.lose(conn, "auth"); return false; }
    // A 404 is a session the server forgot: the connection is replaced on a new session (TOOL-MCP-026).
    // With no session id, a 404 is a server without sessions: no stream, the connection stays up. With one, a ping decides:
    // the connection is dropped only when the ping fails (TOOL-MCP-026).
    if (res.status === 404) {
      await discard(res);
      if (conn.session !== undefined && !(await this.probe(conn))) this.lose(conn, "down");
      return false;
    }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) { await discard(res); return false; }
    try {
      for await (const data of eventData(res, true)) {
        let v: unknown;
        try { v = JSON.parse(data); } catch { continue; }
        if (!isObj(v)) continue;
        if (v.method === "notifications/tools/list_changed") void this.relist(conn);
        else if (typeof v.method === "string") this.answerServer(conn, v);
      }
    } catch {
      // a failed or over-long stream ends here; the probe decides the connection
    }
    return true;
  }

  /** A `ping` decides whether a connection that lost its stream is still up. An error answer is still an answer. */
  private async probe(conn: Conn): Promise<boolean> {
    const signal = AbortSignal.any([conn.ctl.signal, AbortSignal.timeout(this.setupMs)]);
    try {
      await this.exchange({ id: ++this.nextId, method: "ping" }, conn.session, signal);
      return true;
    } catch (err) {
      if (err instanceof RpcError) return true;
      if (err instanceof Refused) this.lose(conn, "auth");
      return false;
    }
  }

  /**
   * A server's `ping` is answered with an empty result; any other request the server sends is answered with a JSON-RPC error,
   * since the client declares no capability to answer it (TOOL-MCP-021). At most one such answer is in flight and five start in
   * any second; a request past either limit is dropped unanswered. The answer is best-effort and nothing waits on it.
   */
  // @spec TOOL-MCP-021
  private answerServer(conn: Conn, msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    const now = Date.now();
    this.answerTimes = this.answerTimes.filter((t) => now - t < 1000);
    if (this.answersInFlight >= ANSWERS_IN_FLIGHT || this.answerTimes.length >= ANSWERS_PER_SECOND) return;
    this.answerTimes.push(now);
    const outcome = msg.method === "ping" ? { result: {} } : { error: { code: -32601, message: "method not supported" } };
    const body = JSON.stringify({ jsonrpc: "2.0", id, ...outcome });
    const signal = AbortSignal.any([conn.ctl.signal, AbortSignal.timeout(CANCEL_TIMEOUT_MS)]);
    this.answersInFlight++;
    this.post(body, conn.session, signal).catch(() => undefined).finally(() => { this.answersInFlight--; });
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

  /** Closes a session with DELETE, to the configured URL only and with no redirect followed (TOOL-SVC-008). */
  private async deleteSession(session: string): Promise<void> {
    const res = await fetch(this.url, {
      method: "DELETE",
      headers: { ...secretHeader(this.header, this.token), [SESSION_HEADER]: session },
      redirect: "manual",
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    }).catch(() => undefined);
    if (res !== undefined) await discard(res);
  }

  /** Stops the source: the connection attempt, the stream and the timer end, and the session is closed when it can be (TOOL-SVC-008). */
  async close(): Promise<void> {
    this.stopping = true;
    this.stopCtl.abort();
    const conn = this.conn;
    // A connection still being set up has its session in `inflightSession`: it is closed too (TOOL-SVC-008).
    const session = conn?.session ?? this.inflightSession;
    if (conn !== undefined) this.lose(conn, "down");
    this.inflightSession = undefined;
    if (session !== undefined) await this.deleteSession(session);
  }
}

/** The MCP sources of the configured servers, one per `tools.servers` entry, in its order (TOOL-MCP-002). */
// @spec TOOL-MCP-001, TOOL-MCP-002
export function mcpSources(cfg: Config, env: McpEnv = {}): ToolSource[] {
  return Object.entries(cfg.tools.servers).map(([name, entry]) => new McpSource(name, entry, cfg, env));
}
