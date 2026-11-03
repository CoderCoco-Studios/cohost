// Subprocess fixture: a beforeShutdown hook that throws synchronously must not skip the others or the callbacks.
import { beforeShutdown, onShutdown } from "../src/index.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeShutdown(() => { throw new Error("hook threw synchronously"); });
beforeShutdown(async () => { await sleep(50); console.log("hook2"); });
onShutdown(() => { console.log("cb"); });
setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
setTimeout(() => {}, 5000);
