import type http from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { findWorkspaceRoot } from "@cohost/config";

/** The docs directory: `docs/.vitepress/dist` under the workspace root, or under the working directory when there is none. */
// @spec DASH-DOCS-001
export function locateDocsDir(): string {
  return join(findWorkspaceRoot() ?? process.cwd(), "docs", ".vitepress", "dist");
}

const TYPES: Record<string, string> = {
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

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Docs not built</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>Docs not built</h1>
<p>The docs site has not been built yet. Run <code>pnpm docs:build</code> in the repository, then reload this page.</p>
<p><code>pnpm dashboard</code> builds the docs each time it starts.</p></body></html>
`;

const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
const real = (p: string): string | undefined => { try { return realpathSync(p); } catch { return undefined; } };
const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

function send(res: http.ServerResponse, head: boolean, status: number, headers: http.OutgoingHttpHeaders, body?: string | Buffer): void {
  res.writeHead(status, headers);
  res.end(head || body === undefined ? undefined : body);
}

/** Answers `GET`/`HEAD` for `/cohost` and `/cohost/...` from the built docs; false for anything else, which the caller routes on. */
// @spec DASH-DOCS-001, DASH-DOCS-002, DASH-DOCS-003, DASH-DOCS-004, DASH-DOCS-005, DASH-DOCS-006, DASH-DOCS-007, DASH-DOCS-008, DASH-DOCS-009, DASH-DOCS-010, DASH-DOCS-011
export function handleDocs(dir: string, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  const path = url.pathname;
  if (path !== "/cohost" && !path.startsWith("/cohost/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false; // the catch-all 404 answers it
  const head = req.method === "HEAD";
  const root = resolve(dir);

  // 1. Built?
  if (!isFile(join(root, "index.html"))) {
    send(res, head, 503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(NOT_BUILT) }, NOT_BUILT);
    return true;
  }

  // 2. Decode and guard.
  let rem: string;
  try { rem = decodeURIComponent(path === "/cohost" ? "" : path.slice("/cohost/".length)); } catch { rem = "\0"; }
  if (rem.includes("\0")) { send(res, head, 400, { "content-type": "text/plain; charset=utf-8", "content-length": 11 }, "bad request"); return true; }

  const realRoot = real(root) ?? root;
  const notFound = (): true => {
    const page = join(root, "404.html");
    const rp = real(page);
    if (rp !== undefined && inside(realRoot, rp) && isFile(page)) {
      const body = readFileSync(page);
      send(res, head, 404, { "content-type": "text/html; charset=utf-8", "content-length": body.length, "x-content-type-options": "nosniff", "cache-control": "no-cache" }, body);
    } else {
      send(res, head, 404, { "content-type": "text/plain; charset=utf-8", "content-length": 9 }, "not found");
    }
    return true;
  };

  const target = resolve(root, rem);
  if (!inside(root, target)) return notFound();
  /** "ok": exists inside the root; "outside": exists but resolves outside; "none": does not exist. */
  const check = (p: string): "ok" | "outside" | "none" => {
    if (!inside(root, p)) return "outside";
    const rp = real(p);
    if (rp === undefined) return "none";
    return inside(realRoot, rp) ? "ok" : "outside";
  };

  // 3. Resolve.
  const slash = rem === "" ? path === "/cohost/" : rem.endsWith("/");
  const candidates = path === "/cohost" ? [] : slash ? [join(target, "index.html")] : [target, `${target}.html`];
  for (const c of candidates) {
    const state = check(c);
    if (state === "outside") return notFound();
    if (state === "ok" && isFile(c)) return serveFile(res, req, head, root, c);
  }
  if (!slash) {
    const idx = join(target, "index.html");
    const dirState = check(target), idxState = check(idx);
    if (dirState === "outside" || idxState === "outside") return notFound();
    if (dirState === "ok" && idxState === "ok" && isFile(idx) && statSync(target).isDirectory()) {
      send(res, head, 301, { location: `${path}/${url.search}`, "content-length": 0 });
      return true;
    }
  }
  return notFound();
}

function serveFile(res: http.ServerResponse, req: http.IncomingMessage, head: boolean, root: string, file: string): true {
  const body = readFileSync(file); // whole file first: a failed read is still answerable with a 500
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
