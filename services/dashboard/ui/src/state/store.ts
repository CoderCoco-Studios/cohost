import { useSyncExternalStore } from "react";

/**
 * A small external store: one value, replaced immutably, read in React with `useStore` (`useSyncExternalStore`).
 * Every store in `state/` is one of these, so a screen reads state with a selector and re-renders only when the
 * selected slice changes.
 */
export interface Store<T> {
  get(): T;
  /** Replaces the value (or patches it with a function of the current one) and notifies subscribers when it changed. */
  set(next: T | ((prev: T) => T)): void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === "function" ? (next as (prev: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/**
 * Reads a slice of a store; the component re-renders when the selected value changes (compared with `Object.is`). The
 * selector must return a stable value (a primitive, or a reference already in the state), never a freshly built object or
 * array: select the pieces separately and combine them in the component.
 */
export function useStore<T, S = T>(store: Store<T>, select: (value: T) => S = (v) => v as unknown as S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}
