// Subprocess fixture: several onShutdown callbacks, the first two failing, share one shutdown sequence.
import { onShutdown } from "../src/index.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realExit = process.exit.bind(process);
process.exit = ((code?: number) => { console.log(`exit:${code}`); realExit(code); }) as typeof process.exit;
onShutdown(async () => { console.log("cb1"); throw new Error("cb1 rejected"); });
onShutdown(() => { console.log("cb2"); throw new Error("cb2 threw"); });
onShutdown(async () => { await sleep(150); console.log("cb3"); });
onShutdown(() => { console.log("cb4"); });
setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
setTimeout(() => process.kill(process.pid, "SIGINT"), 130); // a later signal is ignored
setTimeout(() => {}, 5000);
