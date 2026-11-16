import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiResult } from "../../state/api";
import { useAccess, useApi } from "../../state/hooks";
import { figuresFrom, type MemoryFigures } from "./memory";
import type { ViewerDetailData, ViewerSummary } from "./types";

export interface Load<T> {
  /** `locked`: the operator cancelled the Access dialog or locked the page. `notSetUp`: the server has no viewers token (403). */
  status: "loading" | "ready" | "error" | "locked" | "notSetUp";
  /** The last good answer; kept while a later load fails (DASH-VIEWERS-017). */
  data?: T;
  error?: string;
}

export const SEARCH_DEBOUNCE_MS = 200;
const describe = (r: Extract<ApiResult<unknown>, { ok: false }>): string => (r.status === 0 || r.locked ? r.detail : `${r.status} ${r.detail}`);
const enc = encodeURIComponent;

/**
 * The Viewers screen's data: the list (searched, debounced, superseded answers ignored), the selected viewer's panel and
 * the `brain.memory` figures. Every request is gated by the viewers token through the api client's Access flow: a 401 opens
 * the dialog and retries once; a cancel or a Lock leaves the screen locked; a 403 means the server has no token
 * (DASH-VIEWERS-010, -016, -017, -022, -023).
 */
// @spec DASH-VIEWERS-010, DASH-VIEWERS-016, DASH-VIEWERS-017, DASH-VIEWERS-022
export function useViewers() {
  const api = useApi();
  const { state: tokens, access } = useAccess();
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [list, setList] = useState<Load<ViewerSummary[]>>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Load<ViewerDetailData>>({ status: "loading" });
  const [figures, setFigures] = useState<MemoryFigures | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0), detailSeq = useRef(0), inflight = useRef(0), alive = useRef(true);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadList = useCallback(async (q: string) => {
    const mine = ++seq.current;
    inflight.current++;
    const r = await api.get<{ viewers?: ViewerSummary[] }>(q ? `/viewers?q=${enc(q)}` : "/viewers", { auth: "viewers", action: "Load viewers" });
    inflight.current--;
    if (!alive.current || mine !== seq.current) return; // a newer search superseded this answer
    if (r.ok) { access.markNotSetUp("viewers", false); setList({ status: "ready", data: r.data?.viewers ?? [] }); }
    else if (r.locked) setList({ status: "locked" });
    else if (r.status === 403) { access.markNotSetUp("viewers", true); setList({ status: "notSetUp", error: r.detail }); }
    else setList((prev) => ({ status: "error", data: prev.data, error: `Could not load viewers: ${describe(r)}` }));
  }, [api, access]);

  const loadDetail = useCallback(async (key: string, fresh: boolean) => {
    const mine = ++detailSeq.current;
    if (fresh) setDetail({ status: "loading" });
    inflight.current++;
    const r = await api.get<ViewerDetailData>(`/viewers/${enc(key)}`, { auth: "viewers", action: "Load a viewer" });
    inflight.current--;
    if (!alive.current || mine !== detailSeq.current) return;
    if (r.ok) setDetail({ status: "ready", data: r.data });
    else setDetail((prev) => ({ status: "error", data: fresh ? undefined : prev.data, error: `Could not load this viewer: ${describe(r)}` }));
  }, [api]);

  // The search box: reload 200 ms after typing stops.
  useEffect(() => {
    const q = query.trim();
    if (q === applied) return;
    const t = window.setTimeout(() => setApplied(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, applied]);
  useEffect(() => { void loadList(applied); }, [applied, tick, loadList]);

  // `brain.memory` figures for the strength explainer; a failed read leaves them out (DASH-VIEWERS-022).
  useEffect(() => {
    let live = true;
    void api.get("/config/brain.memory").then((r) => { if (live) setFigures(r.ok ? figuresFrom(r.data) : null); });
    return () => { live = false; };
  }, [api]);

  // Lock (from the Access panel) empties the screen without asking again; unlocking elsewhere loads it. A token the server
  // rejected mid-request is handled by that request itself, so nothing happens here while one is in flight.
  const present = tokens.viewers.present;
  const prevPresent = useRef(present);
  useEffect(() => {
    if (prevPresent.current === present) return;
    prevPresent.current = present;
    if (inflight.current > 0) return;
    if (present) setTick((t) => t + 1);
    else { seq.current++; detailSeq.current++; setList({ status: "locked" }); setSelected(null); setDetail({ status: "loading" }); }
  }, [present]);

  const select = useCallback((key: string) => { setSelected(key); void loadDetail(key, true); }, [loadDetail]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  /** After a change to a viewer: reload its panel and the list (the counts and badges moved). */
  const changed = useCallback(async () => {
    const key = selectedRef.current;
    await Promise.all([key !== null ? loadDetail(key, false) : Promise.resolve(), loadList(appliedRef.current)]);
  }, [loadDetail, loadList]);
  /** After a voice viewer was linked: its notes moved, so show the chat viewer that received them. */
  const linked = useCallback(async (targetKey?: string) => {
    if (targetKey) select(targetKey); else { detailSeq.current++; setSelected(null); }
    await loadList(appliedRef.current);
  }, [select, loadList]);

  return {
    query, setQuery, applied, list, selected, detail, figures, select, reload, changed, linked,
    retryDetail: () => { if (selected !== null) void loadDetail(selected, false); },
    back: () => { detailSeq.current++; setSelected(null); },
    refreshList: () => loadList(applied),
  };
}
