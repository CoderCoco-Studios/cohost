import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { createDevProxy } from "./dev-proxy";

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

// The production build is one entry script and one stylesheet, no dynamic imports, no source maps, so a tab left
// open across a rebuild never asks for a chunk whose hashed name has gone (DASH-BUILD-001).
export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), dashboardProxy()],
  server: { host: "127.0.0.1", strictPort: false }, // loopback only (DASH-BUILD-007)
  build: {
    outDir: resolve(here, "..", "dist-ui"),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false as const,
    assetsInlineLimit: 0,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
