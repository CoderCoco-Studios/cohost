import http from "node:http";
import type { Duplex } from "node:stream";

/** The dashboard routes the dev server forwards (DASH-BUILD-007), the renderer page's `/avatar` among them; every other path, `/avatar.html` included, is the dev server's own. */
export const PROXIED_PREFIXES = ["/ws", "/audio", "/services", "/stack", "/personality", "/control", "/mouth", "/inject", "/tools", "/viewers", "/config", "/secrets", "/options", "/sink", "/health", "/avatar"] as const;

/** True for a path that is a proxied prefix or below one (`/services/control`, not `/servicesx`). */
export function isProxied(pathname: string): boolean {
  return PROXIED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443" };

/** True when the Origin is this dev server's own: same scheme-default host and port as the Host the request arrived on. */
function ownOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const o = new URL(origin);
    if (o.origin === "null" || o.protocol !== "http:") return false; // the dev server is plain http on loopback
    const h = new URL(`${o.protocol}//${host}`);
    return o.hostname === h.hostname && (o.port || DEFAULT_PORT[o.protocol]) === (h.port || DEFAULT_PORT[h.protocol]);
  } catch { return false; }
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * True when `host` (the `Host` header) names this dev server as a loopback client does: `localhost`, `127.0.0.1` or `[::1]` with
 * the port the request arrived on. Any other name, or any other port, is a page the browser reached by a name an attacker
 * controls (DNS rebinding), whose `Host` and `Origin` would agree with each other.
 */
function loopbackHost(host: string | undefined, port: number | undefined): boolean {
  if (!host || /[@/\\\s]/.test(host) || port === undefined) return false;
  try {
    const h = new URL(`http://${host}`);
    return LOOPBACK_NAMES.has(h.hostname) && (h.port || "80") === String(port);
  } catch { return false; }
}

const STATE_CHANGING = new Set(["POST", "PUT", "DELETE"]);
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

export interface DevProxy {
  /** Handles a request for a proxied path; false when the path is the dev server's own. */
  middleware(req: http.IncomingMessage, res: http.ServerResponse): boolean;
  /** Handles a `/ws` or `/avatar/ws` upgrade; false when it is not one (the dev server's own HMR socket). */
  upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

/**
 * The dev server's proxy to a running dashboard (DASH-BUILD-007). It serves only requests whose `Host` is a loopback name
 * with the dev server's port, and refuses any other 403 before contacting the dashboard. `Host` is then set to the target's. A state-changing
 * request or a `/ws` upgrade that carries an `Origin` is forwarded only when that Origin is the dev server's own,
 * rewritten to the target's, and refused 403 without contacting the dashboard otherwise, so a cross-site page cannot
 * use the dev server to get past the dashboard's Origin checks (which stay as they are). A request with no `Origin`
 * gets none added.
 */
// @spec DASH-BUILD-007
export function createDevProxy(targetUrl: string): DevProxy {
  const target = new URL(targetUrl);
  const forwardHeaders = (req: http.IncomingMessage): http.OutgoingHttpHeaders => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    if (req.headers.origin !== undefined && (STATE_CHANGING.has(req.method ?? "GET") || req.method === "GET" && req.headers.upgrade)) headers.origin = target.origin;
    return headers;
  };
  const refused = (req: http.IncomingMessage): boolean => {
    if (!loopbackHost(req.headers.host, req.socket.localPort)) return true;
    const o = req.headers.origin;
    const guarded = STATE_CHANGING.has(req.method ?? "GET") || req.headers.upgrade !== undefined;
    return guarded && o !== undefined && !ownOrigin(o, req.headers.host);
  };
  return {
    middleware(req, res) {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      if (!isProxied(pathname) || req.headers.upgrade !== undefined) return false;
      if (refused(req)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden"); return true; }
      const out = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: forwardHeaders(req) }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      out.on("error", (err) => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end(`dashboard unreachable: ${err.message}`); });
      req.pipe(out);
      return true;
    },
    upgrade(req, socket, head) {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      if (pathname !== "/ws" && pathname !== "/avatar/ws") return false;
      if (refused(req)) { socket.end(FORBIDDEN); return true; }
      const out = http.request({ host: target.hostname, port: target.port, path: req.url, method: "GET", headers: forwardHeaders(req) });
      out.on("upgrade", (up, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
        for (let i = 0; i < up.rawHeaders.length; i += 2) lines.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (upHead.length) socket.write(upHead);
        upSocket.pipe(socket); socket.pipe(upSocket);
        upSocket.on("error", () => socket.destroy()); socket.on("error", () => upSocket.destroy());
      });
      out.on("response", (up) => { socket.end(`HTTP/1.1 ${up.statusCode} ${up.statusMessage}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); });
      out.on("error", () => socket.destroy());
      if (head.length) out.write(head);
      out.end();
      return true;
    },
  };
}
