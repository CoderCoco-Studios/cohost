import type { Config, Logger } from "@cohost/config";
import { Module, type ModuleConfig, type ModuleImpl } from "@cohost/modules";
import { MAX_NOTE_HINT, MAX_NOTE_TEXT, isCategory, mentionsForbiddenTopic, type Category, type Layer } from "./notes.js";

/** The note a consolidator hook sees: only what it needs to judge, no embeddings. */
export interface ConsolidatorNote {
  id: number;
  layer: Layer;
  category: Category;
  text: string;
  hint: string | null;
  /** Effective strength now. */
  strength: number;
  mentions: number;
}

export interface ConsolidatorInput {
  /** The viewer's display name. */
  viewer: string;
  notes: ConsolidatorNote[];
  /** Reasons the owner gave for deleting this viewer's notes. */
  suppressionReasons: string[];
}

export type ConsolidatorOp =
  | { op: "merge"; ids: number[]; text: string; category?: Category; hint?: string }
  | { op: "rewrite"; id: number; text?: string; category?: Category; hint?: string }
  | { op: "drop"; id: number };

export interface ConsolidatorOutput { ops: ConsolidatorOp[] }

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const okText = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && x.trim().length <= MAX_NOTE_TEXT;
const okHint = (x: unknown): x is string => typeof x === "string" && x.trim().length <= MAX_NOTE_HINT;

// @spec MEM-CONSOL-005
/** One operation if it is well formed and names only `ids`, with a category that exists and text and hint within bounds; otherwise undefined. */
export function validateOp(raw: unknown, ids: ReadonlySet<number>): ConsolidatorOp | undefined {
  if (!isObj(raw)) return undefined;
  const known = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && ids.has(x);
  if (raw.category !== undefined && !isCategory(raw.category)) return undefined;
  if (raw.hint !== undefined && !okHint(raw.hint)) return undefined;
  // @spec MEM-NOTE-009
  if (typeof raw.text === "string" && mentionsForbiddenTopic(raw.text)) return undefined;
  if (typeof raw.hint === "string" && mentionsForbiddenTopic(raw.hint)) return undefined;
  const extras = {
    ...(raw.category !== undefined ? { category: raw.category as Category } : {}),
    ...(typeof raw.hint === "string" ? { hint: raw.hint.trim() } : {}),
  };
  switch (raw.op) {
    case "drop":
      return known(raw.id) ? { op: "drop", id: raw.id } : undefined;
    case "rewrite": {
      if (!known(raw.id)) return undefined;
      if (raw.text !== undefined && !okText(raw.text)) return undefined;
      if (raw.text === undefined && raw.category === undefined && raw.hint === undefined) return undefined;
      return { op: "rewrite", id: raw.id, ...(raw.text !== undefined ? { text: (raw.text as string).trim() } : {}), ...extras };
    }
    case "merge": {
      if (!Array.isArray(raw.ids) || raw.ids.length < 2 || !raw.ids.every(known) || new Set(raw.ids).size !== raw.ids.length) return undefined;
      if (!okText(raw.text)) return undefined;
      return { op: "merge", ids: raw.ids as number[], text: raw.text.trim(), ...extras };
    }
    default:
      return undefined;
  }
}

/** The valid operations of a model answer (`{ops: [...]}` or a bare array); undefined when the answer has no list at all. */
export function validateOps(raw: unknown, ids: ReadonlySet<number>): ConsolidatorOutput | undefined {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.ops) ? raw.ops : undefined;
  if (!list) return undefined;
  return { ops: list.map((o) => validateOp(o, ids)).filter((o): o is ConsolidatorOp => o !== undefined) };
}

const SYSTEM = `You tidy a streamer's AI co-host's private notes about one viewer. Each note is one short sentence.
You may answer with operations on the notes you are given, and nothing else:
- {"op":"merge","ids":[1,2],"text":"..."}  combine duplicates or near-duplicates into one note
- {"op":"rewrite","id":3,"text":"...","category":"general|health|family","hint":"..."}  fix unclear wording or the category (give only what changes)
- {"op":"drop","id":4}  remove a note that is trivial, wrong, or should never have been kept
Rules:
- Never keep a note about the viewer's political views, or about their money, wealth or spending: drop it.
- Notes about health or family are sensitive: keep them short, never add detail, and keep a "hint" that says how to behave (for example "check in gently, don't quote").
- Keep each note under ${MAX_NOTE_TEXT} characters and each hint under ${MAX_NOTE_HINT}.
- Do not invent facts. Use only the ids you were given. If nothing needs changing answer {"ops":[]}.
- If the owner gave reasons for deleting earlier notes, drop notes that raise the same things.
Answer with one JSON object: {"ops":[...]}.`;

// @spec MEM-CONSOL-005
export const consolidatorImpl: ModuleImpl<ConsolidatorInput, ConsolidatorOutput> = {
  rules: () => ({ ops: [] }),
  llm: {
    system: SYSTEM,
    maxTokens: 600,
    user: (input) => [
      `Viewer: ${input.viewer}`,
      "Notes (id | layer | category | strength | mentions | text | hint):",
      ...input.notes.map((n) => `${n.id} | ${n.layer} | ${n.category} | ${n.strength.toFixed(2)} | ${n.mentions} | ${n.text} | ${n.hint ?? ""}`),
      ...(input.suppressionReasons.length ? ["The owner deleted earlier notes for these reasons:", ...input.suppressionReasons.map((r) => `- ${r}`)] : []),
    ].join("\n"),
    validate: (raw, input) => validateOps(raw, new Set(input.notes.map((n) => n.id))),
  },
  http: { validate: (raw, input) => validateOps(raw, new Set(input.notes.map((n) => n.id))) },
};

// @spec MEM-NOTE-011
/**
 * The chat provider settings a notes hook builds its model on: the local `ollama` provider unless the hook names a provider
 * itself (applied by the Module on top of this), so a hosted cortex model never carries viewer notes off the LAN.
 * `llm.provider: mock` is inherited so the isolation preset still reaches the hooks.
 */
export function notesHookLlm(llm: Config["llm"], hook: ModuleConfig): Config["llm"] {
  if (hook.llm.provider || llm.provider === "mock") return llm;
  return { ...llm, provider: "ollama" };
}

// @spec MEM-NOTE-012
/** Under `llm.provider: mock` a notes hook's own provider is dropped so the Module inherits mock (an isolated run reaches no model server). */
export function notesHookConfig(llm: Config["llm"], hook: ModuleConfig): ModuleConfig {
  return llm.provider === "mock" && hook.llm.provider ? { ...hook, llm: { ...hook.llm, provider: undefined } } : hook;
}

// @spec MEM-CONSOL-005, MEM-NOTE-011, MEM-NOTE-012
/** `memory.consolidator`: the model part of consolidation, configured by `brain.memory.notes.consolidator`. */
export function createConsolidatorHook(cfg: Config, log: Logger): Module<ConsolidatorInput, ConsolidatorOutput> {
  const hook = notesHookConfig(cfg.llm, cfg.brain.memory.notes.consolidator);
  return new Module("memory.consolidator", hook, notesHookLlm(cfg.llm, hook), consolidatorImpl, log);
}
