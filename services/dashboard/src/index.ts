/**
 * dashboard — a host process (`pnpm dashboard`), http://localhost:3000
 *
 * - Live feed of everything on the bus, brain status, avatar preview
 * - Stack panel: Launch / Stop / Restart-all for the Compose stack (control mode), and per-service control
 * - Audio sink: plays the co-host's voice. Add http://<ai-pc>:3001/?sink=1 as an OBS Browser Source
 *   (with "control audio via OBS") and the voice lands on stream with no virtual cables.
 * - Mute / unmute / make it say something / wipe context
 * - Edit personality.md live (brain reloads it on save)
 *
 * Two listeners: the full surface on DASHBOARD_HOST (default 127.0.0.1) and a LAN listener on all interfaces
 * that serves only the sink page and its audio.
 *
 * The entry is one call to the shared bootstrap; the service itself is `service.ts`.
 */
import { runService } from "@cohost/shared";
import { dashboardService } from "./service.js";

const svc = dashboardService();
// @spec DASH-HTTP-016
await runService({ service: "dashboard", health: svc.health, main: svc.main });
