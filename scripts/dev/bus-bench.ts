/**
 * Bus throughput/latency micro-benchmark at audio-stream rate (dev-only measurement, no spec).
 *
 *   node --import tsx scripts/dev/bus-bench.ts [--sources N] [--seconds S] [--runs R] [--json] [--redis URL]
 *
 * --runs R repeats the whole measurement R times (default 1) and prints each run's table plus per-row medians of
 * cpu% and p99ms; --json writes one JSON document (every run's rows and the medians) to stdout instead of tables.
 *
 * Drives the real `Bus` from packages/bus on a private stream prefix (`bench<pid>`, deleted afterwards; running
 * services are untouched): N sources x 50 msg/s of 640-byte (20 ms, 16 kHz mono s16) PCM frames, one consumer,
 * latency = receive - publish on one performance.now() clock (publisher and consumer share this process/event loop).
 * Two paths, each run for 1 source and N sources:
 *   events - publish()/subscribe(): zod parse, JSON, XADD MAXLEN, XREADGROUP + per-entry XACK. Real audio frames do
 *            NOT use this path; it is a `chat.message` carrying base64 PCM in `text` (worst-case bus path).
 *   frames - publishFrame()/tailAudio(): the real audio.in.<tag> path (XADD MAXLEN ~3000, plain XREAD, no group/ack).
 * Final line: pass/fail of "p99 hop latency < 5 ms" over every phase.
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { Bus, type EventInput } from "../../packages/bus/src/index.js";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const N = Number(arg("sources", "3")), SECONDS = Number(arg("seconds", "20")), RUNS = Math.max(1, Number(arg("runs", "1")));
const JSON_OUT = process.argv.includes("--json");
const URL_ = arg("redis", process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const RATE = 50, FRAME_BYTES = 640, THRESH_MS = 5;
const pcm = Buffer.alloc(FRAME_BYTES, 1);
const b64 = pcm.toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? NaN;

interface Row { phase: string; target: number; got: number; p50: number; p95: number; p99: number; max: number; cpu: number; eld99: number }
let rows: Row[] = [];

async function phase(path: "events" | "frames", sources: number, prefix: string): Promise<void> {
  const bus = new Bus(`bench-${path}`, undefined, URL_, { streamPrefix: prefix });
  const lat: number[] = [];
  let sent = 0, stop = false;
  const tag = (i: number) => `src${i}`;
  let ready: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  let readers: Promise<void>[];
  if (path === "events") {
    readers = [bus.subscribe({ group: "bench", start: "latest", onReady: () => ready() }, (e) => {
      if (e.type === "chat.message") lat.push(performance.now() - Number(e.data.userId));
    })];
  } else {
    // tailAudio starts at `$` on its first read, so give each reader a head start before publishing.
    readers = Array.from({ length: sources }, (_, i) => bus.tailAudio("in", tag(i), (d) => {
      if (d.ok) lat.push(performance.now() - Number(d.frame.name));
    }));
    setTimeout(() => ready(), 300);
  }
  await readyP; await sleep(300);

  const eld = monitorEventLoopDelay({ resolution: 1 }); eld.enable();
  const cpu0 = process.cpuUsage(), t0 = performance.now();
  const pubs = Array.from({ length: sources }, async (_, i) => {
    for (let k = 0; !stop; k++) {
      const wait = t0 + (k * 1000) / RATE - performance.now();
      if (wait > 0) await sleep(wait);
      const now = performance.now();
      sent++;
      if (path === "events") {
        await bus.publish("chat.message", { platform: "discord", user: tag(i), userId: String(now), text: b64 } as EventInput<"chat.message">);
      } else {
        await bus.publishFrame("in", tag(i), { epoch: 1, seq: k, rate: 16000, ch: 1, pcm, spk: tag(i), name: String(now) });
      }
    }
  });
  await sleep(SECONDS * 1000); stop = true;
  await Promise.all(pubs); await sleep(500);
  const wall = performance.now() - t0, cu = process.cpuUsage(cpu0); eld.disable();
  const got = lat.length; lat.sort((a, b) => a - b);
  rows.push({
    phase: `${path} x${sources}`, target: sources * RATE, got: got / (SECONDS + 0.5), p50: pct(lat, 50), p95: pct(lat, 95),
    p99: pct(lat, 99), max: lat[got - 1] ?? NaN, cpu: ((cu.user + cu.system) / 1000 / wall) * 100, eld99: eld.percentile(99) / 1e6,
  });
  if (sent !== got) (JSON_OUT ? console.error : console.log)(`  ${path} x${sources}: sent ${sent}, received ${got}`);
  bus.stop(); await Promise.race([Promise.allSettled(readers), sleep(1000)]);
}

const prefix = `bench${process.pid}`;
const runs: Row[][] = [];
try {
  for (let r = 0; r < RUNS; r++) {
    rows = [];
    for (const path of ["events", "frames"] as const) for (const s of [...new Set([1, N])]) await phase(path, s, prefix);
    runs.push(rows);
  }
} finally {
  const { Redis } = createRequire(new URL("../../packages/bus/package.json", import.meta.url))("ioredis");
  const r = new Redis(URL_);
  const keys: string[] = await r.keys(`${prefix}:*`);
  if (keys.length) await r.del(...keys);
  r.disconnect();
}
const f = (n: number) => n.toFixed(2);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const medians = runs[0]!.map((_, i) => ({
  path: runs[0]![i]!.phase.split(" ")[0]!, sources: runs[0]![i]!.target / RATE, "cpu%": median(runs.map((x) => x[i]!.cpu)), p99ms: median(runs.map((x) => x[i]!.p99)),
}));
const ok = runs.every((rs) => rs.every((x) => x.p99 < THRESH_MS));
if (JSON_OUT) {
  console.log(JSON.stringify({
    runs: runs.map((rs) => rs.map((x) => ({ path: x.phase.split(" ")[0], sources: x.target / RATE, "cpu%": x.cpu, p99ms: x.p99, p50ms: x.p50, p95ms: x.p95, maxms: x.max, gotPerS: x.got, eld99ms: x.eld99 }))),
    medians, pass: ok,
  }, null, 2));
} else {
  runs.forEach((rs, r) => {
    if (RUNS > 1) console.log(`run ${r + 1}/${RUNS}`);
    console.log("phase          target/s  got/s    p50ms  p95ms  p99ms  maxms   cpu%   eld99ms");
    for (const x of rs) {
      console.log(`${x.phase.padEnd(14)} ${String(x.target).padStart(8)} ${f(x.got).padStart(7)} ${f(x.p50).padStart(7)} ${f(x.p95).padStart(6)} ${f(x.p99).padStart(6)} ${f(x.max).padStart(7)} ${f(x.cpu).padStart(6)} ${f(x.eld99).padStart(8)}`);
    }
  });
  if (RUNS > 1) {
    console.log(`median over ${RUNS} runs`);
    console.log("phase          cpu%   p99ms");
    for (const m of medians) console.log(`${`${m.path} x${m.sources}`.padEnd(14)} ${f(m["cpu%"]).padStart(6)} ${f(m.p99ms).padStart(7)}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}: p99 hop latency < ${THRESH_MS} ms (worst p99 ${f(Math.max(...runs.flat().map((x) => x.p99)))} ms)`);
}
process.exit(0);
