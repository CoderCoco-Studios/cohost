import type { BusEvent } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { Module, type ModuleImpl } from "@cohost/modules";
import { notesHookConfig, notesHookLlm } from "./consolidator.js";
import {
  MAX_NOTE_HINT, MAX_NOTE_TEXT, cosine, isCategory, mentionsForbiddenTopic, type Category, type DeletionRow, type NoteRow,
} from "./notes.js";
import type { MemoryBackend } from "./store.js";

/** What the capture hook sees for one chat line: the viewer, the line, what is already noted, and why the owner deleted notes before. */
export interface CaptureInput {
  /** The viewer's display name. */
  viewer: string;
  line: string;
  /** Texts of the viewer's current notes, so the model avoids duplicates. */
  notes: string[];
  /** Reasons the owner gave for deleting this viewer's notes (learned refusals). */
  suppressionReasons: string[];
}

export interface CaptureNote { category: Category; text: string; hint?: string }
/** `note: null` is the answer "nothing worth noting", and what the rules fallback says. */
export interface CaptureOutput { note: CaptureNote | null }

/** The part of a region-hooks `Module` the writer uses. */
export interface CaptureHook {
  readonly kind: "rules" | "llm" | "http";
  run(input: CaptureInput): Promise<CaptureOutput>;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// @spec MEM-CAPTURE-004, MEM-NOTE-009
/**
 * `{note: null}` or `{note: {category, text, hint?}}` with a category that exists, a non-empty text of at most 120 characters
 * and a hint of at most 80, neither about politics, money or subscriber status; anything else is undefined, so the hook falls
 * back to rules and no note is stored.
 */
export function validateCapture(raw: unknown): CaptureOutput | undefined {
  if (!isObj(raw) || !("note" in raw)) return undefined;
  const n = raw.note;
  if (n === null) return { note: null };
  if (!isObj(n) || !isCategory(n.category) || typeof n.text !== "string") return undefined;
  const text = n.text.trim();
  if (text.length === 0 || text.length > MAX_NOTE_TEXT) return undefined;
  let hint: string | undefined;
  if (n.hint !== undefined) {
    if (typeof n.hint !== "string" || n.hint.trim().length > MAX_NOTE_HINT) return undefined;
    hint = n.hint.trim() || undefined;
  }
  if (mentionsForbiddenTopic(text) || (hint !== undefined && mentionsForbiddenTopic(hint))) return undefined;
  return { note: { category: n.category, text, ...(hint !== undefined ? { hint } : {}) } };
}

const SYSTEM = `You keep a streamer's AI co-host's private notes about the viewers in chat. You read one chat line and decide whether it reveals something worth remembering about that viewer: what they are doing or playing lately, something they got or finished, who they are as a person (job, hobbies, pets, where they live), or a hard time in their life.
Most lines are NOT worth a note (greetings, reactions, jokes, questions, spam): answer {"note":null}.
Rules:
- A note is ONE short sentence about the viewer, under ${MAX_NOTE_TEXT} characters, in plain words. Do not quote the line, do not invent facts.
- category: "general" for most things; "health" for illness, injury or mental health; "family" for family events such as a death, a birth, a breakup or a divorce. For health and family add a short "hint" (under ${MAX_NOTE_HINT} characters) telling the co-host how to behave, for example "check in gently, don't quote it". Never put sensitive detail in the text itself.
- NEVER note the viewer's political views or politics at all: answer {"note":null}.
- NEVER note money: income, wealth, prices paid, donations, spending, or whether someone is a subscriber: answer {"note":null}.
- If the viewer already has a note saying the same thing, repeat that note's exact text so it is reinforced instead of duplicated.
- If the owner gave reasons for deleting earlier notes, answer {"note":null} for lines that raise the same things.
Answer with one JSON object: {"note":null} or {"note":{"category":"general","text":"...","hint":"..."}} (hint only when needed).`;

// @spec MEM-CAPTURE-003, MEM-CAPTURE-004
export const captureImpl: ModuleImpl<CaptureInput, CaptureOutput> = {
  rules: () => ({ note: null }),
  llm: {
    system: SYSTEM,
    maxTokens: 150,
    user: (input) => [
      `Viewer: ${input.viewer}`,
      `Chat line: ${input.line}`,
      ...(input.notes.length ? ["Notes already kept about this viewer:", ...input.notes.map((t) => `- ${t}`)] : []),
      ...(input.suppressionReasons.length ? ["The owner deleted earlier notes for these reasons:", ...input.suppressionReasons.map((r) => `- ${r}`)] : []),
    ].join("\n"),
    validate: (raw) => validateCapture(raw),
  },
  http: { validate: (raw) => validateCapture(raw) },
};

// @spec MEM-CAPTURE-003, MEM-NOTE-011, MEM-NOTE-012
/** `memory.capture`: its own model slot, configured by `brain.memory.notes.capture` (never the cortex's), on local ollama unless the hook names a provider. */
export function createCaptureHook(cfg: Config, log: Logger): Module<CaptureInput, CaptureOutput> {
  const hook = notesHookConfig(cfg.llm, cfg.brain.memory.notes.capture);
  return new Module("memory.capture", hook, notesHookLlm(cfg.llm, hook), captureImpl, log);
}

// @spec MEM-CAPTURE-008
/** Lower-cased, whitespace collapsed, trailing punctuation removed: the form two notes are compared in. */
export function normaliseNoteText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s.!?,;:…]+$/u, "");
}

export interface CaptureDeps {
  cfg: Config["brain"]["memory"];
  store: Pick<MemoryBackend, "getViewer" | "ensureViewer" | "touchSpeaker" | "embedText" | "listNotes" | "listDeletions" | "insertNote" | "reinforceNote">;
  hook: CaptureHook;
  log: Logger;
  /** Called after a note was inserted or reinforced: lets the consolidation scheduler count dirty notes (MEM-CONSOL-001). */
  onNotesWritten?: () => Promise<void>;
}

// @spec MEM-CAPTURE-002
/** An injected line is captured only when the operator marked it `remember`, as for every other memory write (MEM-INJ-001). */
const skipInjected = (d: { injected?: boolean; remember?: boolean }): boolean => d.injected === true && d.remember !== true;

/**
 * The `memory-notes` consumer group's handler: classify each chat line with the capture hook and write the note it proposes.
 * Every failure is logged and costs only that line's note (MEM-CAPTURE-010).
 */
// @spec MEM-CAPTURE-001, MEM-CAPTURE-002, MEM-CAPTURE-010, MEM-VOICE-003
export function createCaptureHandler(deps: CaptureDeps): (ev: BusEvent) => Promise<void> {
  const { cfg, hook, log } = deps;
  return async (ev) => {
    let who: string, text: string;
    let speakerId: string | undefined;
    let key: string | undefined;
    if (ev.type === "chat.message") {
      const d = ev.data as BusEvent<"chat.message">["data"];
      if (skipInjected(d)) return;
      who = d.user;
      text = d.text;
      key = (d.userId ?? d.user).toLowerCase();
    } else if (ev.type === "speech.heard") {
      // @spec MEM-VOICE-003
      const d = ev.data as BusEvent<"speech.heard">["data"];
      if (skipInjected(d) || !d.speakerId) return; // no Discord id, no identity to keep notes under
      who = d.speaker;
      text = d.text;
      speakerId = d.speakerId;
    } else return;
    const line = text.trim();
    if (line.length < cfg.notes.capture_min_chars) return;
    if (hook.kind === "rules") return; // the rules fallback writes no note, so skip the reads
    try {
      if (speakerId !== undefined) {
        const row = await deps.store.touchSpeaker(speakerId, who); // the linked chat viewer, or the voice viewer
        key = row.key;
        who = row.display;
      }
      if (await captureLine(deps, key!, who, line)) {
        await deps.onNotesWritten?.().catch((err) => log.warn({ err: String(err) }, "could not tell the consolidation scheduler about new notes"));
      }
    } catch (err) {
      log.warn({ err: String(err), user: who }, "note capture failed; no note stored for this line");
    }
  };
}

// @spec MEM-CAPTURE-004 through MEM-CAPTURE-009, MEM-CAPTURE-011
/** Returns true when a note was inserted or reinforced. `key` is the viewer's row key (a chat key, or a voice speaker's resolved key); `display` is what the hook is told. */
async function captureLine({ cfg, store, hook }: CaptureDeps, key: string, display: string, line: string): Promise<boolean> {
  const known = await store.getViewer(key);
  const notes: NoteRow[] = known ? await store.listNotes(key) : [];
  const deletions: DeletionRow[] = known ? await store.listDeletions(key) : [];
  const reasoned = deletions.filter((x) => x.reason !== null);
  const out = await hook.run({
    viewer: display,
    line,
    notes: notes.map((n) => n.text),
    suppressionReasons: reasoned.map((x) => x.reason!),
  });
  const note = out.note;
  if (!note) return false;

  const embedding = await store.embedText(note.text); // MEM-CAPTURE-005
  const similar = (rows: DeletionRow[]) => rows.some((x) => cosine(embedding, x.embedding) >= cfg.notes.suppress_similarity);
  if (similar(reasoned)) return false; // MEM-CAPTURE-006: the owner told us not to keep this
  const wanted = normaliseNoteText(note.text);
  const duplicate = notes.find((n) => normaliseNoteText(n.text) === wanted);
  if (duplicate) { // MEM-CAPTURE-008
    return (await store.reinforceNote(duplicate.id)) !== undefined;
  }
  const returning = similar(deletions.filter((x) => x.reason === null)); // MEM-CAPTURE-007
  await store.ensureViewer(key, display); // MEM-CAPTURE-011
  await store.insertNote({
    userKey: key, category: note.category, text: note.text, hint: note.hint, embedding,
    strength: returning ? cfg.notes.returning_strength : 1, mentions: 1, dirty: true, // MEM-CAPTURE-007, MEM-CAPTURE-009
  });
  return true;
}
