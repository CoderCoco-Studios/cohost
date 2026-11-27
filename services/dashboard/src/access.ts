import type http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bearerOk } from "@cohost/control";
import { originAllowed } from "./host.js";

/** The session cookie the unlock link sets (DASH-UNL-003). */
export const SESSION_COOKIE = "cohost_session";
/** 90 days (owner decision): a new link is one `mise run dashboard:unlock` away. */
export const SESSION_MAX_AGE = 7_776_000;

const b64 = (b: Buffer): string => b.toString("base64url");
/** The label the session MAC key is an HMAC of; it differs from the ears listener key's label (control-plane CTRL-RUNTIME-017). */
export const SESSION_LABEL = "cohost dashboard session";
/** The MAC key of every session: HMAC-SHA256 of a fixed label under the control token, so changing the token ends every session. */
const sessionKey = (token: string): Buffer => createHmac("sha256", token).update(SESSION_LABEL).digest();
const mac = (token: string, id: string): string => b64(createHmac("sha256", sessionKey(token)).update(id).digest());

/** A new session cookie value, `<id>.<mac>` (DASH-UNL-005). Nothing is stored: the MAC alone makes it valid. */
// @spec DASH-UNL-005
export function newSession(token: string): string {
  const id = b64(randomBytes(16));
  return `${id}.${mac(token, id)}`;
}

/** True when `value` is a session made under `token`, compared in constant time (DASH-UNL-005). */
// @spec DASH-UNL-005
export function sessionValid(token: string, value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const want = Buffer.from(mac(token, value.slice(0, dot)));
  const got = Buffer.from(value.slice(dot + 1));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The value of the session cookie in a `Cookie` header, or undefined. */
export function sessionCookie(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

/** True when the request carries a valid session cookie and an `Origin` that lets it count (DASH-CTRL-011). */
function sessionCounts(token: string, req: http.IncomingMessage): boolean {
  if (!sessionValid(token, sessionCookie(req.headers.cookie))) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return READ.has(req.method ?? "GET");
  return originAllowed(origin, req.headers.host);
}

/** True when the request carries a valid session cookie, whatever its method and `Origin` (what `GET /services/control` reports). */
export function hasSession(token: string, req: http.IncomingMessage): boolean {
  return sessionValid(token, sessionCookie(req.headers.cookie));
}

/**
 * The one decision every route the control token gates makes, in normal mode and in config recovery mode, on any full-surface
 * address (DASH-CTRL-011): a request that carries `Authorization` is judged by that header alone (`Bearer <CONTROL_TOKEN>`,
 * compared in constant time); one without it passes on a valid session cookie whose request names its own origin (or, for a
 * read, names none). Nothing else lifts it: not a loopback bind, not a loopback peer.
 */
// @spec DASH-CTRL-011
export function authorized(token: string, req: http.IncomingMessage): boolean {
  if (req.headers.authorization !== undefined) return bearerOk(req.headers.authorization, token);
  return sessionCounts(token, req);
}

/** The gate's refusal: 401 with `www-authenticate: Bearer`, as JSON `{ok: false, detail}` or, for the plain routes, as text. */
export function unauthorized(res: http.ServerResponse, as: "json" | "text" = "text"): void {
  if (as === "json") {
    res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ ok: false, detail: "unauthorized" }));
    return;
  }
  res.writeHead(401, { "www-authenticate": "Bearer" });
  res.end("unauthorized");
}

/** The nonces of the unlock link: 32 random bytes each, accepted once within 10 minutes, at most 16 unused (DASH-UNL-002). */
// @spec DASH-UNL-002
export class UnlockLinks {
  private readonly nonces = new Map<string, number>();
  /** The full-surface address and port links name (`unlockBase`), set once the listener is bound (DASH-UNL-001, DASH-UNL-006). */
  base: string | undefined;
  constructor(private readonly now: () => number = Date.now, readonly ttlMs = 10 * 60_000, readonly max = 16) {}

  /** A fresh nonce. */
  issue(): string {
    const n = b64(randomBytes(32));
    this.nonces.set(n, this.now() + this.ttlMs);
    while (this.nonces.size > this.max) this.nonces.delete(this.nonces.keys().next().value as string);
    return n;
  }

  /** True, once, for a nonce issued here within its lifetime; it is gone afterwards either way. */
  consume(n: string | null): boolean {
    if (!n) return false;
    const until = this.nonces.get(n);
    if (until === undefined) return false;
    this.nonces.delete(n);
    return this.now() <= until;
  }
}

/** The address an unlock link names: the bound address, `127.0.0.1` for an unspecified one, an IPv6 one in brackets. */
export function unlockBase(bind: string, port: number): string {
  const host = bind === "0.0.0.0" || bind === "::" || bind === "" ? "127.0.0.1" : bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${port}`;
}

/** A request's path without its query string, for logs: `/unlock?n=` carries a one-time nonce that must never be logged. */
export function pathOf(req: http.IncomingMessage): string {
  try { return new URL(req.url ?? "/", "http://x").pathname; } catch { return "(unparsable)"; }
}

/** The terminal line of DASH-UNL-001. */
export const unlockLine = (base: string, nonce: string): string => `Unlock this browser: ${base}/unlock?n=${nonce}`;

/** The answer to a link that is not valid (DASH-UNL-004): static, the same bytes for every request, nothing from the request. */
export const BAD_LINK_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unlock link not valid</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5">
<h1>This unlock link is not valid</h1>
<p>It was already used, it expired (a link lasts 10 minutes), or it is from an earlier start of the dashboard.</p>
<p>Get a new one: run <code>mise run dashboard:unlock</code> in the cohost folder, or restart the dashboard (<code>mise run dashboard</code>) and open the link it prints in its terminal.</p>
<p>If this browser is already unlocked, <a href="/">open the dashboard</a>.</p>
</body>
</html>
`;

/**
 * `GET /unlock?n=` (DASH-UNL-003, DASH-UNL-004), `POST /unlock/link` (DASH-UNL-006) and `POST /unlock/forget` (DASH-UNL-008),
 * shared by normal mode and config recovery mode. Returns false for any other request.
 */
// @spec DASH-UNL-003, DASH-UNL-004, DASH-UNL-006, DASH-UNL-008
export function handleUnlock(d: { token: string; links: UnlockLinks }, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method === "GET" && url.pathname === "/unlock") {
    const ok = d.links.consume(url.searchParams.get("n"));
    // The browser the link already unlocked may open it again (a second click on the terminal line, a restored tab): it goes
    // on to its unlocked dashboard, keeping the session it holds.
    if (!ok && hasSession(d.token, req)) {
      res.writeHead(303, { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return true;
    }
    if (!ok) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(BAD_LINK_PAGE);
      return true;
    }
    res.writeHead(303, {
      location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": `${SESSION_COOKIE}=${newSession(d.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
    });
    res.end();
    return true;
  }
  if (req.method === "POST" && url.pathname === "/unlock/link") {
    req.resume();
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(value));
    };
    // The one gate: the token, or the session cookie of an unlocked browser minting a link for another (DASH-CTRL-011).
    if (!authorized(d.token, req)) { json(401, { ok: false, detail: "unauthorized" }, { "www-authenticate": "Bearer" }); return true; }
    const base = d.links.base ?? `http://${req.headers.host ?? "127.0.0.1"}`;
    json(200, { ok: true, url: `${base}/unlock?n=${d.links.issue()}` });
    return true;
  }
  // Removing access needs no credential; the Host and Origin checks in front of the handler keep another site from sending it.
  if (req.method === "POST" && url.pathname === "/unlock/forget") {
    req.resume();
    res.writeHead(204, { "cache-control": "no-store", "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    res.end();
    return true;
  }
  return false;
}
