// The bus benchmark's `--runs` and `--json` output (BUS-NAT-GATE-007), run with the smallest inputs it accepts.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Redis } from "ioredis";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
async function redisUp(): Promise<boolean> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 500 });
  try { await r.connect(); await r.ping(); return true; } catch { return false; } finally { r.disconnect(); }
}
const hasRedis = await redisUp();
const root = fileURLToPath(new URL("../../../", import.meta.url));

const median = (a: number[]) => { const s = [...a].toSorted((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

// @spec BUS-NAT-GATE-007
test("bus-bench --runs 2 --json writes one JSON document: every run's rows and the medians of cpu% and p99ms", { skip: !hasRedis && `no Redis at ${url}`, timeout: 60_000 }, () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/dev/bus-bench.ts", "--sources", "1", "--seconds", "1", "--runs", "2", "--json", "--redis", url], { cwd: root, encoding: "utf8", timeout: 50_000 });
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout) as { runs: Record<string, number | string>[][]; medians: Record<string, number | string>[] };
  assert.equal(doc.runs.length, 2, "one entry per run");
  for (const rows of doc.runs) {
    assert.deepEqual(rows.map((x) => [x.path, x.sources]), [["events", 1], ["frames", 1]]);
    for (const row of rows) for (const k of ["path", "sources", "cpu%", "p99ms"]) assert.ok(k in row, `row has ${k}`);
  }
  assert.equal(doc.medians.length, doc.runs[0]!.length);
  doc.medians.forEach((m, i) => {
    assert.deepEqual([m.path, m.sources], [doc.runs[0]![i]!.path, doc.runs[0]![i]!.sources]);
    for (const k of ["cpu%", "p99ms"]) assert.equal(m[k], median(doc.runs.map((rows) => rows[i]![k] as number)), `median of ${k}`);
  });
});
