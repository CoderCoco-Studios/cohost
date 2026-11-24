// Fixtures for the Avatar settings tests (issue #219): the `avatar` page with the `renderer` group as `GET /config/schema`
// describes it (packages/config/src/presentation.ts), the section reads, the model list of `GET /avatar/models` and the
// answer of `GET /avatar/renderer`. Shapes follow DASH-MDL-010/-011 and the design's Health and visibility.
import { GROUPS, type KeyRead } from "./settings-fixture";

export const MAX_BYTES = 52_428_800; // 50 MiB

export const avatarSchema = {
  groups: GROUPS,
  sections: [
    {
      path: "avatar", title: "Avatar", group: "Voice and body", about: "Which avatar app the co-host drives.", services: ["avatar"], secrets: [],
      schema: { type: "object", properties: { driver: { type: "string", enum: ["null", "vtube-studio", "vmc", "browser"], default: "null" } } },
      keys: { driver: { help: "Which avatar app the co-host drives." } },
    },
    {
      path: "renderer", title: "Avatar renderer", group: "Voice and body", about: "The model and framing the browser renderer draws the avatar with.", page: "avatar", live: true, services: ["avatar"], secrets: [],
      schema: {
        type: "object",
        properties: {
          model: { type: "string", maxLength: 80, default: "" },
          zoom: { type: "number", minimum: 0.5, maximum: 3, default: 1 },
          offset_y: { type: "number", minimum: -1.5, maximum: 1.5, default: 0 },
          turn: { type: "number", minimum: -90, maximum: 90, default: 0 },
        },
      },
      // Mirrors the real presentation: only `turn` carries a `slider` hint, and no key carries a step.
      keys: {
        model: { help: "The .vrm model file.", widget: { type: "avatar-model" }, label: "Model" },
        zoom: { help: "How close the camera is.", label: "Zoom" },
        offset_y: { help: "Moves the model up or down.", label: "Vertical position" },
        turn: { help: "Turns the model.", unit: "deg", widget: { type: "slider" }, label: "Turn" },
      },
    },
  ],
};

const lit = (value: unknown): KeyRead => ({ source: "literal", editable: true, value, raw: JSON.stringify(value) });
const def = (value: unknown): KeyRead => ({ source: "default", editable: true, value });

export const avatarRead = { section: "avatar", etag: "v1", unknown: [], keys: { driver: lit("browser") } as Record<string, KeyRead> };

export function rendererRead(over: { model?: string; zoom?: number; offset_y?: number; turn?: number } = {}) {
  const v = { model: "", zoom: 1, offset_y: 0, turn: 0, ...over };
  return {
    section: "renderer", etag: "r1", unknown: [],
    keys: { model: v.model ? lit(v.model) : def(""), zoom: lit(v.zoom), offset_y: lit(v.offset_y), turn: lit(v.turn) } as Record<string, KeyRead>,
  };
}

export interface Model {
  name: string; bytes: number; modified: number; active: boolean; vrm: "0" | "1" | null; title: string | null; authors: string[];
  license: { name: string | null; url: string | null } | null; usage: { label: string; value: string }[]; expressions: string[]; error?: string;
}

export const model = (name: string, over: Partial<Model> = {}): Model => ({
  name, bytes: 2_621_440, modified: 1_700_000_000_000, active: false, vrm: "1", title: `${name} title`, authors: ["Ann"],
  license: { name: "CC-BY-4.0", url: "https://example.test/license" }, usage: [{ label: "Commercial use", value: "Allowed" }], expressions: ["happy", "sad"], ...over,
});

export const brokenModel = (name: string, error: string): Model => ({ ...model(name), vrm: null, title: null, authors: [], license: null, usage: [], expressions: [], error });

export const listAnswer = (models: Model[], active: string | null = null) => ({
  models: models.map((m) => ({ ...m, active: m.name === active })), active, maxBytes: MAX_BYTES, maxModels: 20, maxTotalBytes: 2_147_483_648,
});

export interface RendererStatus {
  state: "off" | "waiting" | "live"; driver: string | null; fps: number | null;
  applied: { model: string | null; configuredModel: string; zoom: number; offsetY: number; turn: number };
  pages: { sentFps: number; model: { state: string; detail?: string } | null; since: number }[]; previews: number; maxPages: number; maxPreviews: number;
}

export const status = (over: Partial<RendererStatus> = {}): RendererStatus => ({
  state: "live", driver: "browser", fps: 30, applied: { model: null, configuredModel: "", zoom: 1, offsetY: 0, turn: 0 },
  pages: [{ sentFps: 30, model: { state: "ready" }, since: 1_700_000_000_000 }], previews: 0, maxPages: 8, maxPreviews: 4, ...over,
});
