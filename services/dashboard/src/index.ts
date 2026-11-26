/**
 * dashboard — a host process (`mise run dashboard`), http://localhost:3000
 *
 * - Live feed of everything on the bus, brain status, avatar preview
 * - Stack panel: Launch / Stop / Restart-all for the Compose stack (control mode), and per-service control
 * - Audio sink: plays the co-host's voice. Add http://<ai-pc-ip>:3001/?sink=1 (by IP address, or by a name listed in dashboard.allowed_hosts; DASH-HOST-009) as an OBS Browser Source
 *   (with "control audio via OBS") and the voice lands on stream with no virtual cables.
 * - Mute / unmute / make it say something / wipe context
 * - Edit personality.md live (brain reloads it on save)
 *
 * Two listeners: the full surface on DASHBOARD_HOST (default 127.0.0.1) and a LAN listener on all interfaces
 * that serves only the sink page and its audio.
 *
 * The entry loads the configuration (running config recovery mode while config.yaml or secrets.yaml does not validate,
 * `recovery.ts`) and then makes one call to the shared bootstrap; the service itself is `service.ts`.
 */
import { createLogger } from "@cohost/config";
import { runService } from "@cohost/shared";
import { dashboardService } from "./service.js";
import { startDashboard } from "./recovery.js";

const svc = dashboardService();
const log = createLogger("dashboard");
// @spec DASH-HTTP-016, DASH-RCV-001
await startDashboard({ log, run: (cfg) => runService({ service: "dashboard", health: svc.health, main: svc.main, log, ...(cfg ? { loadConfig: () => cfg } : {}) }) });
