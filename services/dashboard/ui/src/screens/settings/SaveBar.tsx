import { Button } from "../../components/Button";
import { matchIssue, type SectionModel } from "./schemaModel";
import { sectionValid, useSettings, useSettingsState } from "./store";

/**
 * The sticky save bar of a page: the count of edits, Discard, Check (a dry run) and Save, the outcome beside them, and the
 * issues no field claimed in one summary above (DASH-SET-005, DASH-SET-006, DASH-SET-011).
 */
// @spec DASH-SET-005, DASH-SET-006, DASH-SET-011, DASH-UI-015, DASH-A11Y-004
export function SaveBar({ members }: { members: SectionModel[] }) {
  const settings = useSettings();
  const paths = members.map((m) => m.path);
  const sections = useSettingsState((s) => s.sections);
  const bar = useSettingsState((s) => s.bars[paths[0]!]) ?? { kind: "idle" as const };
  const edits = paths.reduce((n, p) => n + Object.keys(sections[p]?.edits ?? {}).length, 0);
  const valid = members.every((m) => !sections[m.path] || sectionValid(sections[m.path]!, m));
  const busy = bar.kind === "busy";
  const conflict = paths.some((p) => sections[p]?.conflict);
  const loose = members.flatMap((m) => {
    const s = sections[m.path];
    return (s?.issues ?? []).filter((i) => !matchIssue(m.path, [...new Set([...m.keys.map((k) => k.key), ...Object.keys(s?.keys ?? {})])], i.path));
  });
  const off = edits === 0 || !valid || busy;
  return (
    <div className="savebar" role="group" aria-label="Save settings">
      <div className="grow">
        <output className="small"><b>{`${edits} ${edits === 1 ? "edit" : "edits"} in this section`}</b></output>
        {/* The live region stays mounted and receives the text, so a screen reader announces the result (DASH-A11Y-004). */}
        <output className={`save-status small ${bar.kind === "ok" ? "action-ok" : "muted"}`}>
          {bar.kind === "busy" ? (bar.what === "check" ? "Checking…" : "Saving…") : bar.kind === "ok" ? bar.message : ""}
        </output>
        {bar.kind === "ok" && bar.warnings.length > 0 ? <ul className="plain small">{bar.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}
        {bar.kind === "error" || loose.length > 0 ? (
          <div className="action-error" role="alert">
            <div>
              {bar.kind === "error" ? <span>{bar.message}</span> : null}
              {loose.length > 0 ? <ul className="plain">{loose.map((i, n) => <li key={n}>{i.path ? `${i.path}: ${i.message}` : i.message}</li>)}</ul> : null}
            </div>
            {conflict ? <Button size="sm" onClick={() => paths.forEach((p) => { if (sections[p]?.conflict) void settings.reload(p); })}>Reload</Button> : null}
          </div>
        ) : null}
      </div>
      <Button variant="ghost" disabled={edits === 0 || busy} onClick={() => settings.discard(paths)}>Discard</Button>
      <Button disabled={off} onClick={() => void settings.run(paths, true)}>Check</Button>
      <Button variant="primary" disabled={off} busy={busy && bar.what === "save"} onClick={() => void settings.run(paths, false)}>Save</Button>
    </div>
  );
}
