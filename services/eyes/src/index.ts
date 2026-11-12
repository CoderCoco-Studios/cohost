/** eyes service entry point; the service itself is `service.ts`. */
import OBSWebSocket from "obs-websocket-js";
import { runService } from "@cohost/shared";
import { eyesService } from "./service.js";

const svc = eyesService({ obs: new OBSWebSocket() as never });
await runService({ service: "eyes", health: (cfg) => svc.health(cfg), main: svc.main });
