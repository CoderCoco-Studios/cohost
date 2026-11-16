import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../../app/providers";
import { INJECT_TARGET, RESULT_CACHE, RESULT_TIMEOUT_MS, resultStatus, type InjectKind, type InjectResult } from "./inject";

/** The timer functions the 10 s wait uses; injectable so a test advances them by hand. */
export interface Timers { set: (fn: () => void, ms: number) => number; clear: (id: number) => void }
export const BROWSER_TIMERS: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: (id) => window.clearTimeout(id) };

/** What the single status line shows: nothing, progress, a success, or a failure (an alert until dismissed or the next send). */
export type InjectStatus = { tone: "idle" } | { tone: "info" | "ok" | "bad"; text: string };
const IDLE: InjectStatus = { tone: "idle" };

/**
 * The test-input status line (DASH-UI-010): `track(id, kind)` follows a service-level injection until the `inject.result`
 * with that id arrives (one that arrived before the HTTP response is taken from a cache of the last 50) or 10 s pass with
 * none. Only the latest injection is followed; the timer is cleared on a result, on the next send and on unmount.
 */
// @spec DASH-UI-010
export function useInjectStatus(timers: Timers) {
  const { feed } = useRuntime();
  const [status, setStatus] = useState<InjectStatus>(IDLE);
  const results = useRef(new Map<string, InjectResult>());
  const waiting = useRef<{ id: string; timer: number } | null>(null);
  const timersRef = useRef(timers);
  timersRef.current = timers;

  const stopWaiting = useCallback(() => {
    if (waiting.current) timersRef.current.clear(waiting.current.timer);
    waiting.current = null;
  }, []);

  useEffect(() => feed.onEvent((ev) => {
    if (ev.type !== "inject.result") return;
    const d = ev.data as Partial<InjectResult>;
    if (typeof d.id !== "string") return;
    results.current.set(d.id, d as InjectResult);
    if (results.current.size > RESULT_CACHE) results.current.delete(results.current.keys().next().value as string);
    if (waiting.current?.id === d.id) { stopWaiting(); setStatus(resultStatus(d as InjectResult)); }
  }), [feed, stopWaiting]);

  useEffect(() => stopWaiting, [stopWaiting]);

  return {
    status,
    reset: useCallback(() => { stopWaiting(); setStatus(IDLE); }, [stopWaiting]),
    info: useCallback((text: string) => { stopWaiting(); setStatus({ tone: "info", text }); }, [stopWaiting]),
    ok: useCallback((text: string) => { stopWaiting(); setStatus({ tone: "ok", text }); }, [stopWaiting]),
    fail: useCallback((text: string) => { stopWaiting(); setStatus({ tone: "bad", text }); }, [stopWaiting]),
    track: useCallback((id: string, kind: InjectKind) => {
      stopWaiting();
      const cached = results.current.get(id);
      if (cached) { setStatus(resultStatus(cached)); return; }
      const target = INJECT_TARGET[kind];
      setStatus({ tone: "info", text: `sent to ${target}, waiting for result…` });
      const timer = timersRef.current.set(() => {
        waiting.current = null;
        setStatus({ tone: "bad", text: `no response from ${target} after ${RESULT_TIMEOUT_MS / 1000} s (is it running?)` });
      }, RESULT_TIMEOUT_MS);
      waiting.current = { id, timer };
    }, [stopWaiting]),
  };
}
