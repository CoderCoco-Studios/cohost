import type http from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Content types by extension (DASH-DOCS-005); the docs site and the UI bundle share them. */
export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
export const real = (p: string): string | undefined => { try { return realpathSync(p); } catch { return undefined; } };
export const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

export function send(res: http.ServerResponse, head: boolean, status: number, headers: http.OutgoingHttpHeaders, body?: string | Buffer): void {
  res.writeHead(status, headers);
  res.end(head || body === undefined ? undefined : body);
}

/**
 * Answers one regular file: read whole before the status is written (a failed read is still a 500), with
 * `content-type`, `content-length`, `nosniff`, a weak size-and-mtime etag, `immutable` caching for a file under
 * `assets/` and `no-cache` otherwise, and a 304 when `If-None-Match` lists the etag or is `*`.
 */
// @spec DASH-DOCS-005, DASH-DOCS-006, DASH-BUILD-003
export function serveFile(res: http.ServerResponse, req: http.IncomingMessage, head: boolean, root: string, file: string): true {
  const body = readFileSync(file);
  const st = statSync(file);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const parts = relative(root, file).split(sep);
  const cache = parts[0] === "assets" && parts.length > 1 ? "public, max-age=31536000, immutable" : "no-cache";
  const inm = req.headers["if-none-match"];
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  if (inm !== undefined && (inm.trim() === "*" || inm.split(",").some((t) => bare(t) === bare(etag)))) {
    send(res, head, 304, { etag, "cache-control": cache });
    return true;
  }
  send(res, head, 200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
    "x-content-type-options": "nosniff",
    etag,
    "cache-control": cache,
  }, body);
  return true;
}

/** The built UI: `services/dashboard/dist-ui`, beside the server's `dist/` (and `src/` when run through tsx). */
// @spec DASH-BUILD-001
export function locateUiDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-ui");
}

const escapeHtml = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/** The page `GET /` answers while the bundle is missing: loads nothing, names the command that builds it. */
const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard not built</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>Dashboard not built</h1>
<p>The dashboard's web page has not been built yet. Run <code>pnpm build</code> in the repository, then reload this page.</p>
<p><code>pnpm dashboard</code> builds it each time it starts.</p></body></html>
`;

/**
 * The UI's own requests: `GET /` (the built `index.html`, read on every request, with the HTML-escaped co-host
 * name in place of every `__COHOST_NAME__`) and `GET`/`HEAD` for `/assets/*` and `/favicon.svg`. Returns false for
 * anything else, which the caller routes on. Served on both listeners.
 */
// @spec DASH-HTTP-001, DASH-BUILD-003, DASH-BUILD-004, DASH-BUILD-005
export function handleUi(dir: string, cohostName: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const path = url.pathname;
  const root = resolve(dir);
  if (path === "/") {
    if (req.method !== "GET") return false;
    const index = join(root, "index.html");
    if (!isFile(index)) {
      send(res, false, 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(NOT_BUILT) }, NOT_BUILT);
      return true;
    }
    const page = Buffer.from(readFileSync(index, "utf8").split("__COHOST_NAME__").join(escapeHtml(cohostName)));
    send(res, false, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-length": page.length }, page);
    return true;
  }
  if (path !== "/favicon.svg" && !path.startsWith("/assets/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const head = req.method === "HEAD";
  let rel: string;
  try { rel = decodeURIComponent(path.slice(1)); } catch { rel = "\0"; }
  if (rel.includes("\0")) { send(res, head, 400, { "content-type": "text/plain; charset=utf-8", "content-length": 11 }, "bad request"); return true; }
  const file = resolve(root, rel);
  const rp = real(file);
  const realRoot = real(root) ?? root;
  if (!inside(root, file) || rp === undefined || !inside(realRoot, rp) || !isFile(file)) {
    send(res, head, 404, { "content-type": "text/plain; charset=utf-8", "content-length": 9 }, "not found");
    return true;
  }
  return serveFile(res, req, head, root, file);
}

/** The renderer page's Content-Security-Policy: its own script and style, `blob:` and `data:` images and fetches, nothing else (DASH-AVP-002). */
// @spec DASH-AVP-002
export const AVATAR_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob: data:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/** The page `GET /avatar` answers while the renderer page is not built: loads nothing, names the command that builds it (DASH-AVP-001). */
const AVATAR_NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Avatar renderer not built</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>Avatar renderer not built</h1>
<p>The avatar renderer page has not been built yet. Run <code>pnpm build</code> in the repository, then reload this page.</p></body></html>
`;

/** The not-built page loads nothing: its one style is inline, and no script, image or frame is allowed (DASH-AVP-001). */
const AVATAR_NOT_BUILT_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";

/**
 * `GET`/`HEAD /avatar`: the built `avatar.html`, read on each request, with the fixed Content-Security-Policy, or the 503
 * 'not built' page when it is not a regular file. Served on both listeners (DASH-AVP-001, DASH-AVP-002).
 */
// @spec DASH-AVP-001, DASH-AVP-002
export function handleAvatarPage(dir: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== "/avatar") return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const head = req.method === "HEAD";
  const file = join(resolve(dir), "avatar.html");
  const type = "text/html; charset=utf-8";
  if (!isFile(file)) {
    send(res, head, 503, { "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(AVATAR_NOT_BUILT), "x-content-type-options": "nosniff", "content-security-policy": AVATAR_NOT_BUILT_CSP }, AVATAR_NOT_BUILT);
    return true;
  }
  const body = readFileSync(file);
  send(res, head, 200, { "content-type": type, "cache-control": "no-cache", "content-length": body.length, "content-security-policy": AVATAR_CSP, "x-content-type-options": "nosniff" }, body);
  return true;
}
