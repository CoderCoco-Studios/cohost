import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { useFeed } from "../state/hooks";
import { useStore } from "../state/store";
import { useRuntime } from "./providers";

/** Whether a page URL's query selects the sink view: any `sink` parameter, whatever its value (`?sink=1`, `?sink=0`, `?sink`). */
export const isSinkLocation = (search: string): boolean => new URLSearchParams(search).has("sink");

/**
 * The audio sink view (`?sink=1`, the OBS Browser Source): the brand, the audio state and a one-line status, and nothing
 * else. Audio starts on without a click. It makes no request of its own: the `/ws` socket, `GET /audio/<id>.wav` and
 * `POST /sink` are all the LAN listener answers (DASH-UI-011).
 */
// @spec DASH-UI-011, DASH-UI-012, DASH-UI-013, DASH-UI-014, DASH-UI-022
export function SinkView({ name }: { name: string }) {
  const { audio } = useRuntime();
  const on = useStore(audio.state, (s) => s.enabled);
  const playing = useStore(audio.state, (s) => s.playing);
  const queued = useStore(audio.state, (s) => s.queued);
  const status = useFeed((f) => f.status);
  const base = playing ? "Playing" : status === "open" ? "Connected" : status === "closed" ? "Reconnecting…" : "Connecting…";
  const line = queued > 0 ? `${base} · ${queued} waiting` : base;
  return (
    <main className="sink" id="main">
      <p className="brand"><span className="brand-name">{name}</span> <span className="brand-sub">cohost</span></p>
      <p className="sink-audio"><Icon name={on ? "speaker" : "speakerOff"} /> {on ? "Audio on" : "Audio off"} {on ? null : <Button size="sm" onClick={() => audio.enable()}>Turn audio on</Button>}</p>
      {on ? null : <p className="help">The browser did not start playback. Turn audio on to play the lines that are waiting.</p>}
      <p className="sink-status" role="status">{line}</p>
    </main>
  );
}
