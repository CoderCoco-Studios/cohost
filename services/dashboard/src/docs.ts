import type http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { findWorkspaceRoot } from "@cohost/config";
import { inside, isFile, real, send, serveFile } from "./static.js";

/** The docs directory: `docs/.vitepress/dist` under the workspace root, or under the working directory when there is none. */
// @spec DASH-DOCS-001
export function locateDocsDir(): string {
  return join(findWorkspaceRoot() ?? process.cwd(), "docs", ".vitepress", "dist");
}

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Docs not built</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#8882;padding:.1em .3em;border-radius:4px}</style></head>
<body><h1>Docs not built</h1>
<p>The docs site has not been built yet. Run <code>pnpm docs:build</code> in the repository, then reload this page.</p>
<p><code>pnpm dashboard</code> builds the docs each time it starts.</p></body></html>
`;

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
