// Subprocess fixture: a beforeShutdown hook that never settles delays the callbacks by at most 2 s.
import { beforeShutdown, onShutdown } from "../src/index.js";
const started = performance.now();
const realExit = process.exit.bind(process);
process.exit = ((code?: number) => { console.log(`exit:${code}`); realExit(code); }) as typeof process.exit;
beforeShutdown(() => new Promise<void>(() => {}));
onShutdown(() => { console.log(`cb:${Math.round((performance.now() - started - 100) / 500) * 500}`); });
setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
setTimeout(() => {}, 10_000);
