// Field validation against the key's JSON Schema (DASH-SET-005): type, integer, minimum, maximum, length, pattern, list
// size and a card's properties. The server stays the authority; this only keeps an obviously wrong value from being sent.
import type { ItemProp, JsonSchema, KeyModel } from "./schemaModel";

/** Messages by sub-path: `""` is the key itself, `"0.match"` a property of the first card of a list. */
export type Errors = Record<string, string>;

/** One value per line, trimmed, blank lines dropped (DASH-SET-019). */
export const fromLines = (text: string): string[] => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");

function scalar(schema: JsonSchema, value: unknown): string | undefined {
  if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "Enter a number.";
    if (schema.type === "integer" && !Number.isInteger(value)) return "Enter a whole number.";
    if (schema.minimum !== undefined && value < schema.minimum) return `Must be at least ${schema.minimum}.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `Must be at most ${schema.maximum}.`;
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) return `Must be above ${schema.exclusiveMinimum}.`;
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return `Must be below ${schema.exclusiveMaximum}.`;
    return undefined;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return "Enter text.";
    if (schema.minLength !== undefined && value.length < schema.minLength) return schema.minLength <= 1 ? "A value is required." : `Must be at least ${schema.minLength} characters.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `Must be at most ${schema.maxLength} characters.`;
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) return "Does not match the required pattern."; } catch { /* a pattern JS cannot read: the server checks it */ } }
    return undefined;
  }
  return undefined;
}

function list(schema: JsonSchema, value: unknown, props?: ItemProp[]): Errors {
  if (!Array.isArray(value)) return { "": "Enter a list." };
  const out: Errors = {};
  if (schema.minItems !== undefined && value.length < schema.minItems) out[""] = `Add at least ${schema.minItems}.`;
  const item = schema.items;
  if (!item) return out;
  value.forEach((v, i) => {
    if (props) {
      const card = (v ?? {}) as Record<string, unknown>;
      for (const p of props) {
        const present = card[p.name];
        if (present === undefined && !p.required) continue;
        const sub = p.schema.type === "array" ? list(p.schema, present ?? []) : { "": scalar(p.schema, present) };
        for (const [k, m] of Object.entries(sub)) if (m) out[k ? `${i}.${p.name}.${k}` : `${i}.${p.name}`] = m;
      }
    } else {
      const m = scalar(item, v);
      if (m) out[`${i}`] = m;
    }
  });
  return out;
}

/** The errors of one key's current value, by sub-path; empty when it is valid. */
export function validateKey(key: KeyModel, value: unknown): Errors {
  const c = key.control;
  if (c.kind === "objects") return list(key.schema, value, c.props);
  if (key.schema.type === "array") {
    const e = list(key.schema, value);
    const first = Object.keys(e).find((k) => k !== "");
    if (first !== undefined && e[""] === undefined) return { "": e[first]! };
    return e[""] !== undefined ? { "": e[""] } : {};
  }
  if (c.kind === "json" || c.kind === "secret" || c.kind === "switch") return {};
  const m = scalar(key.schema, value);
  return m ? { "": m } : {};
}

/** The value as the PUT body carries it. Values are already in wire form; this is the one place that would change that. */
export const toWire = (_key: KeyModel, value: unknown): unknown => value;
