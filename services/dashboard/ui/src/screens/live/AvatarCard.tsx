import { useStale } from "../../app/connection";
import { EmptyState, LoadingState } from "../../components/StateBlocks";
import { Status } from "../../components/Status";
import { useFeed } from "../../state/hooks";
import { avatarParams, faceGeometry } from "./avatar";

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
  return (
    <section className={`card live-avatar${stale.className ? ` ${stale.className}` : ""}`} aria-labelledby="live-avatar-h" aria-busy={stale["aria-busy"]}>
      <div className="card-h">
        <h2 id="live-avatar-h">Avatar</h2><span className="grow" />
        {latest ? <Status status={p.connected ? "ok" : "warn"} label={`${p.driver || "unknown"}${p.connected ? " connected" : " (disconnected)"}`} plain /> : null}
      </div>
      <div className="card-b stack-y">
        {!latest && waiting ? <LoadingState label="Waiting for the avatar…" /> : null}
        {!latest && !waiting ? <EmptyState title="No avatar state yet">The avatar driver has not reported. The face stays neutral until it does.</EmptyState> : null}
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
