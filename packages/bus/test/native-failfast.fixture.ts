// Subprocess fixture of native-integration.test.ts: a failFast Bus against a closed port. Writes its findings to the file
// named by argv[2]; stdout and stderr must stay empty (BUS-STREAM-009).
import { writeFileSync } from "node:fs";
import { Bus } from "../src/index.js";

const bus = new Bus("t", undefined, "redis://127.0.0.1:1", { failFast: true });
const t0 = Date.now();
const first = await bus.recentHealth(1).then(() => undefined, (e: { code?: string; message?: string }) => e);
const firstMs = Date.now() - t0;
const t1 = Date.now();
const second = await bus.serverTime().then(() => undefined, (e: { code?: string; message?: string }) => e);
const secondMs = Date.now() - t1;
await bus.stop();
writeFileSync(process.argv[2]!, JSON.stringify({
  first: first && { code: first.code, message: first.message }, firstMs,
  second: second && { code: second.code, message: second.message }, secondMs,
}));
process.exit(0);
