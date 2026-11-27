/**
 * dashboard — a host process (`mise run dashboard`), http://localhost:3000
 *
 * - Live feed of everything on the bus, brain status, avatar preview
 * - Stack panel: Launch / Stop / Restart-all for the Compose stack, and per-service control, behind the one lock (the control token)
 * - Audio sink: plays the co-host's voice. Add http://<ai-pc-ip>:3001/?sink=1 (by IP address, or by a name listed in dashboard.allowed_hosts; DASH-HOST-009) as an OBS Browser Source
 *   (with "control audio via OBS") and the voice lands on stream with no virtual cables.
 * - Mute / unmute / make it say something / wipe context
 * - Settings, credentials and the personality, read from and written to the settings store
 *
 * Two listeners: the full surface on DASHBOARD_HOST (default 127.0.0.1) and a LAN listener on all interfaces
 * that serves only the sink page and its audio.
 *
 * The entry opens the settings store (running config recovery mode while it cannot be used, `recovery.ts`) and then makes one
 * call to the shared bootstrap with the store's configuration; the service itself is `service.ts`.
 */
import { createLogger } from "@cohost/config";
import { runService } from "@cohost/shared";
import { dashboardService } from "./service.js";
import { startDashboard } from "./recovery.js";

// @spec DASH-HTTP-016, DASH-RCV-001
await startDashboard({
  makeLog: () => createLogger("dashboard"),
  run: async (store, cfg) => {
    const svc = dashboardService({ store });
    // The dashboard supplies its own configuration, so it waits for no credentials message (shared-runtime SHARED-BOOT-001).
    await runService({ service: "dashboard", health: svc.health, main: svc.main, log: createLogger("dashboard"), loadConfig: () => cfg });
  },
});
