// Suggestions the Settings screen offers beside what the servers report. They are suggestions only: any name can be typed.
// Kept in this one module so the lists are easy to update. Installed models (`GET /options/models`) are listed first.
import type { ModelKind } from "./schemaModel";

/** A short curated list of model names per kind (design: Widgets, `model`). */
export const CURATED_MODELS: Record<ModelKind, string[]> = {
  chat: ["llama3.1:8b", "qwen2.5:7b", "mistral:7b", "gemma2:9b", "llama3.2:3b"],
  small: ["llama3.2:3b", "llama3.2:1b", "qwen2.5:3b", "gemma2:2b", "phi3:mini"],
  vision: ["llama3.2-vision:11b", "llava:7b", "minicpm-v:8b", "qwen2.5vl:7b", "moondream"],
  embed: ["nomic-embed-text", "mxbai-embed-large", "bge-m3", "all-minilm"],
  stt: ["small.en", "base.en", "medium.en", "large-v3", "distil-large-v3"],
};

export interface SourceTile { value: string; label: string; description: string }

/** The audio sources the screen knows by name (`sources` widget); any other connector tag is added by hand and shown as its own tile. */
export const KNOWN_SOURCES: SourceTile[] = [
  { value: "discord", label: "discord", description: "The Discord voice channel." },
  { value: "http", label: "http", description: "Audio clips posted to the web address." },
  { value: "dir", label: "dir", description: "Audio files dropped in a folder." },
  { value: "desktop", label: "desktop", description: "Desktop audio from the desktop helper." },
];

/** The browser's time zone names plus `UTC` and the current value, or null when the browser has no list (a text box then). */
export function timeZones(current: string): string[] | null {
  let zones: string[] | undefined;
  try {
    const f = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    zones = typeof f === "function" ? f.call(Intl, "timeZone") : undefined;
  } catch { zones = undefined; }
  if (!zones || zones.length === 0) return null;
  const all = new Set(zones);
  all.add("UTC");
  if (current) all.add(current);
  return [...all];
}
