import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createDevProxy } from "./dev-proxy";
import { buildNotices, isLicenceFile, manifestLicence, type BundledPackage } from "./notices";

const here = dirname(fileURLToPath(import.meta.url));

/** The running dashboard the dev server forwards to: `dashboard.port` of `config.yaml` on loopback (3000 when it cannot be read). */
async function dashboardTarget(): Promise<string> {
  try {
    const { loadConfig } = await import("@cohost/config");
    return `http://127.0.0.1:${loadConfig().dashboard.port}`;
  } catch { return "http://127.0.0.1:3000"; }
}

/** Mounts the dev proxy ahead of Vite's own middleware and on the HTTP server's `upgrade` event (DASH-BUILD-007). */
function dashboardProxy(): Plugin {
  return {
    name: "cohost-dashboard-proxy",
    apply: "serve",
    async configureServer(server) {
      const proxy = createDevProxy(await dashboardTarget());
      server.middlewares.use((req, res, next) => { if (!proxy.middleware(req, res)) next(); });
      server.httpServer?.on("upgrade", (req, socket, head) => { proxy.upgrade(req, socket, head); });
    },
  };
}

/**
 * The package a module id belongs to, when it lies under a `node_modules` folder: the last `node_modules/` on the path,
 * then the scoped or plain package name after it. Null for a workspace module (its real path is outside `node_modules`).
 */
function packageDir(id: string): { dir: string; name: string } | null {
  const path = id.split("?")[0]!;
  const marker = "/node_modules/";
  const at = path.lastIndexOf(marker);
  if (at < 0) return null;
  const parts = path.slice(at + marker.length).split("/");
  const name = parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return { dir: path.slice(0, at + marker.length) + name, name };
}

/** A bundled package's manifest fields and its root's licence files (DEPLOY-LIC-005). */
function readPackage(dir: string, name: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string; license?: unknown; licenses?: unknown };
  const license = manifestLicence(manifest);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => isLicenceFile(f) && statSync(join(dir, f)).isFile()).sort().map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }))
    : [];
  return { name: manifest.name ?? name, version: manifest.version ?? "0.0.0", license, workspace: false, files };
}

/**
 * Writes `assets/third-party-notices-<hash>.txt` for the packages every entry bundles, and names it on the first line of
 * each entry script. A licence the allow-list refuses, or a package with no licence text, fails the build (DEPLOY-LIC-005 to -007).
 */
function thirdPartyNotices(): Plugin {
  return {
    name: "cohost-third-party-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      const found = new Map<string, BundledPackage>();
      const cache = new Map<string, BundledPackage>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        for (const id of [...item.moduleIds, ...Object.keys(item.modules)]) {
          const p = packageDir(id);
          if (p === null) continue;
          let pkg = cache.get(p.dir);
          if (pkg === undefined) { pkg = readPackage(p.dir, p.name); cache.set(p.dir, pkg); }
          found.set(p.dir, pkg);
        }
      }
      const { text, fileName } = buildNotices([...found.values()]);
      this.emitFile({ type: "asset", fileName: `assets/${fileName}`, source: text });
      for (const item of Object.values(bundle)) {
        if (item.type === "chunk" && item.isEntry) item.code = `/* Third-party notices: assets/${fileName} */\n${item.code}`;
      }
    },
  };
}

// The production build is two self-contained entries, the dashboard (`index.html`) and the renderer page (`avatar.html`):
// each has one entry script and one stylesheet, no dynamic imports and no chunk shared between them (the two share no
// module, so code splitting makes no shared chunk), and no source maps,
// so a tab left open across a rebuild never asks for a file whose hashed name has gone (DASH-BUILD-001).
export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), dashboardProxy(), thirdPartyNotices()],
  server: { host: "127.0.0.1", strictPort: false }, // loopback only (DASH-BUILD-007)
  build: {
    outDir: resolve(here, "..", "dist-ui"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    // The minifier rewrites `transparent` to an invalid `00` (the avatar page relies on it), so CSS is not minified.
    cssMinify: false,
    modulePreload: false as const,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { index: resolve(here, "index.html"), avatar: resolve(here, "avatar.html") },
    },
  },
});
