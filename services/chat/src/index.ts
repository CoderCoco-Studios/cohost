/** chat service entry point; the service itself is `service.ts`. */
import { runService } from "@cohost/shared";
import { chatService } from "./service.js";

const svc = chatService();
// @spec CHAT-HEALTH-001
await runService({ service: "chat", health: (cfg) => svc.health(cfg), main: svc.main });
