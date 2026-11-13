import { test } from "node:test";
import assert from "node:assert/strict";
import { executeCli, type CliWiring, type LockResult, type Runtime } from "../src/index.js";

interface Ev { id: string; type: string; ts: number; source: string; data: Record<string, unknown> }
let n = 0;
const ev = (type: string, ts: number, data: Record<string, unknown>): Ev => ({ id: `${ts}-${n++}`, type, ts, source: "t", data });

const T = 1_000_000;
/** A fully stamped line: stt 400, salience 600, prep 100, llm 1000, critic 300, say 50, tts 500, sink 50 = total 3100. */
const FULL = { audioEndedAt: T, heardAt: T + 400, focusedAt: T + 1000, llmStartedAt: T + 1100, llmEndedAt: T + 2100, criticEndedAt: T + 2400 };
function line(id: string, over: { timing?: Record<string, unknown>; say?: Record<string, unknown>; utt?: number | null; playing?: Array<[number, string]> } = {}): Ev[] {
  const out: Ev[] = [ev("brain.say", T + 2450, { id, text: "hi", emotion: "happy", timing: { ...FULL, ...over.timing }, ...over.say })];
  if (over.utt !== null) out.push(ev("voice.utterance", T + (over.utt ?? 2950), { id }));
  for (const [ts, sink] of over.playing ?? [[T + 3000, "discord"]]) out.push(ev("voice.playing", ts, { id, sink }));
  return out;
}

function rig(history: Ev[], o: { recentThrows?: Error } = {}) {
  const built = { bus: 0, runtime: 0, stack: 0 };
  const lockLog: string[] = [];
  const published: unknown[] = [];
  const recentCalls: number[] = [];
  let stopped = 0;
  const bus = {
    publish: async (t: string, d: unknown) => { published.push({ t, d }); return "1"; },
    resetGroup: async () => {},
    recentHealth: async () => [],
    recent: async (count?: number) => { recentCalls.push(count as number); if (o.recentThrows) throw o.recentThrows; return history; },
    stop: () => { stopped++; },
  };
  const runtime = { name: "compose" } as unknown as Runtime;
  const out: string[] = [], err: string[] = [];
  const w: CliWiring = {
    openBus: () => { built.bus++; return bus as never; },
    buildRuntime: () => { built.runtime++; return runtime as never; },
    buildStack: () => { built.stack++; return {} as never; },
    lock: { tryAcquire: (a): LockResult => { lockLog.push(a); return { ok: true, release: () => {} }; } },
    out: (l) => out.push(l), err: (l) => err.push(l), env: {},
  };
  return { w, built, lockLog, published, recentCalls, out, err, stopped: () => stopped, text: () => out.join("\n") };
}
/** The row `<stage> <n> <p50> <p95>` of the report. */
function row(text: string, stage: string): { n: string; p50: string; p95: string } {
  const m = new RegExp(`^\\s*${stage}\\s+(\\S+)\\s+(\\S+)\\s+(\\S+)\\s*$`, "m").exec(text);
  assert.ok(m, `no row for ${stage} in:\n${text}`);
  return { n: m[1]!, p50: m[2]!, p95: m[3]! };
}
const STAGES = ["stt", "salience", "prep", "llm", "critic", "say", "tts", "sink", "total"];

// @spec CTRL-LAT-001
test("latency [--count N] parses; anything else exits 2 with the usage before a runtime or bus is built", async () => {
  for (const argv of [["latency", "--count", "0"], ["latency", "--count", "x"], ["latency", "--count", "1.5"], ["latency", "--count", "-3"], ["latency", "--bogus"], ["latency", "extra"]]) {
    const h = rig([]);
    assert.equal(await executeCli(argv, h.w), 2, JSON.stringify(argv));
    assert.deepEqual(h.built, { bus: 0, runtime: 0, stack: 0 }, JSON.stringify(argv));
    assert.match(h.err.join("\n"), /usage:/);
  }
  const ok = rig([]);
  assert.equal(await executeCli(["latency"], ok.w), 0);
  assert.deepEqual(ok.recentCalls, [5000], "default count");
  const counted = rig([]);
  assert.equal(await executeCli(["latency", "--count", "25"], counted.w), 0);
  assert.deepEqual(counted.recentCalls, [25]);
});

// @spec CTRL-LAT-002
test("latency reads history through the bus, takes no lock, publishes nothing, and stops the bus", async () => {
  const h = rig(line("a"));
  assert.equal(await executeCli(["latency"], h.w), 0);
  assert.equal(h.built.bus, 1);
  assert.deepEqual(h.lockLog, []);
  assert.deepEqual(h.published, []);
  assert.equal(h.stopped(), 1);
});

// @spec CTRL-LAT-002
test("latency with Redis unreachable reports the CTRL-CLI-017 line and exits 1", async () => {
  const e = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" });
  const h = rig([], { recentThrows: e });
  assert.equal(await executeCli(["latency"], h.w), 1);
  assert.match(h.err.join("\n"), /cannot reach Redis at .*: .*\(is the stack up\? run cohostctl launch\)/);
});

// @spec CTRL-LAT-003, CTRL-LAT-004, CTRL-LAT-005
test("a fully stamped line: nine stages with the right durations, summing to total", async () => {
  const h = rig(line("a"));
  assert.equal(await executeCli(["latency"], h.w), 0);
  const want: Record<string, number> = { stt: 400, salience: 600, prep: 100, llm: 1000, critic: 300, say: 50, tts: 500, sink: 50, total: 3000 };
  for (const s of STAGES) assert.deepEqual(row(h.text(), s), { n: "1", p50: String(want[s]), p95: String(want[s]) }, s);
  // @spec CTRL-LAT-005
  assert.deepEqual(h.out, [
    "stage        n     p50     p95",
    "stt          1     400     400",
    "salience     1     600     600",
    "prep         1     100     100",
    "llm          1    1000    1000",
    "critic       1     300     300",
    "say          1      50      50",
    "tts          1     500     500",
    "sink         1      50      50",
    "total        1    3000    3000",
  ]);
  const sum = STAGES.filter((s) => s !== "total").reduce((a, s) => a + want[s]!, 0);
  assert.equal(sum, want.total, "fixture: stages are contiguous");
});

// @spec CTRL-LAT-004
test("with no critic stamp the critic stage is empty and say starts at llmEndedAt; the other stages still sum to total", async () => {
  const { criticEndedAt: _drop, ...noCritic } = FULL;
  const h = rig([
    ev("brain.say", T + 2450, { id: "a", text: "hi", emotion: "happy", timing: noCritic }),
    ev("voice.utterance", T + 2950, { id: "a" }),
    ev("voice.playing", T + 3000, { id: "a", sink: "discord" }),
  ]);
  await executeCli(["latency"], h.w);
  assert.deepEqual(row(h.text(), "critic"), { n: "0", p50: "-", p95: "-" });
  assert.equal(row(h.text(), "say").p50, "350", "llmEndedAt to brain.say");
  assert.equal(row(h.text(), "total").p50, "3000");
});

// @spec CTRL-LAT-004
test("a brain.say with no voice.utterance, and a line still in flight, count for the stages they completed", async () => {
  const h = rig([...line("noutt", { utt: null, playing: [] }), ...line("flight", { playing: [] })]);
  await executeCli(["latency"], h.w);
  assert.equal(row(h.text(), "stt").n, "2");
  assert.equal(row(h.text(), "say").n, "2");
  assert.equal(row(h.text(), "tts").n, "1", "only the line with an utterance");
  assert.equal(row(h.text(), "sink").n, "0");
  assert.equal(row(h.text(), "total").n, "0");
});

// @spec CTRL-LAT-003
test("a brain.say without audioEndedAt, and an injected one, are not samples", async () => {
  const { audioEndedAt: _a, ...noAudio } = FULL;
  const h = rig([
    ...line("chat", { timing: undefined, say: { timing: noAudio } }),
    ...line("inj", { say: { injected: true } }),
    ...line("real"),
  ]);
  await executeCli(["latency"], h.w);
  assert.equal(row(h.text(), "total").n, "1");
});

// @spec CTRL-LAT-003
test("duplicates: the first brain.say per id and the earliest utterance and playing are used, later ones ignored", async () => {
  const h = rig([
    ...line("a", { playing: [[T + 3000, "discord"], [T + 9000, "discord"]] }),
    ev("brain.say", T + 8000, { id: "a", text: "hi", emotion: "happy", timing: FULL }),
    ev("voice.utterance", T + 8500, { id: "a" }),
  ]);
  await executeCli(["latency"], h.w);
  assert.equal(row(h.text(), "total").n, "1");
  assert.equal(row(h.text(), "total").p50, "3000");
  assert.equal(row(h.text(), "tts").p50, "500");
});

// @spec CTRL-LAT-003
test("the real sink wins over virtual even when virtual played first; with only virtual the earliest is used", async () => {
  const both = rig(line("a", { playing: [[T + 2960, "virtual"], [T + 3000, "discord"]] }));
  await executeCli(["latency"], both.w);
  assert.equal(row(both.text(), "total").p50, "3000");
  assert.equal(row(both.text(), "sink").p50, "50");
  const virt = rig(line("b", { playing: [[T + 3100, "virtual"], [T + 2960, "virtual"]] }));
  await executeCli(["latency"], virt.w);
  assert.equal(row(virt.text(), "total").p50, "2960");
});

// @spec CTRL-LAT-005
test("p50 and p95 are nearest-rank over the sorted durations", async () => {
  const events: Ev[] = [];
  for (let i = 1; i <= 20; i++) events.push(...line(`l${i}`, { timing: { heardAt: T + i * 10 } })); // stt = i * 10
  const h = rig(events);
  await executeCli(["latency"], h.w);
  const stt = row(h.text(), "stt");
  assert.deepEqual(stt, { n: "20", p50: "100", p95: "190" }, "rank ceil(.5*20)=10 -> 100, ceil(.95*20)=19 -> 190");
  const one = rig(line("x"));
  await executeCli(["latency"], one.w);
  assert.equal(row(one.text(), "stt").p95, "400");
});

// @spec CTRL-LAT-006
test("absent, fractional, negative and non-numeric stamps drop only the stages that use them", async () => {
  const h = rig([
    ...line("frac", { timing: { heardAt: T + 400.5 } }),
    ...line("neg", { timing: { llmStartedAt: -5 } }),
    ...line("str", { timing: { focusedAt: "x" } }),
    ...line("missing", { timing: { llmEndedAt: undefined } }),
  ]);
  assert.equal(await executeCli(["latency"], h.w), 0);
  const t = h.text();
  assert.equal(row(t, "stt").n, "3", "heardAt bad on one line");
  assert.equal(row(t, "salience").n, "2", "heardAt or focusedAt bad on two");
  assert.equal(row(t, "total").n, "4", "total uses audioEndedAt and playing only");
});

// @spec CTRL-LAT-007
test("a negative duration is left out of the statistics and counted after the stage lines", async () => {
  const bad = rig([...line("a"), ...line("b", { timing: { heardAt: T - 50 } })]);
  await executeCli(["latency"], bad.w);
  assert.deepEqual(row(bad.text(), "stt"), { n: "1", p50: "400", p95: "400" });
  assert.equal(bad.out.length, 11, "header, nine stage rows, the omitted line");
  assert.equal(bad.out[10], "omitted (negative duration): stt 1");
  const two = rig([...line("a"), ...line("b", { timing: { heardAt: T - 50, llmStartedAt: T + 3000 } })]);
  await executeCli(["latency"], two.w);
  assert.equal(two.out[10], "omitted (negative duration): stt 1, llm 1", "stages in report order, separated by comma and space");
  const clean = rig(line("a"));
  await executeCli(["latency"], clean.w);
  assert.doesNotMatch(clean.text(), /omitted|negative|skew/i);
});

// @spec CTRL-LAT-008
test("no samples, including an empty history, prints the message and exits 0", async () => {
  const empty = rig([]);
  assert.equal(await executeCli(["latency", "--count", "7"], empty.w), 0);
  assert.equal(empty.text().trim(), "latency: no speech-path samples in the last 7 events");
  const none = rig(line("x", { timing: { audioEndedAt: undefined } }));
  assert.equal(await executeCli(["latency"], none.w), 0);
  assert.match(none.text(), /no speech-path samples in the last 5000 events/);
});
