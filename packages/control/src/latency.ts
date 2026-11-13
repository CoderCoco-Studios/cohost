import type { BusEvent } from "@cohost/bus";

/** The stages of the speech path in report order (CTRL-LAT-004). */
export const LATENCY_STAGES = ["stt", "salience", "prep", "llm", "critic", "say", "tts", "sink", "total"] as const;
type Stage = (typeof LATENCY_STAGES)[number];

/** A stamp the report trusts: a non-negative integer. Anything else counts as absent (CTRL-LAT-006). */
const stamp = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** The earliest event by envelope `ts`, then by stream order (the array is oldest first). */
function earliest<T extends { ts: number }>(xs: T[]): T | undefined {
  let best: T | undefined;
  for (const x of xs) if (best === undefined || x.ts < best.ts) best = x;
  return best;
}

/** Value at 1-based rank ceil(q * n) of the ascending values. */
const nearestRank = (sorted: number[], q: number): number => sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1]!;

const pad = (stage: string, n: string, p50: string, p95: string): string => stage.padEnd(9) + n.padStart(5) + p50.padStart(8) + p95.padStart(8);

/**
 * The per-stage report over bus history, oldest event first: one sample per spoken-in answer line (a `brain.say`
 * carrying `timing.audioEndedAt`), its stages from the stamps and the joined `voice.utterance` / `voice.playing`.
 */
// @spec CTRL-LAT-003, CTRL-LAT-004, CTRL-LAT-005, CTRL-LAT-006, CTRL-LAT-007, CTRL-LAT-008
export function latencyReport(events: readonly BusEvent[], count: number): string[] {
  const utterances = new Map<string, BusEvent[]>();
  const playing = new Map<string, BusEvent[]>();
  const said = new Map<string, BusEvent<"brain.say">>();
  for (const e of events) {
    if (e.type === "brain.say") {
      const d = (e as BusEvent<"brain.say">).data;
      if (!said.has(d.id)) said.set(d.id, e as BusEvent<"brain.say">);
    } else if (e.type === "voice.utterance" || e.type === "voice.playing") {
      const m = e.type === "voice.utterance" ? utterances : playing;
      const id = (e.data as { id: string }).id;
      m.set(id, [...(m.get(id) ?? []), e]);
    }
  }

  const durations = new Map<Stage, number[]>(LATENCY_STAGES.map((s) => [s, []]));
  const omitted = new Map<Stage, number>();
  let samples = 0;
  for (const [id, say] of said) {
    const t = say.data.timing;
    if (say.data.injected || t?.audioEndedAt === undefined) continue;
    samples++;
    const plays = playing.get(id) ?? [];
    const play = earliest(plays.filter((p) => (p.data as { sink: string }).sink !== "virtual")) ?? earliest(plays);
    const utt = earliest(utterances.get(id) ?? []);
    const audioEnded = stamp(t.audioEndedAt), sayTs = stamp(say.ts);
    const afterLlm = stamp(t.criticEndedAt) ?? stamp(t.llmEndedAt);
    const add = (s: Stage, from: number | undefined, to: number | undefined): void => {
      if (from === undefined || to === undefined) return;
      if (to - from < 0) { omitted.set(s, (omitted.get(s) ?? 0) + 1); return; }
      durations.get(s)!.push(to - from);
    };
    const playTs = play && stamp(play.ts), uttTs = utt && stamp(utt.ts);
    add("stt", audioEnded, stamp(t.heardAt));
    add("salience", stamp(t.heardAt), stamp(t.focusedAt));
    add("prep", stamp(t.focusedAt), stamp(t.llmStartedAt));
    add("llm", stamp(t.llmStartedAt), stamp(t.llmEndedAt));
    if (stamp(t.criticEndedAt) !== undefined) add("critic", stamp(t.llmEndedAt), stamp(t.criticEndedAt));
    add("say", afterLlm, sayTs);
    add("tts", sayTs, uttTs);
    add("sink", uttTs, playTs);
    add("total", audioEnded, playTs);
  }
  if (samples === 0) return [`latency: no speech-path samples in the last ${count} events`];

  const lines = [pad("stage", "n", "p50", "p95")];
  for (const s of LATENCY_STAGES) {
    const sorted = durations.get(s)!.sort((a, b) => a - b);
    lines.push(sorted.length === 0 ? pad(s, "0", "-", "-") : pad(s, String(sorted.length), String(nearestRank(sorted, 0.5)), String(nearestRank(sorted, 0.95))));
  }
  const dropped = LATENCY_STAGES.filter((s) => (omitted.get(s) ?? 0) > 0).map((s) => `${s} ${omitted.get(s)}`);
  if (dropped.length > 0) lines.push(`omitted (negative duration): ${dropped.join(", ")}`);
  return lines;
}
