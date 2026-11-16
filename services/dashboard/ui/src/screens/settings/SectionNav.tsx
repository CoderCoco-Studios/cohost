import { useEffect, useState, useSyncExternalStore } from "react";
import { formatHash } from "../../app/routes";
import { navGroups, type SchemaModel } from "./schemaModel";
import { useSettingsState } from "./store";

export const PERSONALITY = "personality";

const NARROW = "(max-width: 719.98px)";
const narrowQuery = (): MediaQueryList | null => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null);
function subscribeNarrow(cb: () => void): () => void { const q = narrowQuery(); q?.addEventListener?.("change", cb); return () => q?.removeEventListener?.("change", cb); }
/** Whether the page is at phone width (the stylesheet's narrow block); false where the browser cannot say. */
const useNarrow = (): boolean => useSyncExternalStore(subscribeNarrow, () => narrowQuery()?.matches === true, () => false);

/**
 * The section list beside the form, grouped under the schema's group names, with Personality first in Identity and the
 * number of edited keys beside each entry (DASH-SET-001). On phones it sits above the page and collapses to the current entry. A section with `page` is not listed.
 */
// @spec DASH-SET-001
export function SectionNav({ model, current }: { model: SchemaModel; current: string }) {
  const sections = useSettingsState((s) => s.sections);
  const personality = useSettingsState((s) => s.personality);
  const groups = navGroups(model).map((g) => ({ group: g.group, entries: g.sections.map((s) => ({ path: s.path, title: s.title, members: [s.path, ...model.sections.filter((m) => m.page === s.path).map((m) => m.path)] })) }));
  const identity = groups.find((g) => g.group === "Identity");
  const personalityEntry = { path: PERSONALITY, title: "Personality", members: [] as string[] };
  if (identity) identity.entries.unshift(personalityEntry); else groups.unshift({ group: "Identity", entries: [personalityEntry] });
  const narrow = useNarrow();
  const [picking, setPicking] = useState(false);
  useEffect(() => setPicking(false), [current]); // choosing a section closes the list again
  const currentTitle = groups.flatMap((g) => g.entries).find((e) => e.path === current)?.title ?? "Settings";
  const count = (members: string[], path: string) =>
    path === PERSONALITY ? (personality.status === "ready" && personality.text !== personality.loaded ? 1 : 0) : members.reduce((n, p) => n + Object.keys(sections[p]?.edits ?? {}).length, 0);
  return (
    <nav className="card snav" aria-label="Settings sections">
      {/* At phone width the list collapses to the current section; wider, it is always open and the toggle is hidden. */}
      <details className="snav-details" open={!narrow || picking} onToggle={(e) => { if (narrow) setPicking((e.currentTarget as HTMLDetailsElement).open); }}>
      <summary className="snav-toggle">{`Sections: ${currentTitle}`}</summary>
      {groups.map((g) => (
        <div key={g.group}>
          <h2 className="nav-h">{g.group}</h2>
          <ul className="plain">
            {g.entries.map((e) => {
              const n = count(e.members, e.path);
              return (
                <li key={e.path}>
                  <a className="tab sub" href={formatHash({ view: "settings", section: e.path })} aria-current={e.path === current ? "page" : undefined}>
                    {e.title}
                    {n > 0 ? <span className="count">{n}<span className="sr-only">{n === 1 ? " edit" : " edits"}</span></span> : null}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      </details>
    </nav>
  );
}
