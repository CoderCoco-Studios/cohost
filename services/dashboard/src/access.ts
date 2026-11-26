import type http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bearerOk } from "@cohost/control";
import { originAllowed } from "./host.js";

/** The session cookie the unlock link sets (DASH-UNL-003). */
export const SESSION_COOKIE = "cohost_session";
/** 400 days, the longest lifetime a browser keeps a cookie for. */
export const SESSION_MAX_AGE = 34_560_000;

/** Who must present the control token on a route: `required` false lets every request through; `token` is `CONTROL_TOKEN`. */
export interface TokenGate {
  required: boolean;
  token: string | undefined;
}

/** Why a request is refused for the control token: none configured, or neither the token nor a counted session cookie. */
export type TokenRefusal = "none" | "wrong";

const b64 = (b: Buffer): string => b.toString("base64url");
/** The MAC key of every session: HMAC-SHA256 of a fixed label under the control token, so changing the token ends every session. */
const sessionKey = (token: string): Buffer => createHmac("sha256", token).update("cohost dashboard session").digest();
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
export function hasSession(token: string | undefined, req: http.IncomingMessage): boolean {
  return token !== undefined && sessionValid(token, sessionCookie(req.headers.cookie));
}

/**
 * The one decision every route the control token gates makes, in normal mode and in config recovery mode (DASH-CTRL-011): no
 * refusal when the gate is not required; `none` when no token is configured; otherwise a request that carries `Authorization`
 * is judged by that header alone, and one without it passes on a valid session cookie whose request names its own origin
 * (or, for a read, names none).
 */
// @spec DASH-CTRL-011
export function tokenRefusal(gate: TokenGate, req: http.IncomingMessage): TokenRefusal | undefined {
  if (!gate.required) return undefined;
  if (gate.token === undefined) return "none";
  if (req.headers.authorization !== undefined) return bearerOk(req.headers.authorization, gate.token) ? undefined : "wrong";
  return sessionCounts(gate.token, req) ? undefined : "wrong";
}

/** True when `token` is configured and the request presents it or a counted session cookie (DASH-CTRL-011). */
export function authorized(token: string | undefined, req: http.IncomingMessage): boolean {
  return tokenRefusal({ required: true, token }, req) === undefined;
}

/** The nonces of the unlock link: 32 random bytes each, accepted once within 10 minutes, at most 16 unused (DASH-UNL-002). */
// @spec DASH-UNL-002
export class UnlockLinks {
  private readonly nonces = new Map<string, number>();
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

/** The terminal line of DASH-UNL-001. */
export const unlockLine = (base: string, nonce: string): string => `Unlock this browser: ${base}/unlock?n=${nonce}`;

const NO_TOKEN_PAGE = "This dashboard has no control token, so it cannot unlock a browser. Set CONTROL_TOKEN in .env and restart the dashboard (mise run dashboard): it prints an unlock link in its terminal.\n";
const BAD_LINK_PAGE = "This unlock link is not valid: it was already used, it expired (a link lasts 10 minutes), or it is from an earlier start of the dashboard.\n\nGet a new one: run `mise run dashboard:unlock` in the cohost folder, or restart the dashboard (mise run dashboard) and open the link it prints in its terminal.\n";

/**
 * `GET /unlock?n=` (DASH-UNL-003, DASH-UNL-004) and `POST /unlock/link` (DASH-UNL-006), shared by normal mode and config
 * recovery mode. Returns false for any other request.
 */
// @spec DASH-UNL-003, DASH-UNL-004, DASH-UNL-006
export function handleUnlock(d: { token: string | undefined; links: UnlockLinks }, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (req.method === "GET" && url.pathname === "/unlock") {
    const ok = d.token !== undefined && d.links.consume(url.searchParams.get("n"));
    if (!ok) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(d.token === undefined ? NO_TOKEN_PAGE : BAD_LINK_PAGE);
      return true;
    }
    res.writeHead(303, {
      location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": `${SESSION_COOKIE}=${newSession(d.token!)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
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
    if (d.token === undefined) { json(403, { ok: false, detail: "no control token is configured: set CONTROL_TOKEN in .env (with CONTROL_ENABLED=1 for the stack controls) and restart the dashboard" }); return true; }
    if (!bearerOk(req.headers.authorization, d.token)) { json(401, { ok: false, detail: "unauthorized" }, { "www-authenticate": "Bearer" }); return true; }
    json(200, { ok: true, url: `http://${req.headers.host ?? "127.0.0.1"}/unlock?n=${d.links.issue()}` });
    return true;
  }
  return false;
}
