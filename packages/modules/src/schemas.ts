/**
 * The reply contract of each hook as JSON Schema, for anyone writing an `http` module or prompting an `llm` one.
 * Each region's `validate` function stays the authority at run time (it also clamps and drops what it does not
 * recognise); `scripts/gen-hook-schemas.mjs` writes these to `examples/modules/schemas/`, and
 * `packages/modules/test/schemas.test.ts` checks that every reply the schema accepts the region's validator accepts and
 * every reply of the wrong shape it rejects.
 */
import { EMOTIONS } from "@cohost/config";

export type HookName = "salience" | "affect" | "critic";

const draft = "https://json-schema.org/draft/2020-12/schema";

export const HOOK_REPLY_SCHEMAS: Record<HookName, Record<string, unknown>> = { // @spec HOOK-SCHEMA-001
  salience: {
    $schema: draft,
    title: "salience hook reply",
    description: "Exactly one score per event in the request, in the same order. Scores outside 0..1 are clamped.",
    type: "object",
    required: ["scores"],
    properties: { scores: { type: "array", items: { type: "number", minimum: 0, maximum: 1 } } },
  },
  affect: {
    $schema: draft,
    title: "affect hook reply",
    description: "How one line moves the mood. Deltas outside -0.5..0.5 are clamped.",
    type: "object",
    required: ["valence_delta", "arousal_delta"],
    properties: {
      valence_delta: { type: "number", minimum: -0.5, maximum: 0.5 },
      arousal_delta: { type: "number", minimum: -0.5, maximum: 0.5 },
    },
  },
  critic: {
    $schema: draft,
    title: "critic hook reply",
    description: "ok false drops the line; a non-empty text replaces it; an emotion replaces its emotion; note says why.",
    type: "object",
    required: ["ok"],
    properties: {
      ok: { type: "boolean" },
      text: { type: "string", minLength: 1 },
      emotion: { enum: [...EMOTIONS] },
      note: { type: "string" },
    },
  },
};
