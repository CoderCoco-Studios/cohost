import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ActionStatus } from "../../components/ActionStatus";
import { Button } from "../../components/Button";
import { TextField } from "../../components/Field";
import { EmptyState, ErrorState, LoadingState } from "../../components/StateBlocks";
import { useApi, useAction } from "../../state/hooks";
import { useStale } from "../../app/connection";
import type { Load } from "./useViewers";
import type { ViewerSummary } from "./types";

export interface ViewerListProps {
  load: Load<ViewerSummary[]>;
  query: string;
  /** The search text the shown list answers (the debounced one). */
  applied: string;
  onQuery: (q: string) => void;
  selected: string | null;
  onSelect: (key: string) => void;
  onRetry: () => void;
  /** After a name was marked regular: reload the list. */
  onMarked: () => void;
  /** A viewer key to move focus to (after Back from the detail on a narrow screen). */
  focusKey: string | null;
  onFocused: () => void;
}

/**
 * The left column: search, the "mark a name as regular before they chat" form and the list. Rows are real buttons; the
 * arrow keys, Home and End move between them (one tab stop for the whole list) (DASH-VIEWERS-010, DASH-VIEWERS-013,
 * DASH-VIEWERS-023).
 */
// @spec DASH-VIEWERS-010, DASH-VIEWERS-013, DASH-VIEWERS-023
export function ViewerList({ load, query, applied, onQuery, selected, onSelect, onRetry, onMarked, focusKey, onFocused }: ViewerListProps) {
  const api = useApi();
  const stale = useStale();
  const mark = useAction();
  const [name, setName] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = load.data ?? [];
  const tabStop = rows.some((r) => r.key === active) ? active : rows.some((r) => r.key === selected) ? selected : rows[0]?.key;

  useEffect(() => {
    if (focusKey === null) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-viewer]") ?? [])].find((b) => b.dataset.viewer === focusKey);
    el?.focus();
    onFocused();
  }, [focusKey, onFocused, load.data]);

  const move = (e: KeyboardEvent<HTMLUListElement>) => {
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-viewer]")];
    const i = buttons.findIndex((b) => b === document.activeElement);
    const to = e.key === "ArrowDown" ? Math.min(buttons.length - 1, i + 1) : e.key === "ArrowUp" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
    if (to < 0 || i < 0) return;
    e.preventDefault();
    buttons[to]?.focus();
  };

  const submitMark = async (e: React.FormEvent) => {
    e.preventDefault();
    const who = name.trim();
    if (!who) return;
    const r = await mark.run(() => api.post("/viewers/regular", { name: who, regular: true }, { auth: "viewers", action: "Mark a viewer as regular" }), `${who} is marked as a regular`);
    if (r.ok) { setName(""); onMarked(); }
  };

  const usable = load.status === "loading" || load.status === "ready" || load.status === "error";
  return (
    <section className={`card viewers-list-pane${stale.className ? ` ${stale.className}` : ""}`} aria-label="Viewers panel" aria-busy={stale["aria-busy"]}>
      <div className="card-h"><h2>Viewers</h2></div>
      <div className="card-b stack-y">
        {usable ? (
          <>
            <TextField label="Search viewers" type="search" placeholder="Search by name" value={query} onChange={onQuery} autoComplete="off" />
            <form className="stack-y" onSubmit={(e) => void submitMark(e)}>
              <TextField label="Mark someone as a regular before they chat" value={name} onChange={setName} placeholder="e.g. pixelwitch" autoComplete="off" />
              <div className="row"><Button type="submit" busy={mark.state.kind === "pending"}>Mark regular</Button><ActionStatus state={mark.state} onDismiss={mark.dismiss} /></div>
            </form>
          </>
        ) : null}
        {load.status === "loading" && !load.data ? <LoadingState label="Loading viewers…" /> : null}
        {load.status === "error" ? <ErrorState message={load.error ?? "Could not load viewers."} onRetry={onRetry} /> : null}
        {load.status === "locked" ? (
          <div className="state">
            <p className="state-title">The viewers list is locked</p>
            <p className="muted small">Viewer notes need the viewers token. Enter it to read and edit them.</p>
            <Button variant="primary" onClick={onRetry}>Unlock viewers</Button>
          </div>
        ) : null}
        {usable && load.data && rows.length === 0 ? (applied ? <EmptyState title={`No viewer matches “${applied}”`}>Try another name, or clear the search.</EmptyState> : <EmptyState title="No viewers yet">The co-host adds one the first time someone chats or speaks.</EmptyState>) : null}
        {usable && rows.length > 0 ? (
          <ul className="vlist" aria-label="Viewers" ref={listRef} onKeyDown={move}>
            {rows.map((v) => {
              const sel = v.key === selected;
              return (
                <li key={v.key}>
                  <button type="button" className={`vrow${sel ? " sel" : ""}`} data-viewer={v.key} aria-current={sel ? "true" : undefined}
                    tabIndex={v.key === tabStop ? 0 : -1} onFocus={() => setActive(v.key)} onClick={() => onSelect(v.key)}>
                    <span className="wrap vname">{v.display}</span>
                    <span className="vtags">
                      {v.regular ? <span className="tag tag-regular">REGULAR</span> : null}
                      {v.regularManual ? <span className="small muted">set by you</span> : null}
                      {v.voice ? <span className="tag">VOICE</span> : null}
                    </span>
                    <span className="small muted">{v.msgCount} {v.msgCount === 1 ? "message" : "messages"} · {v.noteCount ?? 0} {(v.noteCount ?? 0) === 1 ? "note" : "notes"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
