import { useEffect, useState } from "react";
import { useStale } from "../../app/connection";
import { EmptyState, LoadingState } from "../../components/StateBlocks";
import { Status } from "../../components/Status";
import { useApi, useFeed } from "../../state/hooks";
import { avatarParams, faceGeometry } from "./avatar";

/** The pages of `GET /avatar/renderer` the card reads: the frame rate each open renderer page is sent. */
interface RendererPages { pages: { sentFps: number }[] }

/** The line under the face while the browser driver is named: the renderer pages and the highest frame rate sent to one (DASH-AVS-010). */
export function rendererLine(r: RendererPages): string {
  const n = r.pages.length;
  if (n === 0) return "Renderer: no page connected";
  const fps = Math.max(...r.pages.map((p) => p.sentFps));
  return `Renderer: ${n} ${n === 1 ? "page" : "pages"} · ${fps} fps`;
}

/**
 * Reads `GET /avatar/renderer` every 2 s while `on` (the latest avatar state names the browser driver), the next read scheduled after the last answers. An unavailable route
 * (the LAN listener answers 404) leaves no answer, so no stale line stays on the card.
 */
// @spec DASH-AVS-010
function useRendererPages(on: boolean): RendererPages | null | undefined {
  const api = useApi();
  const [pages, setPages] = useState<RendererPages | null | undefined>(undefined);
  useEffect(() => {
    if (!on) { setPages(undefined); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      const r = await api.get<{ pages?: unknown }>("/avatar/renderer");
      if (live) {
        const ok = r.ok && Array.isArray(r.data?.pages) && r.data.pages.every((p) => Number.isFinite((p as { sentFps?: unknown } | null)?.sentFps));
        setPages(ok ? { pages: r.data.pages as { sentFps: number }[] } : null);
        timer = setTimeout(() => void read(), 2000);
      }
    };
    void read();
    return () => { live = false; clearTimeout(timer); };
  }, [on, api]);
  return pages;
}

/**
 * The avatar preview: the SVG face drawn from the latest `avatar.state`, the driver name (with "(disconnected)" when it
 * is not connected) and the current emotion, which mirrors what the avatar driver receives. `avatar.state` adds no feed
 * row (DASH-UI-004). The card is dimmed and `aria-busy` while the socket is closed (DASH-UI-001).
 */
// @spec DASH-UI-004, DASH-UI-001
export function AvatarCard() {
  const latest = useFeed((f) => f.latest["avatar.state"]);
  const waiting = useFeed((f) => f.status === "connecting" && f.stoppedAt === undefined);
  const stale = useStale();
  const p = avatarParams(latest?.data);
  const g = faceGeometry(p);
  const renderer = useRendererPages(p.driver === "browser");
  return (
    <section className={`card live-avatar${stale.className ? ` ${stale.className}` : ""}`} aria-labelledby="live-avatar-h" aria-busy={stale["aria-busy"]}>
      <div className="card-h">
        <h2 id="live-avatar-h">Avatar</h2><span className="grow" />
        {latest ? <Status status={p.connected ? "ok" : "warn"} label={`${p.driver || "unknown"}${p.connected ? " connected" : " (disconnected)"}`} plain /> : null}
      </div>
      <div className="card-b stack-y">
        {!latest && waiting ? <LoadingState label="Waiting for the avatar…" /> : null}
        {!latest && !waiting ? <EmptyState title="No avatar state yet">The avatar driver has not reported. The face stays neutral until it does.</EmptyState> : null}
        {renderer ? <p className="small muted live-renderer">{rendererLine(renderer)}</p> : null}
        <svg className="face" viewBox="0 0 200 200" role="img" aria-label={`Avatar preview${p.emotion ? `: ${p.emotion}` : ""}`}>
          <g data-part="head" transform={g.head}>
            <circle className="face-head" cx="100" cy="100" r="70" strokeWidth="2" />
            <ellipse className="face-eye" data-part="eye-left" cx={g.eyeLeft.cx} cy={g.eyeLeft.cy} rx="7" ry={g.eyeRy} />
            <ellipse className="face-eye" data-part="eye-right" cx={g.eyeRight.cx} cy={g.eyeRight.cy} rx="7" ry={g.eyeRy} />
            <path className="face-mouth" data-part="mouth" d={g.mouth} strokeWidth="3" strokeLinecap="round" />
          </g>
        </svg>
        <div className="stack-y live-emotion">
          <span className="label">Emotion</span>
          <span className="live-emotion-word">{p.emotion || "none"}</span>
          <span className="small faint">Mirrors what the avatar driver receives.</span>
        </div>
      </div>
    </section>
  );
}
