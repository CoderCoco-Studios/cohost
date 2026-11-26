import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../app/providers";
import type { ApiResult } from "./api";
import type { AccessState } from "./access";
import type { FeedState } from "./feed";
import { useStore } from "./store";

/** The api client: `const api = useApi(); await api.post("/control", ...)`. */
export const useApi = () => useRuntime().api;

/** The feed store, optionally narrowed with a selector: `const stack = useFeed((f) => f.stack)`. */
export function useFeed(): FeedState;
export function useFeed<S>(select: (f: FeedState) => S): S;
export function useFeed<S>(select?: (f: FeedState) => S): S | FeedState {
  const { feed } = useRuntime();
  return useStore(feed.state, (select ?? ((f: FeedState) => f)) as (f: FeedState) => S | FeedState);
}

/** Token state (never the token itself) and the access actions: `const { state, access } = useAccess()`. */
export function useAccess(): { state: AccessState; access: ReturnType<typeof useRuntime>["access"] } {
  const { access } = useRuntime();
  return { state: useStore(access.state), access };
}

/**
 * The page clock for "last seen" ages and elapsed times: advances every `intervalMs` while the live feed is open and
 * stops while it is closed, so ages stop counting when live updates stop (DASH-UI-001). Re-renders its caller each tick.
 */
export function useFeedClock(intervalMs = 1000): number {
  const { feed, now } = useRuntime();
  const open = useStore(feed.state, (s) => s.status === "open");
  const [t, setT] = useState(now());
  useEffect(() => {
    setT(now());
    if (!open) return;
    const id = window.setInterval(() => setT(now()), intervalMs);
    return () => window.clearInterval(id);
  }, [open, intervalMs, now]);
  return t;
}

/** The outcome of a state-changing request, shown beside the control that sent it (DASH-UI-015). */
export type ActionState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string; status: number; locked: boolean };

export interface Action {
  state: ActionState;
  /**
   * Runs a request and records its outcome: success is shown only after a 2xx answer; a non-2xx answer or a network
   * error becomes an error with the HTTP status and the server's `detail`, kept until dismissed or `run` is called again.
   * Resolves with the result so the caller can react (reload a list after a 2xx).
   */
  run<T>(request: () => Promise<ApiResult<T>>, success: string | ((data: T) => string)): Promise<ApiResult<T>>;
  dismiss: () => void;
}

/** One action's feedback state. Pair it with `<ActionStatus state={action.state} onDismiss={action.dismiss} />`. */
// @spec DASH-UI-015
export function useAction(): Action {
  const [state, setState] = useState<ActionState>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = useCallback(async <T,>(request: () => Promise<ApiResult<T>>, success: string | ((data: T) => string)) => {
    setState({ kind: "pending" });
    const r = await request();
    if (alive.current) {
      if (r.ok) setState({ kind: "ok", message: typeof success === "function" ? success(r.data) : success });
      else setState({ kind: "error", message: r.locked ? r.detail : r.status === 0 ? r.detail : `${r.status} ${r.detail}`, status: r.status, locked: !!r.locked });
    }
    return r;
  }, []);
  return { state, run, dismiss: useCallback(() => setState({ kind: "idle" }), []) };
}

/**
 * The co-host's mute state and its toggle (DASH-UI-005). `muted` follows the latest `mute` / `unmute` control event, live
 * or replayed; `pending` runs from the press until that event arrives or the request fails; `label` is the button text.
 */
// @spec DASH-UI-005
export function useMute() {
  const api = useApi();
  const muted = useFeed((f) => f.muted);
  const [pending, setPending] = useState<boolean | null>(null); // the muted value we are waiting to see
  const action = useAction();
  useEffect(() => { if (pending !== null && muted === pending) setPending(null); }, [muted, pending]);
  const toggle = useCallback(async () => {
    const target = !muted;
    setPending(target);
    const r = await action.run(() => api.control({ cmd: target ? "mute" : "unmute" }, target ? "Mute co-host" : "Unmute co-host"), target ? "Muted" : "Unmuted");
    if (!r.ok) setPending(null);
  }, [api, muted, action]);
  return { muted, pending: pending !== null, label: muted ? "Unmute co-host" : "Mute co-host", toggle, action };
}
