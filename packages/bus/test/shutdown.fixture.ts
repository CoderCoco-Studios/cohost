// Subprocess fixture: SIGTERM must publish `stopping` before the service's own shutdown callback.
import { startHeartbeat, onShutdown } from "../src/index.js";
const bus = {
  consumer: "fx",
  async publishHealth(d: { state: string }) { await new Promise((r) => setTimeout(r, 30)); console.log(`hb:${d.state}`); return "1"; },
};
const h = startHeartbeat(bus as never, { service: "fx", mode: "live", deps: {}, intervalMs: 60_000 });
h.ready();
onShutdown(() => { console.log("bus.stop"); });
setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
setTimeout(() => {}, 5000);
