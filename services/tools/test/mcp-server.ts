/**
 * A fake MCP server on a real socket (MCP Streamable HTTP transport), for the tools service's MCP client tests. Not a test
 * file. It speaks enough of the protocol for a session (initialize, the initialized notification, tools/list, tools/call,
 * ping, the optional GET stream for server notifications) and exposes hooks to be hostile: every request is recorded, any
 * method can be answered with a hang, a destroyed socket, a redirect, a body of any size or a slow drip.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { after } from "node:test";
import { waitFor } from "@cohost/testing";

/** One request the server read. */
export interface Seen {
  n: number;
  httpMethod: string;
  /** The path without the query string. */
  path: string;
  /** The whole request target, query string included. */
  target: string;
  headers: IncomingHttpHeaders;
  /** The parsed JSON-RPC message of a POST, when it parsed. */
  rpc?: { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: unknown; error?: unknown };
  /** Resolves when the response ended or the client went away. */
  closed: Promise<void>;
  /** True when the client closed the connection before the server finished its response. */
  aborted: boolean;
}

export type Reply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { sse: unknown[]; headers?: Record<string, string> }
  | { status: number; headers?: Record<string, string>; body?: string }
  | { hang: true }
  | { destroy: true }
  | { stream: (res: ServerResponse, req: IncomingMessage) => void };

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  server: FakeMcp;
  /** A JSON-RPC result for `seen`'s request, in the response form the server is set to (JSON or SSE). */
  result: (value: unknown) => Reply;
  /** A JSON-RPC error for `seen`'s request. */
  error: (code: number, message: string) => Reply;
}

export type Handler = (seen: Seen, ctx: Ctx) => Reply | undefined | Promise<Reply | undefined>;

export interface ToolJson { name?: unknown; [k: string]: unknown }

export const PROTOCOL = "2025-06-18";

/** A well-formed MCP tool as a server lists it. */
export const toolJson = (name: string, over: Record<string, unknown> = {}): ToolJson => ({
  name,
  description: `desc of ${name}`,
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  ...over,
});

const servers: FakeMcp[] = [];
after(async () => { for (const s of servers) await s.stop(); });

export class FakeMcp {
  /** The tools `tools/list` returns, as raw JSON (a test may put anything here). */
  tools: unknown[];
  /** `json`: replies are application/json; `sse`: each reply is a one-event text/event-stream. */
  mode: "json" | "sse" = "json";
  /** Per-method override, by JSON-RPC method (`tools/call`) or `GET` for the notification stream. */
  byMethod: Record<string, Handler> = {};
  /** A hook run first on every request, before the method's own. */
  before?: Handler;
  /** Returns a status (401, 403) to refuse a request, or undefined to let it through. */
  auth?: (headers: IncomingHttpHeaders) => number | undefined;
  /** What `tools/call` answers by default. */
  callResult: (name: string, args: unknown) => unknown = (name) => ({ content: [{ type: "text", text: `ran ${name}` }] });
  /** When true (default) a request with a session id the server does not know is answered 404, as the spec says. */
  requireSession = true;
  /** When true every connection is destroyed on arrival: an unreachable server. */
  down = false;
  /** Whether `GET` opens a notification stream (otherwise 405, which the spec allows). */
  streamEnabled = true;

  readonly seen: Seen[] = [];
  readonly streams: ServerResponse[] = [];
  private live = new Set<string>();
  private sockets = new Set<Socket>();
  private server: http.Server;
  private sessionCount = 0;
  host = "127.0.0.1";
  port = 0;

  private constructor(tools: unknown[]) {
    this.tools = tools;
    this.server = http.createServer((req, res) => { void this.serve(req, res); });
    this.server.on("connection", (sock) => { this.sockets.add(sock); sock.on("close", () => this.sockets.delete(sock)); });
  }

  static async start(opts: { tools?: unknown[]; host?: string; mode?: "json" | "sse" } = {}): Promise<FakeMcp> {
    const f = new FakeMcp(opts.tools ?? []);
    if (opts.mode) f.mode = opts.mode;
    f.host = opts.host ?? "127.0.0.1";
    await new Promise<void>((resolve) => f.server.listen(0, f.host, resolve));
    f.port = (f.server.address() as AddressInfo).port;
    servers.push(f);
    return f;
  }

  get origin(): string { return `http://${this.host}:${this.port}`; }
  /** The MCP endpoint. */
  get url(): string { return `${this.origin}/mcp`; }

  rpcs(method: string): Seen[] { return this.seen.filter((s) => s.httpMethod === "POST" && s.rpc?.method === method); }
  waitUntil(cond: () => boolean, what: string, ms = 4000): Promise<void> { return waitFor(cond, what, ms); }

  /** Pushes a JSON-RPC notification on every open GET stream. */
  notify(method: string, params?: unknown): void {
    for (const s of this.streams) s.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n\n`);
  }
  /** Writes a raw JSON-RPC message (a server-initiated request, say) on every open GET stream. */
  push(message: unknown): void {
    for (const s of this.streams) s.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }
  /** Forgets every session: the next request that carries a session id is answered 404. */
  expireSessions(): void { this.live.clear(); }
  /** Destroys every open connection, GET streams included, without stopping the server. */
  dropConnections(): void { for (const s of this.sockets) s.destroy(); }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = req.url ?? "/";
    const path = target.split("?")[0]!;
    let done!: () => void;
    const closed = new Promise<void>((r) => { done = r; });
    const seen: Seen = { n: this.seen.length, httpMethod: req.method ?? "", path, target, headers: req.headers, closed, aborted: false };
    res.on("close", () => { seen.aborted = !res.writableFinished; done(); });
    this.seen.push(seen);
    if (this.down) { req.socket.destroy(); return; }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length > 0) {
      try { seen.rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* a body that is not JSON */ }
    }

    const ctx: Ctx = {
      req, res, server: this,
      result: (value) => this.rpcReply(seen, { jsonrpc: "2.0", id: seen.rpc?.id, result: value }),
      error: (code, message) => this.rpcReply(seen, { jsonrpc: "2.0", id: seen.rpc?.id, error: { code, message } }),
    };
    const key = seen.httpMethod === "POST" ? seen.rpc?.method ?? "" : seen.httpMethod;
    let reply = await this.before?.(seen, ctx);
    if (reply === undefined) reply = await this.byMethod[key]?.(seen, ctx);
    if (reply === undefined) reply = this.fallback(seen, ctx);
    this.send(reply, req, res);
  }

  private rpcReply(seen: Seen, message: unknown): Reply {
    return this.mode === "sse" && seen.httpMethod === "POST" ? { sse: [message] } : { json: message };
  }

  private fallback(seen: Seen, ctx: Ctx): Reply {
    const refused = this.auth?.(seen.headers);
    if (refused !== undefined) return { status: refused, headers: { "www-authenticate": 'Bearer realm="mcp"' }, body: "unauthorized" };
    if (seen.path !== "/mcp") return { status: 404, body: "not found" };
    if (seen.httpMethod === "GET") {
      if (!this.streamEnabled) return { status: 405 };
      return { stream: (res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": open\n\n");
        this.streams.push(res);
        res.on("close", () => { const i = this.streams.indexOf(res); if (i >= 0) this.streams.splice(i, 1); });
      } };
    }
    if (seen.httpMethod === "DELETE") return { status: 200 };
    if (seen.httpMethod !== "POST" || seen.rpc === undefined) return { status: 400, body: "bad request" };
    const rpc = seen.rpc;
    if (rpc.method === "initialize") {
      const id = `sess-${++this.sessionCount}`;
      this.live.add(id);
      const reply = ctx.result({
        protocolVersion: rpc.params?.protocolVersion ?? PROTOCOL,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "fake", version: "1" },
      });
      return { ...reply, headers: { ...("headers" in reply ? reply.headers : {}), "mcp-session-id": id } } as Reply;
    }
    const sid = seen.headers["mcp-session-id"];
    if (this.requireSession && (typeof sid !== "string" || !this.live.has(sid))) return { status: 404, body: "session not found" };
    if (rpc.id === undefined) return { status: 202 };
    switch (rpc.method) {
      case "tools/list": return ctx.result({ tools: this.tools });
      case "tools/call": return ctx.result(this.callResult(String(rpc.params?.name), rpc.params?.arguments));
      case "ping": return ctx.result({});
      default: return ctx.error(-32601, "method not found");
    }
  }

  private send(reply: Reply, req: IncomingMessage, res: ServerResponse): void {
    if ("hang" in reply) return;
    if ("destroy" in reply) { req.socket.destroy(); return; }
    if ("stream" in reply) { reply.stream(res, req); return; }
    if ("json" in reply) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.json));
      return;
    }
    if ("sse" in reply) {
      res.writeHead(200, { "content-type": "text/event-stream", ...reply.headers });
      for (const m of reply.sse) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
      res.end();
      return;
    }
    res.writeHead(reply.status, reply.headers ?? {});
    res.end(reply.body ?? "");
  }
}

/** A URL on a port nothing listens on, for a server that refuses connections. */
export async function deadUrl(path = "/mcp"): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}${path}`;
}

/**
 * A reply that writes `chunk` repeatedly with backpressure until the client goes away or `maxBytes` is written, after `head`.
 * `bytesWritten()` is what the server got onto the socket: a client that reads a bounded prefix and hangs up keeps it small.
 */
export function endless(head: string, chunk: string, maxBytes = 256 * 1024 * 1024): { reply: Reply; bytesWritten: () => number } {
  let written = 0;
  const reply: Reply = {
    stream: (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const pump = (): void => {
        if (written === 0) { res.write(head); written += head.length; }
        while (!res.destroyed && written < maxBytes) {
          written += chunk.length;
          if (!res.write(chunk)) { res.once("drain", pump); return; }
        }
        if (!res.destroyed) res.end();
      };
      pump();
    },
  };
  return { reply, bytesWritten: () => written };
}
