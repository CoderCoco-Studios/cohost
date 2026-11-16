import { Banner } from "../../components/Banner";
import { Button } from "../../components/Button";
import { useFeed } from "../../state/hooks";
import { useSettings, useSettingsState } from "./store";

/**
 * The banner of units to restart after a save or a secret write (design: After a save). It is page state: it follows the
 * operator between sections and screens and ends when every unit has restarted. With control enabled, Restart goes through
 * the lifecycle routes one unit after another; without it the banner names the `cohostctl` command instead.
 */
// @spec DASH-SET-007, DASH-SET-008
export function RestartBanner() {
  const settings = useSettings();
  const restart = useSettingsState((s) => s.restart);
  const control = useSettingsState((s) => s.control);
  const stack = useFeed((f) => f.stack);
  if (restart.units.length === 0 && Object.keys(restart.results).length === 0) return null;
  const isolated = (id: string) => !!stack?.services.find((c) => c.service === id && c.overrides && Object.keys(c.overrides).length > 0);
  const done = restart.units.length === 0;
  const results = Object.entries(restart.results);
  return (
    <section aria-label="Restart needed">
      <Banner tone={done ? "ok" : "warn"}
        title={done ? `Restarted: ${results.map(([u]) => u).join(", ")}` : `Restart these services to apply: ${restart.units.join(", ")}`}
        actions={done
          ? <Button variant="ghost" size="sm" onClick={() => settings.dismissRestart()}>Dismiss</Button>
          : control ? <Button variant="primary" busy={restart.running} onClick={() => void settings.restartUnits()}>Restart</Button> : null}>
        {restart.warnings.length > 0 ? <ul className="plain">{restart.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        {!done && !control ? (
          <ul className="plain">{restart.units.map((u) => <li key={u}><code className="mono">{`cohostctl restart ${u}`}</code></li>)}</ul>
        ) : null}
        {restart.units.filter(isolated).map((u) => <p key={u} className="small">{`${u} runs isolated: a restart keeps its override, so a saved value it overrides applies again only once it is started without isolation.`}</p>)}
        {results.length > 0 ? (
          <ul className="plain">{results.map(([u, r]) => <li key={u}>{`${u}: ${r.detail}`}</li>)}</ul>
        ) : null}
      </Banner>
    </section>
  );
}
