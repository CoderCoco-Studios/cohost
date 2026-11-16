import { useStale } from "../../app/connection";
import { EmptyState, LoadingState } from "../../components/StateBlocks";
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
      <div className="card-h"><h2 id="live-avatar-h">Avatar</h2></div>
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
        {latest ? (
          <div className="stack-y">
            <p>Driver: <strong>{p.driver || "unknown"}{p.connected ? "" : " (disconnected)"}</strong></p>
            <p>{`Emotion: ${p.emotion || "none"}`}</p>
          </div>
        ) : null}
        <p className="help">The emotion mirrors what the avatar driver receives.</p>
      </div>
    </section>
  );
}
