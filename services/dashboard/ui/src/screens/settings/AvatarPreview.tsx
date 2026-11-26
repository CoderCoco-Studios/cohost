// The live preview of the renderer (DASH-AVS-005, DASH-AVS-006): the renderer page embedded in a frame on a checkerboard, the
// aspect choice kept in local storage, and the unsaved choices posted to the frame as drafts at once and sent again when the
// frame reloads. The page is the same origin as the frame, so every message names that origin, never `*`.
import { useEffect, useId, useRef, useState } from "react";
import { useRuntime } from "../../app/providers";
import { savedFraming } from "./RendererStatus";
import type { SectionState } from "./store";

export type Aspect = "16:9" | "square" | "tall";
const ASPECTS: { value: Aspect; label: string; css: string }[] = [
  { value: "16:9", label: "16:9", css: "aspect-wide" },
  { value: "square", label: "Square", css: "aspect-square" },
  { value: "tall", label: "Tall", css: "aspect-tall" },
];
const ASPECT_KEY = "cohost.avatar.previewAspect";
/** Posted drafts are sent at most once per this many milliseconds; the last value of a burst is sent after the pause. */
const DRAFT_GAP_MS = 100;

/** The stored aspect, or 16:9 when none is stored, the stored text is not one of the three, or storage refuses to read (DASH-AVS-005). */
export function readAspect(local: Storage | undefined): Aspect {
  try {
    const v = local?.getItem(ASPECT_KEY);
    return v === "square" || v === "tall" ? v : "16:9";
  } catch { return "16:9"; }
}

function writeAspect(local: Storage | undefined, a: Aspect): void {
  try { local?.setItem(ASPECT_KEY, a); } catch { /* storage refuses: the choice lasts this page only */ }
}

export interface Framing { zoom: number; offsetY: number; turn: number }
/** The drafts the edits make: the model when `renderer.model` is edited (`""` for None), the framing when any framing key is edited. */
export interface Drafts { model?: string; framing?: Framing; framingEdited: boolean }
const FRAMING_KEYS = ["zoom", "offset_y", "turn"];

/** The drafts of a section's edits. A framing set with a number that is not finite or a zoom at or below 0 is not posted (DASH-AVS-006). */
export function draftsOf(st: SectionState): Drafts {
  const e = st.edits;
  const value = (k: string, d: number): number => {
    const v = e[k] ? e[k]!.value : st.keys[k]?.value;
    return typeof v === "number" ? v : d;
  };
  const framingEdited = FRAMING_KEYS.some((k) => e[k] !== undefined);
  const framing: Framing = { zoom: value("zoom", 1), offsetY: value("offset_y", 0), turn: value("turn", 0) };
  const valid = Number.isFinite(framing.zoom) && framing.zoom > 0 && Number.isFinite(framing.offsetY) && Number.isFinite(framing.turn);
  return {
    model: e.model ? (typeof e.model.value === "string" ? e.model.value : "") : undefined,
    framing: framingEdited && valid ? framing : undefined,
    framingEdited,
  };
}

// @spec DASH-AVS-005, DASH-AVS-006
/** The preview of the renderer in the Avatar settings. `st` is the renderer section, whose edits are the drafts. */
export function AvatarPreview({ st }: { st: SectionState }) {
  const { local } = useRuntime();
  const name = useId();
  const [aspect, setAspect] = useState<Aspect>(() => readAspect(local));
  const frame = useRef<HTMLIFrameElement>(null);
  const drafts = draftsOf(st);
  const saved = savedFraming(st);
  const savedFrame: Framing = { zoom: saved.zoom, offsetY: saved.offsetY, turn: saved.turn };
  const hasDrafts = drafts.model !== undefined || drafts.framingEdited;

  const post = (message: object): void => { frame.current?.contentWindow?.postMessage(message, location.origin); };

  // Framing moves are sent at once, then at most once per DRAFT_GAP_MS, and the last value of a burst is sent after the pause.
  const lastSent = useRef(0);
  const trailing = useRef<{ id?: number; value?: Framing }>({});
  const cancelTrailing = (): void => {
    if (trailing.current.id !== undefined) window.clearTimeout(trailing.current.id);
    trailing.current = {};
  };
  const sendFraming = (f: Framing): void => {
    const t = trailing.current;
    const wait = lastSent.current + DRAFT_GAP_MS - Date.now();
    if (wait <= 0) {
      cancelTrailing();
      lastSent.current = Date.now();
      post({ type: "framing", framing: f });
      return;
    }
    t.value = f;
    if (t.id === undefined) {
      t.id = window.setTimeout(() => {
        t.id = undefined;
        const v = t.value; t.value = undefined;
        if (v) { lastSent.current = Date.now(); post({ type: "framing", framing: v }); }
      }, wait);
    }
  };
  useEffect(() => cancelTrailing, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The framing draft. A valid edited framing is posted as it moves. When the edits return to the saved values the saved framing is
  // posted, so the frame does not keep the draft. An invalid number posts nothing and reverts nothing (the edit stays on the page).
  const framingWas = useRef(false);
  const framingKey = drafts.framing ? `${drafts.framing.zoom}|${drafts.framing.offsetY}|${drafts.framing.turn}` : drafts.framingEdited ? "invalid" : "saved";
  useEffect(() => {
    if (drafts.framing) sendFraming(drafts.framing);
    else if (!drafts.framingEdited && framingWas.current && hasDrafts) { cancelTrailing(); post({ type: "framing", framing: savedFrame }); }
    framingWas.current = drafts.framingEdited;
  }, [framingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The model draft. The frame gets a model message only when the model choice itself changes, never for a framing move: a model
  // posted from the saved value would make the page reload the applied model. When a model draft goes while framing drafts remain,
  // the frame is cleared (the applied model) and the framing draft is posted again. With no draft left, Save or Discard clears.
  const modelWas = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = modelWas.current;
    modelWas.current = drafts.model;
    if (drafts.model !== undefined) { post({ type: "model", name: drafts.model }); return; }
    if (was !== undefined && hasDrafts) {
      cancelTrailing();
      post({ type: "clear" });
      if (drafts.framing) post({ type: "framing", framing: drafts.framing });
    }
  }, [drafts.model]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save or Discard takes the drafts away: the frame is told to drop them, and nothing queued is sent after it.
  const had = useRef(false);
  useEffect(() => {
    if (had.current && !hasDrafts) { cancelTrailing(); post({ type: "clear" }); }
    had.current = hasDrafts;
  }, [hasDrafts]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A frame that loads again has none of the drafts: they are sent again, the edits being still on the page. */
  const onLoad = (): void => {
    if (drafts.model !== undefined) post({ type: "model", name: drafts.model });
    if (drafts.framing) post({ type: "framing", framing: drafts.framing });
  };

  const choose = (a: Aspect): void => { setAspect(a); writeAspect(local, a); };
  const css = ASPECTS.find((a) => a.value === aspect)!.css;

  return (
    <div className="renderer-preview stack-y">
      <div role="radiogroup" aria-label="Preview aspect" className="aspect-choice">
        {ASPECTS.map((a) => (
          <label key={a.value} className="aspect-option">
            <input type="radio" name={name} value={a.value} checked={aspect === a.value} onChange={() => choose(a.value)} />
            <span>{a.label}</span>
          </label>
        ))}
      </div>
      <div className={`checker avatar-stage ${css}`}>
        <iframe ref={frame} className="avatar-frame" src="/avatar?preview=1" title="Avatar renderer preview" onLoad={onLoad} />
      </div>
    </div>
  );
}
