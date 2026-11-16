import http from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { Logger } from "@cohost/config";
import { isLoopback } from "@cohost/control";

/** The full-surface port and the LAN listener's port: `dashboard.port` and `dashboard.lan_port` of the loaded config, and nothing else. */
// @spec DASH-HTTP-009, DASH-HOST-001
export function resolvePorts(dashboard: { port: number; lan_port: number }): { port: number; lanPort: number } {
  return { port: dashboard.port, lanPort: dashboard.lan_port };
}

/** What the LAN listener serves: the sink page with its bundle, its audio and the health check. */
// @spec DASH-HOST-002
export function lanAllows(method: string, pathname: string): boolean {
  if (pathname === "/health") return true;
  if (method === "GET" && (pathname === "/" || pathname.startsWith("/audio/"))) return true;
  if (method === "GET" || method === "HEAD") return pathname === "/favicon.svg" || (pathname.startsWith("/assets/") && pathname.length > "/assets/".length);
  return method === "POST" && pathname === "/sink";
}

/**
 * Wraps the full handler so the LAN listener has no path to any other route: everything else is a 404 and nothing runs.
 * Every request first passes the Host rule (`hostPermitted`, DASH-HOST-009), and a state-changing one (`POST /sink`) that
 * carries an `Origin` must name its own Host's host and port (DASH-HOST-010).
 */
// @spec DASH-HOST-002, DASH-HOST-009, DASH-HOST-010, DASH-DOCS-012
export function lanHandler(full: http.RequestListener, allowedHosts: readonly string[] = []): http.RequestListener {
  return (req, res) => {
    if (!hostPermitted(req.headers.host, allowedHosts)) { res.writeHead(403); res.end("forbidden"); return; }
    if (isStateChanging(req.method) && req.headers.origin !== undefined && !originAllowed(req.headers.origin, req.headers.host)) { res.writeHead(403); res.end("forbidden"); return; }
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { pathname = ""; }
    if (!lanAllows(req.method ?? "GET", pathname)) { res.writeHead(404); res.end("not found"); return; }
    // The LAN listener has no controls, so the full app shell would load and fail on every call: `/` without `sink` is the sink view.
    if (req.method === "GET" && pathname === "/" && !new URL(req.url ?? "/", "http://x").searchParams.has("sink")) {
      res.writeHead(302, { location: "/?sink=1", "cache-control": "no-store" });
      res.end();
      return;
    }
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

const DEFAULT_PORT: Record<string, string> = { "http:": "80" };

/** True when an Origin is `http:` (the dashboard serves plain HTTP) and its host and port (default ports made explicit) equal the Host header's. */
// @spec DASH-HOST-005
export function originAllowed(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  let o: URL, h: URL;
  try { o = new URL(origin); h = new URL(`${o.protocol}//${host}`); } catch { return false; }
  if (o.origin === "null" || o.protocol !== "http:") return false;
  const port = (u: URL) => u.port || DEFAULT_PORT[u.protocol];
  return o.hostname === h.hostname && port(o) === port(h);
}

/**
 * True when a `/ws` upgrade may proceed on its Origin: none (a non-browser client) is accepted, any other must satisfy
 * the rule of `originAllowed`, so a page served from another origin cannot read the feed. A page that controls both its
 * `Origin` and the `Host` it is reached by is stopped by the Host rules (`hostAllowed`, `hostPermitted`), not by this.
 */
// @spec DASH-HOST-008
export function wsOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  return origin === undefined || originAllowed(origin, host);
}

/** A Host header: a name or a bracketed IPv6 literal, then an optional port. */
const HOST_HEADER = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?$/;
/** Dotted-quad IPv4 as a browser sends a typed address: four decimal octets 0 to 255, no leading zeros (`010.1.1.1` is octal to some resolvers). */
const IPV4_LITERAL = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
/** A host name as compared: lower-cased, one trailing dot removed. */
const nameKey = (n: string): string => n.toLowerCase().replace(/\.$/, "");

/**
 * The Host rule of every listener other machines can reach (the LAN listener, and the full surface when it is not bound to
 * loopback): the Host header's name must be an IPv4 or bracketed IPv6 address literal, `localhost`, or a name in `allowed`
 * (`dashboard.allowed_hosts`); names are compared case-insensitively with a trailing dot removed, and the port is not checked.
 * A DNS-rebinding page reaches the dashboard under a name it controls, and an address literal names no domain anyone can
 * rebind, so every other name, an absent Host and a form a browser does not send for a typed address (`0x7f.1`, `2130706433`,
 * `010.1.1.1`, `1.2.3`) is refused.
 */
// @spec DASH-HOST-009
export function hostPermitted(host: string | undefined, allowed: readonly string[] = []): boolean {
  const m = host === undefined ? null : HOST_HEADER.exec(host);
  if (!m) return false;
  const name = m[1]!;
  if (name.startsWith("[")) return isIP(name.slice(1, -1)) === 6;
  if (IPV4_LITERAL.test(name)) return true;
  const key = nameKey(name);
  return key === "localhost" || allowed.some((a) => nameKey(a) === key);
}

/** Every method other than GET, HEAD and OPTIONS (PATCH and any unknown method included) may change state. */
const isStateChanging = (method: string | undefined): boolean => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

const LIFECYCLE = /^\/services\/[^/]+\/(start|stop|restart)$/;
const STACK_POST = /^\/stack\/[^/]+$/; // any /stack/<name>: with control off every one is a 404 (DASH-CTRL-001)

/**
 * The checks in front of the full-surface handler: while bound to loopback, a foreign Host is a 403 (DASH-HOST-004), and
 * when bound beyond it a Host that fails `hostPermitted` is (DASH-HOST-009); a state-changing method (any but GET, HEAD and OPTIONS) with a foreign Origin is a 403 (DASH-HOST-005). With control disabled the stack and lifecycle
 * routes are answered by the handler's 404 first (DASH-STACK-002's refusal order).
 */
// @spec DASH-HOST-004, DASH-HOST-005, DASH-HOST-009
export function guardFullSurface(inner: http.RequestListener, o: { loopback: boolean; controlEnabled: boolean; allowedHosts?: readonly string[] }): http.RequestListener {
  return (req, res) => {
    const method = req.method ?? "GET";
    if (!o.controlEnabled && method === "POST") {
      let pathname = "";
      try { pathname = new URL(req.url ?? "/", "http://x").pathname; } catch { /* the handler answers it */ }
      if (STACK_POST.test(pathname) || LIFECYCLE.test(pathname)) return inner(req, res);
    }
    if (!(o.loopback ? hostAllowed(req.headers.host) : hostPermitted(req.headers.host, o.allowedHosts))) { res.writeHead(403); res.end("forbidden"); return; }
    if (isStateChanging(method) && req.headers.origin !== undefined && !originAllowed(req.headers.origin, req.headers.host)) {
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
  /** `dashboard.allowed_hosts`: host names the non-loopback listeners accept in `Host` besides address literals and `localhost` (DASH-HOST-009). */
  allowedHosts?: readonly string[];
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
      log.fatal({ err }, `dashboard cannot listen on ${where} (${label}): ${err.message}`);
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
  const allowedHosts = o.allowedHosts ?? [];
  const full = http.createServer(guardFullSurface(o.handler, { loopback, controlEnabled: o.controlEnabled, allowedHosts }));
  const lan = http.createServer(lanHandler(o.handler, allowedHosts));
  // @spec DASH-HOST-008, DASH-HOST-009
  const wsOrigin = (req: http.IncomingMessage): boolean => wsOriginAllowed(req.headers.origin, req.headers.host);
  // The loopback listener applies the loopback Host rule of DASH-HOST-004; every listener other machines can reach, the rule of DASH-HOST-009.
  const reachable = (req: http.IncomingMessage): boolean => hostPermitted(req.headers.host, allowedHosts) && wsOrigin(req);
  attachUpgrade(full, o.wss, loopback ? (req) => hostAllowed(req.headers.host) && wsOrigin(req) : reachable);
  attachUpgrade(lan, o.wss, reachable);
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
