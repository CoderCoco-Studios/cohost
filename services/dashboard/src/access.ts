import type http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { bearerOk } from "@cohost/control";
import type { BearerResult } from "@cohost/store";
import { originAllowed } from "./host.js";

/** The session cookie the unlock link sets (DASH-UNL-003). */
export const SESSION_COOKIE = "cohost_session";
/** 90 days (owner decision): a new link is one `mise run dashboard:unlock` away. */
export const SESSION_MAX_AGE = 7_776_000;

const b64 = (b: Buffer): string => b.toString("base64url");
const mac = (key: Buffer, id: string): string => b64(createHmac("sha256", key).update(id).digest());

/**
 * What the one gate checks against (DASH-CTRL-011): the settings store's token verifier and its session key. In config recovery
 * mode with a damaged or newer store or a missing key there is no session key, so only a bearer passes (DASH-RCV-028).
 */
export interface Gate {
  /** Checks a presented bearer value against the store's verifier (settings-store STORE-TOK-003). */
  verify(token: string): Promise<BearerResult>;
  /** The store's session key (STORE-TOK-004), undefined when none can be read. */
  sessionKey(): Buffer | undefined;
}

/** A new session cookie value, `<id>.<mac>` under the session key (DASH-UNL-005). Nothing is stored: the MAC alone makes it valid. */
// @spec DASH-UNL-005
export function newSession(key: Buffer): string {
  const id = b64(randomBytes(16));
  return `${id}.${mac(key, id)}`;
}

/** True when `value` is a session made under `key`, compared in constant time (DASH-UNL-005); false with no key. */
// @spec DASH-UNL-005
export function sessionValid(key: Buffer | undefined, value: string | undefined): boolean {
  if (!key || !value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const want = Buffer.from(mac(key, value.slice(0, dot)));
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
function sessionCounts(gate: Gate, req: http.IncomingMessage): boolean {
  if (!hasSession(gate, req)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return READ.has(req.method ?? "GET");
  return originAllowed(origin, req.headers.host);
}

/** True when the request carries a valid session cookie, whatever its method and `Origin` (what `GET /services/control` reports). */
export function hasSession(gate: Gate, req: http.IncomingMessage): boolean {
  let key: Buffer | undefined;
  try { key = gate.sessionKey(); } catch { key = undefined; }
  return sessionValid(key, sessionCookie(req.headers.cookie));
}

/**
 * The one decision every route the control token gates makes, in normal mode and in config recovery mode, on any full-surface
 * address (DASH-CTRL-011): a request that carries `Authorization` is judged by that header alone (`Bearer <token>` that the
 * store's verifier accepts, `busy` when too many checks wait, STORE-TOK-003); one without it passes on a valid session cookie
 * whose request names its own origin (or, for a read, names none). Nothing else lifts it: not a loopback bind, not a loopback peer.
 */
// @spec DASH-CTRL-011, CTRL-CONFIG-003
export async function authorized(gate: Gate, req: http.IncomingMessage): Promise<BearerResult> {
  if (req.headers.authorization !== undefined) return bearerOk(req.headers.authorization, (t) => gate.verify(t));
  return sessionCounts(gate, req) ? "ok" : "bad";
}

/**
 * The gate's refusal: 401 with `www-authenticate: Bearer`, or, when the check was not run because too many wait, 429 with
 * `retry-after: 1` (settings-store STORE-TOK-003); as JSON `{ok: false, detail}` or, for the plain routes, as text.
 */
export function unauthorized(res: http.ServerResponse, as: "json" | "text" = "text", busy = false): void {
  const status = busy ? 429 : 401;
  const headers: Record<string, string> = busy ? { "retry-after": "1" } : { "www-authenticate": "Bearer" };
  const detail = busy ? "too many token checks are waiting; try again in a second" : "unauthorized";
  if (as === "json") {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify({ ok: false, detail }));
    return;
  }
  res.writeHead(status, headers);
  res.end(detail);
}

/**
 * Runs the gate on `req` and answers its refusal (draining the request body), so a route goes on only when this returns true.
 */
export async function pass(gate: Gate, req: http.IncomingMessage, res: http.ServerResponse, as: "json" | "text" = "text"): Promise<boolean> {
  const r = await authorized(gate, req);
  if (r === "ok") return true;
  req.resume();
  unauthorized(res, as, r === "busy");
  return false;
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
export async function handleUnlock(d: { gate: Gate; links: UnlockLinks }, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/unlock") {
    const ok = d.links.consume(url.searchParams.get("n"));
    // The browser the link already unlocked may open it again (a second click on the terminal line, a restored tab): it goes
    // on to its unlocked dashboard, keeping the session it holds.
    if (!ok && hasSession(d.gate, req)) {
      res.writeHead(303, { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end();
      return true;
    }
    let key: Buffer | undefined;
    try { key = d.gate.sessionKey(); } catch { key = undefined; }
    if (!ok || !key) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      res.end(BAD_LINK_PAGE);
      return true;
    }
    res.writeHead(303, {
      location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": `${SESSION_COOKIE}=${newSession(key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
    });
    res.end();
    return true;
  }
  if (req.method === "POST" && url.pathname === "/unlock/link") {
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(value));
    };
    // The one gate: the token, or the session cookie of an unlocked browser minting a link for another (DASH-CTRL-011).
    if (!(await pass(d.gate, req, res, "json"))) return true;
    const base = d.links.base ?? `http://${req.headers.host ?? "127.0.0.1"}`;
    req.resume();
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
