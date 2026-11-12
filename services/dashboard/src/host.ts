import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { Logger } from "@cohost/config";
import { isLoopback } from "@cohost/control";

export const DEFAULT_LAN_PORT = 3001;

const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);

/** The full-surface port (`PORT`, else `DASHBOARD_PORT`, else the config's) and the LAN listener's port. */
// @spec DASH-HTTP-009, DASH-HOST-001
export function resolvePorts(env: NodeJS.ProcessEnv, configPort: number): { port: number; lanPort: number } {
  return {
    port: Number(nonEmpty(env.PORT) ?? nonEmpty(env.DASHBOARD_PORT) ?? String(configPort)),
    lanPort: Number(nonEmpty(env.DASHBOARD_LAN_PORT) ?? String(DEFAULT_LAN_PORT)),
  };
}

/** What the LAN listener serves: the sink page, its audio and the health check. */
// @spec DASH-HOST-002
export function lanAllows(method: string, pathname: string): boolean {
  if (pathname === "/health") return true;
  if (method === "GET") return pathname === "/" || pathname.startsWith("/audio/");
  return method === "POST" && pathname === "/sink";
}

/** Wraps the full handler so the LAN listener has no path to any other route: everything else is a 404 and nothing runs. */
// @spec DASH-HOST-002
export function lanHandler(full: http.RequestListener): http.RequestListener {
  return (req, res) => {
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { pathname = ""; }
    if (!lanAllows(req.method ?? "GET", pathname)) { res.writeHead(404); res.end("not found"); return; }
    return full(req, res);
  };
}

/** `localhost`, `::1` or an IPv4 address in 127.0.0.0/8 (a name that merely starts with `127.` is not one). */
const LOOPBACK_HOST = (h: string): boolean => h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

/** The Host header's hostname (port and IPv6 brackets removed, lower-cased), or undefined when absent or unparsable. */
function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    const h = new URL(`http://${host}`).hostname;
    return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  } catch { return undefined; }
}

/** True when the Host names a loopback address: stops a DNS-rebinding page from reaching a loopback-bound dashboard. */
// @spec DASH-HOST-004
export function hostAllowed(host: string | undefined): boolean {
  const h = hostnameOf(host);
  return h !== undefined && LOOPBACK_HOST(h);
}

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** True when an Origin's host and port (default ports made explicit) equal the Host header's. */
// @spec DASH-HOST-005
export function originAllowed(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  let o: URL, h: URL;
  try { o = new URL(origin); h = new URL(`${o.protocol}//${host}`); } catch { return false; }
  if (o.origin === "null" || !DEFAULT_PORT[o.protocol]) return false;
  const port = (u: URL) => u.port || DEFAULT_PORT[u.protocol];
  return o.hostname === h.hostname && port(o) === port(h);
}

const LIFECYCLE = /^\/services\/[^/]+\/(start|stop|restart)$/;
const STACK_POST = /^\/stack\/[^/]+$/; // any /stack/<name>: with control off every one is a 404 (DASH-CTRL-001)

/**
 * The checks in front of the full-surface handler: while bound to loopback, a foreign Host is a 403 (DASH-HOST-004);
 * a POST, PUT or DELETE with a foreign Origin is a 403 (DASH-HOST-005). With control disabled the stack and lifecycle
 * routes are answered by the handler's 404 first (DASH-STACK-002's refusal order).
 */
// @spec DASH-HOST-004, DASH-HOST-005
export function guardFullSurface(inner: http.RequestListener, o: { loopback: boolean; controlEnabled: boolean }): http.RequestListener {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (!o.controlEnabled && method === "POST") {
      let pathname = "";
      try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* the handler answers it */ }
      if (STACK_POST.test(pathname) || LIFECYCLE.test(pathname)) return inner(req, res);
    }
    if (o.loopback && !hostAllowed(req.headers.host)) { res.writeHead(403); res.end("forbidden"); return; }
    if ((method === "POST" || method === "PUT" || method === "DELETE") && req.headers.origin !== undefined && !originAllowed(req.headers.origin, req.headers.host)) {
      res.writeHead(403); res.end("forbidden"); return;
    }
    return inner(req, res);
  };
}

export interface ListenerOptions {
  /** The full handler (routes); the LAN listener serves a restricted view of it. */
  handler: http.RequestListener;
  /** The shared WebSocket server (`noServer`); both listeners hand `/ws` upgrades to it. */
  wss: WebSocketServer;
  bind: string;
  port: number;
  lanPort: number;
  /** The LAN listener's address; default all interfaces (tests pin loopback). */
  lanHost?: string;
  controlEnabled: boolean;
  log: Pick<Logger, "info" | "warn" | "fatal">;
  exit?: (code: number) => void;
}

export interface Listeners {
  full: http.Server;
  lan: http.Server;
  fullPort: number;
  lanPort: number;
  fullUrl: string;
  close(): Promise<void>;
}

function attachUpgrade(server: http.Server, wss: WebSocketServer, guard?: (req: http.IncomingMessage) => boolean): void {
  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* refused below */ }
    if (guard && !guard(req)) { socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); return; }
    if (pathname !== "/ws") { socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
}

function listen(server: http.Server, host: string | undefined, port: number, label: string, log: ListenerOptions["log"]): Promise<boolean> {
  return new Promise((resolve) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      const where = `${host ?? "0.0.0.0"}:${port}`;
      const hint = err.code === "EADDRINUSE" ? "; an old dashboard container may hold it: `docker compose down --remove-orphans` frees it" : "";
      log.fatal({ err }, `dashboard cannot listen on ${where} (${label}): ${err.message}${hint}`);
      resolve(false);
    });
    const onListening = () => { server.removeAllListeners("error"); resolve(true); };
    if (host) server.listen(port, host, onListening); else server.listen(port, onListening);
  });
}

/**
 * Starts the full-surface listener and the LAN listener over one shared handler and WebSocket server. Resolves
 * once both listen; a listener that cannot bind is logged at fatal, `exit(1)` is called, and it resolves undefined.
 */
// @spec DASH-HOST-001, DASH-HOST-003, DASH-HOST-006, DASH-HTTP-009
export async function startListeners(o: ListenerOptions): Promise<Listeners | undefined> {
  const loopback = isLoopback(o.bind);
  const full = http.createServer(guardFullSurface(o.handler, { loopback, controlEnabled: o.controlEnabled }));
  const lan = http.createServer(lanHandler(o.handler));
  attachUpgrade(full, o.wss, loopback ? (req) => hostAllowed(req.headers.host) : undefined);
  attachUpgrade(lan, o.wss);
  const exit = o.exit ?? ((c: number) => process.exit(c));
  const fullOk = await listen(full, o.bind, o.port, "full surface", o.log);
  const lanOk = fullOk && (await listen(lan, o.lanHost, o.lanPort, "LAN", o.log));
  if (!fullOk || !lanOk) {
    full.close(); lan.close();
    exit(1);
    return undefined;
  }
  const fullAddr = full.address() as AddressInfo, lanAddr = lan.address() as AddressInfo;
  const host = fullAddr.family === "IPv6" ? `[${fullAddr.address}]` : fullAddr.address;
  const fullUrl = `http://${host}:${fullAddr.port}`;
  o.log.info({ url: fullUrl, lanPort: lanAddr.port }, `dashboard online: ${fullUrl} (full surface), LAN listener (sink) on port ${lanAddr.port}`);
  return {
    full, lan, fullPort: fullAddr.port, lanPort: lanAddr.port, fullUrl,
    // Does not wait for anything else the dashboard started (a running docker compose command included).
    close: () => new Promise<void>((resolve) => {
      for (const c of o.wss.clients) c.terminate();
      let pending = 2;
      const done = () => { if (--pending === 0) resolve(); };
      full.close(done); lan.close(done);
      full.closeAllConnections(); lan.closeAllConnections();
    }),
  };
}
