// Subprocess fixture of native-integration.test.ts: a failFast Bus against a closed port. Writes its findings to the file
// named by argv[2]; stdout and stderr must stay empty (BUS-STREAM-009, BUS-NAT-FRM-006). Covers both paths: the events
// transport and the frames path.
import { writeFileSync } from "node:fs";
import { Bus } from "../src/index.js";

const bus = new Bus("t", undefined, "redis://127.0.0.1:1", { failFast: true });
const t0 = Date.now();
const first = await bus.recentHealth(1).then(() => undefined, (e: { code?: string; message?: string }) => e);
const firstMs = Date.now() - t0;
const t1 = Date.now();
const second = await bus.serverTime().then(() => undefined, (e: { code?: string; message?: string }) => e);
const secondMs = Date.now() - t1;
const frame = { epoch: 1, seq: 0, rate: 16000, ch: 1, pcm: Buffer.alloc(4) };
const f0 = Date.now();
const frameFirst = await bus.publishFrame("in", "t", frame).then(() => undefined, (e: { code?: string; message?: string }) => e);
const frameFirstMs = Date.now() - f0;
const f1 = Date.now();
const frameSecond = await bus.publishFrame("in", "t", frame).then(() => undefined, (e: { code?: string; message?: string }) => e);
const frameSecondMs = Date.now() - f1;
const tailed = bus.tailAudio("in", "t", () => {}, () => {});
await new Promise((r) => setTimeout(r, 300));
await bus.stop();
await tailed;
writeFileSync(process.argv[2]!, JSON.stringify({
  frameFirst: frameFirst && { code: frameFirst.code, message: frameFirst.message }, frameFirstMs,
  frameSecond: frameSecond && { code: frameSecond.code, message: frameSecond.message }, frameSecondMs,
  first: first && { code: first.code, message: first.message }, firstMs,
  second: second && { code: second.code, message: second.message }, secondMs,
}));
process.exit(0);
