import { test } from "node:test";
import assert from "node:assert/strict";
import { latencyReport } from "../src/latency.js";
import type { BusEvent } from "@cohost/bus";

interface Ev { id: string; type: string; ts: number; source: string; data: Record<string, unknown> }
let n = 0;
const ev = (type: string, ts: number, data: Record<string, unknown>): Ev => ({ id: `${ts}-${n++}`, type, ts, source: "t", data });
const report = (events: Ev[]): string[] => latencyReport(events as unknown as BusEvent[], 5000);

const T = 1_000_000;
interface Spec {
  id?: string;
  timing: Record<string, unknown>;
  sayTs: number;
  uttTs: number;
  playTs: number;
  say?: Record<string, unknown>;
}
/** One speech line from explicit stamps and joined-event times. */
function sample(s: Spec): Ev[] {
  const id = s.id ?? "a";
  return [
    ev("brain.say", s.sayTs, { id, text: "hi", emotion: "happy", timing: { audioEndedAt: T, ...s.timing }, ...s.say }),
    ev("voice.utterance", s.uttTs, { id, seq: 0 }),
    ev("voice.playing", s.playTs, { id, seq: 0, sink: "discord" }),
  ];
}
/** Mark every brain.say of the events with extra data members. */
const withSay = (events: Ev[], extra: Record<string, unknown>): Ev[] =>
  events.map((e) => (e.type === "brain.say" ? { ...e, data: { ...e.data, ...extra } } : e));
/** The speech-path rows: after the `speech path` title, up to the blank line. */
function speechRows(lines: string[]): string[] {
  assert.equal(lines[0], "speech path");
  const end = lines.indexOf("");
  return lines.slice(1, end);
}
function row(lines: string[], stage: string): { n: string; p50: string; p95: string; at: number } {
  const rows = speechRows(lines);
  const at = rows.findIndex((l) => l.slice(0, 9).trim() === stage);
  assert.ok(at >= 0, `no row for ${stage} in:\n${rows.join("\n")}`);
  const m = /^.{9}\s*(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(rows[at]!);
  assert.ok(m, `bad row ${rows[at]}`);
  return { n: m[1]!, p50: m[2]!, p95: m[3]!, at };
}
const p50 = (lines: string[], stage: string): number => Number(row(lines, stage).p50);
const SUM_STAGES = ["endpoint", "stt", "salience", "prep", "llm", "tool", "critic", "say", "tts", "sink"];
const sumOf = (lines: string[]): number => SUM_STAGES.reduce((a, s) => a + (row(lines, s).n === "0" ? 0 : p50(lines, s)), 0);
const earlyLine = (lines: string[]): string | undefined => speechRows(lines).find((l) => l.startsWith("early transcripts:"));

// An ordinary connector sample: endpoint 300, stt 100, salience 600, prep 100, llm 1000, critic 300, say 50, tts 500, sink 50 = 3000.
const ORDINARY = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 1000, llmStartedAt: T + 1100, llmEndedAt: T + 2100, criticEndedAt: T + 2400 };
const ordinary = (extra: Record<string, unknown> = {}, id = "a"): Ev[] =>
  sample({ id, timing: { ...ORDINARY, ...extra }, sayTs: T + 2450, uttTs: T + 2950, playTs: T + 3000 });

// @spec CTRL-LAT-003, CTRL-LAT-005, CTRL-LAT-018, CTRL-LAT-019, CTRL-LAT-022, CTRL-LAT-032
test("an ordinary connector sample: endpoint then stt first, stt from closedAt, stages sum to total", () => {
  const out = report(ordinary());
  const names = speechRows(out).slice(1).map((l) => l.slice(0, 9).trim());
  assert.deepEqual(names.slice(0, 3), ["endpoint", "stt", "salience"]);
  assert.equal(p50(out, "endpoint"), 300);
  assert.equal(p50(out, "stt"), 100);
  assert.equal(p50(out, "total"), 3000);
  assert.equal(sumOf(out), 3000);
});

// @spec CTRL-LAT-019, CTRL-LAT-033
test("without closedAt there is no endpoint value and stt runs from audioEndedAt", () => {
  const out = report(sample({ timing: { ...ORDINARY, closedAt: undefined }, sayTs: T + 2450, uttTs: T + 2950, playTs: T + 3000 }));
  assert.equal(row(out, "endpoint").n, "0");
  assert.equal(row(out, "endpoint").p50, "-");
  assert.equal(p50(out, "stt"), 400);
  assert.equal(sumOf(out), 3000);
});

// @spec CTRL-LAT-004, CTRL-LAT-022
test("an ordinary sample with a tool wait: llm excludes tool and every stage sums to total", () => {
  const out = report(ordinary({ toolStartedAt: T + 1300, toolEndedAt: T + 1800 }));
  assert.equal(p50(out, "tool"), 500);
  assert.equal(p50(out, "llm"), 500);
  assert.equal(sumOf(out), 3000);
});

// @spec CTRL-LAT-020, CTRL-LAT-021, CTRL-LAT-022, CTRL-LAT-032
test("a prepared reply whose think finished before the confirm: salience to confirmedAt, later stages zero, sum holds", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, llmEndedAt: T + 800, criticEndedAt: T + 900, heldAt: T + 850, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1050, uttTs: T + 1550, playTs: T + 1600 }));
  assert.equal(p50(out, "endpoint"), 300, "endpoint is computed for a prepared reply too");
  assert.equal(p50(out, "stt"), 100);
  assert.equal(p50(out, "salience"), 600);
  assert.equal(p50(out, "prep"), 0);
  assert.equal(p50(out, "llm"), 0);
  assert.equal(p50(out, "critic"), 0);
  assert.equal(p50(out, "say"), 50);
  assert.equal(p50(out, "total"), 1600);
  assert.equal(sumOf(out), 1600);
});

// @spec CTRL-LAT-021, CTRL-LAT-022
test("a prepared reply whose think runs across the confirm counts only the remainder of llm and critic", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, llmEndedAt: T + 1400, criticEndedAt: T + 1600, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1650, uttTs: T + 2150, playTs: T + 2200 }));
  assert.equal(p50(out, "salience"), 600);
  assert.equal(p50(out, "prep"), 0);
  assert.equal(p50(out, "llm"), 400);
  assert.equal(p50(out, "critic"), 200);
  assert.equal(p50(out, "say"), 50);
  assert.equal(sumOf(out), 2200);
});

// @spec CTRL-LAT-021, CTRL-LAT-022
test("a prepared reply with no critic stamp starts say at the later of llmEndedAt and confirmedAt", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, llmEndedAt: T + 1500, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1550, uttTs: T + 2050, playTs: T + 2100 }));
  assert.equal(row(out, "critic").n, "0");
  assert.equal(p50(out, "llm"), 500);
  assert.equal(p50(out, "say"), 50);
  assert.equal(sumOf(out), 2100);
});

// @spec CTRL-LAT-021, CTRL-LAT-022
test("a prepared reply with a tool wait: raised boundaries give tool its remainder and llm the rest, sum holds", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, toolStartedAt: T + 500, toolEndedAt: T + 1200, llmEndedAt: T + 1500, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1550, uttTs: T + 2050, playTs: T + 2100 }));
  assert.equal(p50(out, "prep"), 0);
  assert.equal(p50(out, "tool"), 200);
  assert.equal(p50(out, "llm"), 300);
  assert.equal(sumOf(out), 2100);
});

// @spec CTRL-LAT-021, CTRL-LAT-022
test("a prepared reply whose tool wait ended before the confirm has a zero tool stage and the sum holds", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, toolStartedAt: T + 300, toolEndedAt: T + 700, llmEndedAt: T + 1200, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1250, uttTs: T + 1750, playTs: T + 1800 }));
  assert.equal(p50(out, "tool"), 0);
  assert.equal(p50(out, "llm"), 200);
  assert.equal(sumOf(out), 1800);
});

// @spec CTRL-LAT-023, CTRL-LAT-024
test("think is focusedAt to heldAt, printed after total and outside the sum; no heldAt means no think value", () => {
  const timing = { closedAt: T + 300, heardAt: T + 400, focusedAt: T + 100, llmStartedAt: T + 150, llmEndedAt: T + 800, criticEndedAt: T + 900, heldAt: T + 850, confirmedAt: T + 1000 };
  const out = report(sample({ timing, sayTs: T + 1050, uttTs: T + 1550, playTs: T + 1600 }));
  assert.equal(p50(out, "think"), 750);
  assert.ok(row(out, "think").at > row(out, "total").at, "think prints after total");
  assert.equal(sumOf(out), 1600, "think is not part of the sum");
  const without = report(sample({ timing: { ...timing, heldAt: undefined }, sayTs: T + 1050, uttTs: T + 1550, playTs: T + 1600 }));
  assert.equal(row(without, "think").n, "0");
  assert.equal(row(without, "think").p50, "-");
  assert.equal(row(report(ordinary()), "think").n, "0");
});

// @spec CTRL-LAT-004, CTRL-LAT-005, CTRL-LAT-024
test("the printed layout is 9/5/8/8 with the rows in order and think after total", () => {
  const rows = speechRows(report(ordinary()));
  assert.match(rows[0]!, /^stage\s+n\s+p50\s+p95$/);
  assert.deepEqual(
    rows.slice(1, 13).map((l) => l.slice(0, 9).trim()),
    ["endpoint", "stt", "salience", "prep", "llm", "tool", "critic", "say", "tts", "sink", "total", "think"],
  );
  assert.equal(rows[1], "endpoint".padEnd(9) + "1".padStart(5) + "300".padStart(8) + "300".padStart(8));
});

// @spec CTRL-LAT-029, CTRL-LAT-003
test("an interjected brain.say is not a sample, and an injected one is not either", () => {
  const out = report([...withSay(ordinary({}, "i1"), { interjected: true }), ...ordinary({}, "ok")]);
  assert.equal(row(out, "total").n, "1");
  const inj = report(withSay(ordinary({}, "x"), { injected: true }));
  assert.equal(inj[1], "latency: no speech-path samples in the last 5000 events");
});

// @spec CTRL-LAT-003
test("the sample is the first brain.say of an id that carries audioEndedAt, even after an earlier one that does not", () => {
  const events = [ev("brain.say", T + 100, { id: "d", text: "x", emotion: "happy", timing: { capturedAt: T } }), ...ordinary({}, "d")];
  const out = report(events);
  assert.equal(row(out, "total").n, "1");
  assert.equal(p50(out, "total"), 3000);
});

// @spec CTRL-LAT-025, CTRL-LAT-026
test("the early transcripts line carries six counts, each event counted once", () => {
  const early = (utteranceId: string, seq: number): Ev => ev("speech.early", T + seq, { speaker: "s", source: "perf", text: "t", utteranceId, seq, sttMs: 100 });
  const heard = (extra: Record<string, unknown>): Ev => ev("speech.heard", T + 5, { speaker: "s", text: "t", ...extra });
  const events: Ev[] = [
    early("u1", 0), early("u1", 0), early("u1", 1), early("u2", 0), // p: 3 distinct (utteranceId, seq)
    ev("speech.retracted", T + 10, { speaker: "s", source: "perf", utteranceId: "u1", seq: 0 }), // w: 1
    heard({ utteranceId: "u1", earlySeq: 1 }), heard({ utteranceId: "u3", earlySeq: 0 }), // r: 2
    heard({ utteranceId: "u4", earlyLate: true }), // l: 1
    ...ordinary({ confirmedAt: T + 2400 }, "b1"), ...ordinary({ confirmedAt: T + 2400 }, "b1"), // b: 1 (each id once)
    ...withSay(ordinary({}, "i1"), { interjected: true }), ...withSay(ordinary({}, "i1"), { interjected: true }), // i: 1
  ];
  assert.equal(
    earlyLine(report(events)),
    "early transcripts: 3 published, 1 retracted, 2 reused as the final, 1 replies released from a prepared think, 1 interjections spoken, 1 still running at the close",
  );
});

// @spec CTRL-LAT-025
test("any one early member prints the line, after the omitted-durations line when there is one", () => {
  const neg = ordinary({ closedAt: T + 500 }); // closedAt after heardAt: stt negative, omitted
  const events = [...neg, ev("speech.retracted", T + 10, { speaker: "s", source: "perf", utteranceId: "u", seq: 0 })];
  const rows = speechRows(report(events));
  const omitted = rows.findIndex((l) => l.startsWith("omitted (negative duration):"));
  const line = rows.findIndex((l) => l.startsWith("early transcripts:"));
  assert.ok(omitted >= 0 && line > omitted, rows.join("\n"));
  assert.match(rows[line]!, /^early transcripts: 0 published, 1 retracted, 0 reused/);
});

// @spec CTRL-LAT-027
test("with all six counts zero there is no early transcripts line and no early stt row", () => {
  const out = report(ordinary());
  assert.equal(earlyLine(out), undefined);
  assert.ok(!speechRows(out).some((l) => l.startsWith("early stt")));
});

// @spec CTRL-LAT-028
test("early stt row follows the early line and holds count, p50 and p95 of sttMs", () => {
  const events: Ev[] = [100, 200, 300, 400].map((sttMs, i) => ev("speech.early", T + i, { speaker: "s", source: "perf", text: "t", utteranceId: `u${i}`, seq: 0, sttMs }));
  const rows = speechRows(report([...ordinary(), ...events]));
  const line = rows.findIndex((l) => l.startsWith("early transcripts:"));
  assert.ok(line >= 0);
  assert.equal(rows[line + 1], "early stt".padEnd(9) + "4".padStart(5) + "200".padStart(8) + "400".padStart(8));
});

// @spec CTRL-LAT-028
test("no speech.early means no early stt row even when other early members print the line", () => {
  const out = report([...ordinary(), ev("speech.retracted", T + 1, { speaker: "s", source: "perf", utteranceId: "u", seq: 0 })]);
  assert.ok(earlyLine(out));
  assert.ok(!speechRows(out).some((l) => l.startsWith("early stt")));
});
