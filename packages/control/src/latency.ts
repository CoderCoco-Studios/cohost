import type { BusEvent } from "@cohost/bus";

/** The speech-path stage rows in report order (CTRL-LAT-004, CTRL-LAT-024). `think` is printed after `total` and is not summed. */
// @spec CTRL-LAT-024
const SPEECH_STAGES = ["endpoint", "stt", "salience", "prep", "llm", "tool", "critic", "say", "tts", "sink", "total", "think"] as const;
/** The vision-path stage rows, as CTRL-LAT-012 names them: no `tool` or `think` row, so its `llm` keeps any tool wait (CTRL-LAT-013). */
const VISION_STAGES = ["describe", "salience", "prep", "llm", "critic", "say", "tts", "sink", "total"] as const;

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

type Path = "speech" | "vision";
type Timing = NonNullable<BusEvent<"brain.say">["data"]["timing"]>;
type Sample = { say: BusEvent<"brain.say">; play?: BusEvent; utt?: BusEvent };
/** Records one stage duration; `undefined` from either stamp skips it, a negative one is counted as omitted. */
type Put = (stage: string, value: number | undefined) => void;

/** The path a `brain.say` belongs to: `audioEndedAt` makes it speech, else `capturedAt` makes it vision (CTRL-LAT-003, CTRL-LAT-011). */
function pathOf(say: BusEvent<"brain.say">): Path | undefined {
  const t = say.data.timing;
  if (!t) return undefined;
  if (t.audioEndedAt !== undefined) return "speech";
  return t.capturedAt !== undefined ? "vision" : undefined;
}

/** `to - from` when both stamps are present (CTRL-LAT-006). */
const span = (from: number | undefined, to: number | undefined): number | undefined => (from === undefined || to === undefined ? undefined : to - from);

/**
 * The stage durations of one sample (CTRL-LAT-004, CTRL-LAT-012, CTRL-LAT-018 to CTRL-LAT-023). A prepared reply (one that
 * carries `confirmedAt`) is cut by a single clamp: every boundary from the start of `prep` through the start of `say` is
 * raised to `confirmedAt`, so the stages telescope to `total`. `think` is `focusedAt` to `heldAt`, outside the sum.
 */
// @spec CTRL-LAT-004, CTRL-LAT-012, CTRL-LAT-018, CTRL-LAT-019, CTRL-LAT-020, CTRL-LAT-021, CTRL-LAT-022, CTRL-LAT-023, CTRL-LAT-032, CTRL-LAT-033
function stagesOf({ say, play, utt }: Sample, path: Path, put: Put): void {
  const t = say.data.timing as Timing;
  const sayTs = stamp(say.ts), playTs = play && stamp(play.ts), uttTs = utt && stamp(utt.ts);
  const confirmed = stamp(t.confirmedAt);
  const cut = (v: number | undefined): number | undefined => (v === undefined || confirmed === undefined ? v : Math.max(v, confirmed));

  const focused = stamp(t.focusedAt);
  const llmStartRaw = stamp(t.llmStartedAt), llmEndRaw = stamp(t.llmEndedAt), criticEndRaw = stamp(t.criticEndedAt);
  const toolStartRaw = stamp(t.toolStartedAt), toolEndRaw = stamp(t.toolEndedAt);
  // A tool wait is its own row only on the speech path, when both stamps are present and it ends by llmEndedAt (CTRL-LAT-004).
  const hasTool = path === "speech" && toolStartRaw !== undefined && toolEndRaw !== undefined && llmEndRaw !== undefined && toolEndRaw <= llmEndRaw;
  const llmStart = cut(llmStartRaw), llmEnd = cut(llmEndRaw), toolStart = cut(toolStartRaw), toolEnd = cut(toolEndRaw);
  const criticEnd = cut(criticEndRaw);
  const sayStart = cut(criticEndRaw ?? llmEndRaw);

  if (path === "speech") {
    const audioEnded = stamp(t.audioEndedAt), closed = stamp(t.closedAt), heard = stamp(t.heardAt);
    put("endpoint", closed === undefined ? undefined : span(audioEnded, closed));
    put("stt", span(closed ?? audioEnded, heard));
    put("salience", span(heard, confirmed ?? focused));
  } else {
    put("describe", span(stamp(t.capturedAt), stamp(t.describedAt)));
    put("salience", span(stamp(t.describedAt), confirmed ?? focused));
  }
  // A prepared reply's prep starts at its confirmation, the end of salience (CTRL-LAT-021).
  put("prep", span(confirmed ?? focused, llmStart));
  if (hasTool) {
    put("tool", span(toolStart, toolEnd));
    const before = span(llmStart, toolStart), after = span(toolEnd, llmEnd);
    put("llm", before === undefined || after === undefined ? undefined : before + after);
  } else {
    put("llm", span(llmStart, llmEnd));
  }
  if (criticEndRaw !== undefined) put("critic", span(llmEnd, criticEnd));
  put("say", span(sayStart, sayTs));
  put("tts", span(sayTs, uttTs));
  put("sink", span(uttTs, playTs));
  put("total", span(path === "speech" ? stamp(t.audioEndedAt) : stamp(t.capturedAt), playTs));
  if (path === "speech") put("think", span(focused, stamp(t.heldAt)));
}

/** One path's table, with the negative-duration line, or its no-sample line. */
function section(samples: Sample[], path: Path, count: number): string[] {
  if (samples.length === 0) return [`latency: no ${path}-path samples in the last ${count} events`];
  const stages: readonly string[] = path === "speech" ? SPEECH_STAGES : VISION_STAGES;
  const durations = new Map<string, number[]>(stages.map((s) => [s, []]));
  const omitted = new Map<string, number>();
  for (const sample of samples) {
    stagesOf(sample, path, (s, value) => {
      if (value === undefined) return;
      if (value < 0) { omitted.set(s, (omitted.get(s) ?? 0) + 1); return; }
      durations.get(s)!.push(value);
    });
  }
  const lines = [pad("stage", "n", "p50", "p95")];
  for (const s of stages) {
    const sorted = durations.get(s)!.sort((a, b) => a - b);
    lines.push(sorted.length === 0 ? pad(s, "0", "-", "-") : pad(s, String(sorted.length), String(nearestRank(sorted, 0.5)), String(nearestRank(sorted, 0.95))));
  }
  const dropped = stages.filter((s) => (omitted.get(s) ?? 0) > 0).map((s) => `${s} ${omitted.get(s)}`);
  if (dropped.length > 0) lines.push(`omitted (negative duration): ${dropped.join(", ")}`);
  return lines;
}

/**
 * The early-reply lines of the speech section (CTRL-LAT-025 to CTRL-LAT-028): the six counts, each event once (keys in
 * CTRL-LAT-026), the `early transcripts` line, and the `early stt` row over the distinct `speech.early` events' `sttMs`.
 * Both are absent when there is no early event and every count is zero.
 */
// @spec CTRL-LAT-025, CTRL-LAT-026, CTRL-LAT-027, CTRL-LAT-028
function earlyLines(events: readonly BusEvent[]): string[] {
  const early = new Map<string, unknown>(); // `utteranceId#seq` -> sttMs of the first such event
  const retracted = new Set<string>(), reused = new Set<string>(), released = new Set<string>(), interjected = new Set<string>(), late = new Set<string>();
  for (const e of events) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "speech.early") {
      const key = `${d.utteranceId}#${d.seq}`;
      if (!early.has(key)) early.set(key, d.sttMs);
    } else if (e.type === "speech.retracted") {
      retracted.add(`${d.utteranceId}#${d.seq}`);
    } else if (e.type === "speech.heard") {
      // Keyed by utteranceId, or by the envelope id when the event carries none (CTRL-LAT-026).
      const key = String(d.utteranceId ?? e.id);
      if (d.earlySeq !== undefined && d.earlySeq !== null) reused.add(key);
      if (d.earlyLate === true) late.add(key);
    } else if (e.type === "brain.say") {
      // An injected line counts in neither `b` nor `i`; an interjected one counts in `i` only (CTRL-LAT-026).
      if (d.injected === true) continue;
      if (d.interjected === true) interjected.add(String(d.id));
      else if ((d.timing as { confirmedAt?: unknown } | undefined)?.confirmedAt !== undefined) released.add(String(d.id));
    }
  }
  const counts = [early.size, retracted.size, reused.size, released.size, interjected.size, late.size];
  if (counts.every((n) => n === 0)) return [];
  const [p, w, r, b, i, l] = counts;
  const lines = [`early transcripts: ${p} published, ${w} retracted, ${r} reused as the final, ${b} replies released from a prepared think, ${i} interjections spoken, ${l} still running at the close`];
  if (early.size > 0) {
    const sorted = [...early.values()].filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
    lines.push(sorted.length === 0
      ? pad("early stt", String(early.size), "-", "-")
      : pad("early stt", String(early.size), String(nearestRank(sorted, 0.5)), String(nearestRank(sorted, 0.95))));
  }
  return lines;
}

/**
 * The per-stage report over bus history, oldest event first, as a `speech path` and a `vision path` section: one sample
 * per answer line (a `brain.say`), its stages from the stamps and the joined `voice.utterance` / `voice.playing`.
 */
// @spec CTRL-LAT-003, CTRL-LAT-004, CTRL-LAT-005, CTRL-LAT-006, CTRL-LAT-007, CTRL-LAT-008, CTRL-LAT-024, CTRL-LAT-029
// @spec CTRL-LAT-011, CTRL-LAT-012, CTRL-LAT-013, CTRL-LAT-014, CTRL-LAT-015, CTRL-LAT-016
export function latencyReport(events: readonly BusEvent[], count: number): string[] {
  const utterances = new Map<string, BusEvent[]>();
  const playing = new Map<string, BusEvent[]>();
  const said = new Map<string, BusEvent<"brain.say">[]>();
  for (const e of events) {
    if (e.type === "brain.say") {
      const say = e as BusEvent<"brain.say">;
      // An injected line (a dashboard test) and an interjected one (it answers a pause, not the end of speech) are no sample (CTRL-LAT-029).
      if (say.data.injected || say.data.interjected) continue;
      said.set(say.data.id, [...(said.get(say.data.id) ?? []), say]);
    } else if (e.type === "voice.utterance" || e.type === "voice.playing") {
      // A streamed line is one sample measured on clause 0; later clauses' events are ignored (CTRL-LAT-015).
      if ((e.data as { seq: number }).seq !== 0) continue;
      const m = e.type === "voice.utterance" ? utterances : playing;
      const id = (e.data as { id: string }).id;
      m.set(id, [...(m.get(id) ?? []), e]);
    }
  }

  // One sample per id: the first speech-path `brain.say` of the id, else its first vision-path one (CTRL-LAT-003, CTRL-LAT-011).
  const byPath: Record<Path, Sample[]> = { speech: [], vision: [] };
  for (const [id, says] of said) {
    const speech = says.find((s) => pathOf(s) === "speech");
    const path: Path | undefined = speech ? "speech" : says.some((s) => pathOf(s) === "vision") ? "vision" : undefined;
    if (!path) continue;
    const say = speech ?? says.find((s) => pathOf(s) === "vision")!;
    const plays = playing.get(id) ?? [];
    byPath[path].push({
      say,
      play: earliest(plays.filter((p) => (p.data as { sink: string }).sink !== "virtual")) ?? earliest(plays),
      utt: earliest(utterances.get(id) ?? []),
    });
  }
  const speech = section(byPath.speech, "speech", count);
  return ["speech path", ...speech, ...earlyLines(events), "", "vision path", ...section(byPath.vision, "vision", count)];
}
