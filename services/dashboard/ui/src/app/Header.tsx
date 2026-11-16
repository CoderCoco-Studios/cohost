import { Button } from "../components/Button";
import { Icon } from "../components/Icon";
import { SegmentedGroup } from "../components/SegmentedGroup";
import { Status, stackStatus, type StatusInfo } from "../components/Status";
import { attentionCount } from "../state/derive";
import { useAccess, useFeed, useMute } from "../state/hooks";
import { useRuntime } from "./providers";
import { formatHash, type Route } from "./routes";
import { SCREENS } from "./screens";
import { useStore } from "../state/store";
import type { ThemePreference } from "../state/theme";

function brainStatus(state: unknown): StatusInfo {
  switch (state) {
    case "speaking": return { status: "ok", word: "Speaking" };
    case "thinking": return { status: "building", word: "Thinking" };
    case "idle": return { status: "ok", word: "Idle" };
    case "muted": return { status: "warn", word: "Muted" };
    default: return { status: "stopped", word: "Waiting for the co-host" };
  }
}

/**
 * The header: four wrapping groups, in order, each with the class `header-group` (DASH-NAV-002): the brand, the nav (the
 * four screens, then the Docs link that opens `/cohost/` in a new tab), the status cluster (what the co-host is doing
 * and the stack state) and the controls (Audio, Mute, Access, theme).
 */
// @spec DASH-NAV-002, DASH-UI-024, DASH-UI-003, DASH-UI-018, DASH-ACC-001
export function Header({ name, route, onNavigate }: { name: string; route: Route; onNavigate: (r: Route) => void }) {
  const { theme, audio } = useRuntime();
  const attention = attentionCount(useFeed((f) => f.services));
  const brain = brainStatus(useFeed((f) => (f.latest["brain.status"]?.data as { state?: unknown } | undefined)?.state));
  const stack = useFeed((f) => f.stack?.state);
  const stackInfo = stack ? stackStatus(stack) : null;
  const audioOn = useStore(audio.state, (s) => s.enabled);
  const mute = useMute();
  const { state: access, access: accessStore } = useAccess();
  const preference = useStore(theme.state, (s) => s.preference);
  return (
    <header className="top">
      <div className="header-group brand"><span className="brand-name">{name}</span><span className="brand-sub">cohost</span></div>
      <nav className="header-group nav" aria-label="Main">
        {SCREENS.map((s) => (
          <a key={s.id} className="tab" href={formatHash({ view: s.id })} aria-current={route.view === s.id ? "page" : undefined}
            onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); onNavigate({ view: s.id }); }}>
            {s.label}
            {s.id === "services" && attention > 0 ? <span className="count" aria-label={`${attention} ${attention === 1 ? "needs" : "need"} attention`}>{attention}</span> : null}
          </a>
        ))}
        <a className="tab" href="/cohost/" target="_blank" rel="noopener" title="Opens the documentation in a new tab">Docs<Icon name="external" /></a>
      </nav>
      <div className="header-group cluster" role="group" aria-label="Status">
        <Status status={brain.status} label={brain.word} />
        {stackInfo ? <Status status={stackInfo.status} label={`Stack: ${stackInfo.word}`} /> : null}
      </div>
      <div className="header-group controls">
        <Button aria-pressed={audioOn} onClick={() => (audioOn ? audio.disable() : audio.enable())}><Icon name={audioOn ? "speaker" : "speakerOff"} />{audioOn ? "Audio on" : "Audio off"}</Button>
        <Button aria-pressed={mute.muted} busy={mute.pending} onClick={() => void mute.toggle()}><Icon name="mic" />{mute.label}</Button>
        <Button onClick={() => accessStore.openPanel()}><Icon name={access.control.present ? "unlock" : "lock"} />{access.control.present ? "Unlocked" : "Locked"}</Button>
        <SegmentedGroup legend="Theme" name="theme" value={preference} onChange={(v) => theme.set(v as ThemePreference)}
          options={[{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </div>
    </header>
  );
}
