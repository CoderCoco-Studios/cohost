// The renderer's status above the preview (DASH-AVS-008): `GET /avatar/renderer` read every 2 s while the page is on screen,
// the line it says, the note when the file holds other renderer values than the renderer shows (DASH-AVS-009), and the link
// to the third-party notices (DASH-AVS-011).
import { useEffect, useState } from "react";
import { noticesFile } from "../../app/notices";
import { formatHash } from "../../app/routes";
import { useApi } from "../../state/hooks";
import type { SectionState } from "./store";

/** The answer of `GET /avatar/renderer` (DASH-MDL-024, avatar-relay.ts `RendererStatus`). */
export interface RendererAnswer {
  state: "off" | "waiting" | "live";
  driver: string | null;
  fps: number | null;
  applied: { model: string | null; configuredModel: string; zoom: number; offsetY: number; turn: number };
  pages: { sentFps: number; model: { state: string; detail?: string } | null; since: number }[];
  previews: number;
  maxPages: number;
  maxPreviews: number;
}

export type StatusRead =
  | { kind: "loading" }
  | { kind: "ready"; status: RendererAnswer }
  | { kind: "unavailable" }
  | { kind: "error"; detail: string };

/** Reads the status now and every 2 s until the page is gone (the real clock, not the runtime's). */
export function useRendererStatus(): StatusRead {
  const api = useApi();
  const [read, setRead] = useState<StatusRead>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    const once = async (): Promise<void> => {
      const r = await api.get<RendererAnswer>("/avatar/renderer");
      if (!live) return;
      if (r.ok && r.data && Array.isArray(r.data.pages)) setRead({ kind: "ready", status: r.data });
      else if (!r.ok && r.status === 404) setRead({ kind: "unavailable" });
      else setRead({ kind: "error", detail: r.ok ? "the answer had an unexpected shape" : r.detail });
    };
    void once();
    const id = setInterval(() => void once(), 2000);
    return () => { live = false; clearInterval(id); };
  }, [api]);
  return read;
}

/** The renderer values the file holds, as the schema reads them (a key not in the file holds its default). */
export function savedFraming(st: SectionState): { model: string; zoom: number; offsetY: number; turn: number } {
  const num = (k: string, d: number): number => { const v = st.keys[k]?.value; return typeof v === "number" ? v : d; };
  return { model: String(st.keys.model?.value ?? ""), zoom: num("zoom", 1), offsetY: num("offset_y", 0), turn: num("turn", 0) };
}

/** The status line's own words for a read the page has (DASH-AVS-008): the pages connected, or what the avatar waits for. */
export function statusText(s: RendererAnswer): string {
  if (s.state !== "live" || s.driver !== "browser") {
    if (s.driver !== "browser") return `avatar.driver is ${s.driver ?? "null"}; the renderer needs browser`;
    return "Waiting for the avatar";
  }
  const n = s.pages.length;
  if (n === 0) return "No OBS page connected";
  const fps = Math.max(...s.pages.map((p) => p.sentFps));
  return `${n} OBS ${n === 1 ? "page" : "pages"} connected · ${fps} fps sent`;
}

/** What one loopback page says about its model, when it has a model state to say. */
function modelText(s: RendererAnswer): string[] {
  return s.pages.flatMap((p) => {
    if (!p.model) return [];
    if (p.model.state === "failed") return [`model failed to load: ${p.model.detail ?? "unknown reason"}`];
    if (p.model.state === "ready") return ["model loaded"];
    return [`model ${p.model.state}`];
  });
}

// @spec DASH-AVS-008, DASH-AVS-009, DASH-AVS-011
/** The status line, the note on the file and the notices link, above the preview. */
export function RendererStatus({ st }: { st: SectionState }) {
  const read = useRendererStatus();
  const notices = noticesFile();
  const driverLink = formatHash({ view: "settings", section: "avatar" });
  return (
    <div className="stack-y renderer-status-block">
      <output role="status" aria-label="Avatar renderer status" className="small renderer-status">
        {read.kind === "loading" ? "Reading the renderer status…" : null}
        {read.kind === "unavailable" ? "The renderer status is not available here: it is read on the full dashboard listener." : null}
        {read.kind === "error" ? `Could not read the renderer status: ${read.detail}` : null}
        {read.kind === "ready" ? (
          <>
            <span>{statusText(read.status)}</span>
            {read.status.state !== "live" || read.status.driver !== "browser" ? <>{" "}<a href={driverLink}>Set avatar.driver</a></> : null}
            {modelText(read.status).map((m, i) => <span key={i} className="renderer-model-line">{m}</span>)}
          </>
        ) : null}
      </output>
      {read.kind === "ready" && differs(st, read.status) ? (
        <p className="note note-warn small">
          {`config.yaml holds ${describe(savedFraming(st))} but the renderer shows ${describeApplied(read.status.applied)}; restart the dashboard to apply the file.`}
        </p>
      ) : null}
      {notices ? <p className="small"><a href={`/assets/${notices}`}>Third-party notices</a></p> : null}
    </div>
  );
}

const describe = (v: { model: string; zoom: number; offsetY: number; turn: number }): string =>
  `model "${v.model}", zoom ${v.zoom}, vertical position ${v.offsetY}, turn ${v.turn}`;
const describeApplied = (a: RendererAnswer["applied"]): string =>
  `model "${a.configuredModel}", zoom ${a.zoom}, vertical position ${a.offsetY}, turn ${a.turn}`;

/** Whether the file's renderer values differ from what the renderer applies (`configuredModel`, `zoom`, `offsetY`, `turn`). */
export function differs(st: SectionState, s: RendererAnswer): boolean {
  const f = savedFraming(st);
  const a = s.applied;
  return f.model !== a.configuredModel || f.zoom !== a.zoom || f.offsetY !== a.offsetY || f.turn !== a.turn;
}
