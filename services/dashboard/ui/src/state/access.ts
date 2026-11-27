import { createStore, type Store } from "./store";
import type { TokenKind } from "./types";

export type Scope = "tab" | "browser";

export interface TokenState {
  /** A token is held (in storage or memory). The value itself is never in the store's state. */
  present: boolean;
  scope: Scope | null;
}

/** A request waiting for a token: the Access dialog shows `action` and calls `resolvePrompt` when done. */
export interface Prompt {
  kind: TokenKind;
  /** What is waiting, in words: "Restart voice". */
  action: string;
  /** The server rejected the token the page held, so it was cleared (DASH-ACC-006). */
  rejected: boolean;
  resolve: (unlocked: boolean) => void;
}

export interface AccessState {
  control: TokenState;
  prompt: Prompt | null;
  /** The Access panel, opened by the header's Access button (DASH-ACC-001). */
  panelOpen: boolean;
  /** Storage threw, so a token lives in memory for the page's life only (DASH-ACC-007). */
  memoryOnly: boolean;
  /** This browser carries a session cookie from the unlock link, as `GET /services/control` last said (DASH-ACC-001, DASH-ACC-008). */
  unlocked: boolean;
}

export interface AccessDeps {
  /** `localStorage` ("this browser") and `sessionStorage` ("this tab"); undefined or throwing means unavailable. */
  local?: Storage;
  session?: Storage;
  /** Where `storage` events arrive (`window`). */
  events?: EventTarget;
}

const KEYS: Record<TokenKind, string> = { control: "cohost.controlToken" };
const none = (): TokenState => ({ present: false, scope: null });

export interface Access {
  state: Store<AccessState>;
  /** The token to send as `Authorization: Bearer`, or undefined. Never put it anywhere else (DASH-ACC-012). */
  getToken(kind: TokenKind): string | undefined;
  /** Stores a token that has been checked: in this tab's session storage or this browser's local storage; memory when storage throws. */
  setToken(kind: TokenKind, value: string, scope: Scope): void;
  /** Removes the token from both storages and memory. */
  lock(kind: TokenKind): void;
  /** Records whether this browser is unlocked by a session cookie (the `unlocked` of `GET /services/control`). */
  markUnlocked(unlocked: boolean): void;
  /**
   * Asks the operator for a token for a waiting action. Resolves true once it is unlocked, false on Cancel. One prompt is
   * open at a time; requests waiting for the token share it.
   */
  ask(kind: TokenKind, action: string, opts?: { rejected?: boolean }): Promise<boolean>;
  /** Called by the Access dialog: true after it stored a checked token, false on Cancel. */
  resolvePrompt(unlocked: boolean): void;
  openPanel(): void;
  closePanel(): void;
}

/**
 * Token storage and the single "this request needs a token" mechanism (DASH-UI-006, DASH-ACC-002, DASH-ACC-007). The
 * Access dialog and panel are views over this store; the `api` module is its only caller of `getToken` and `ask`.
 */
// @spec DASH-UI-006, DASH-ACC-002, DASH-ACC-007, DASH-ACC-012
export function createAccess(deps: AccessDeps = {}): Access {
  const memory: Partial<Record<TokenKind, string>> = {};
  const area = (s: Scope): Storage | undefined => (s === "tab" ? deps.session : deps.local);
  const read = (s: Scope, kind: TokenKind): string | undefined => { try { return area(s)?.getItem(KEYS[kind]) ?? undefined; } catch { return undefined; } };
  const write = (s: Scope, kind: TokenKind, v: string): boolean => { try { const a = area(s); if (!a) return false; a.setItem(KEYS[kind], v); return true; } catch { return false; } };
  const erase = (s: Scope, kind: TokenKind): void => { try { area(s)?.removeItem(KEYS[kind]); } catch { /* unavailable: nothing to erase */ } };

  const scopeOf = (kind: TokenKind): Scope | null => (read("browser", kind) ? "browser" : read("tab", kind) ? "tab" : null);
  const present = (kind: TokenKind): TokenState => {
    const scope = scopeOf(kind);
    if (scope) return { present: true, scope };
    return memory[kind] ? { present: true, scope: "tab" } : none();
  };
  const state = createStore<AccessState>({ control: present("control"), prompt: null, panelOpen: false, memoryOnly: false, unlocked: false });
  const refresh = (kind: TokenKind): void => state.set((s) => ({ ...s, [kind]: present(kind) }));
  deps.events?.addEventListener("storage", (e) => {
    const key = (e as Event & { key: string | null }).key;
    for (const kind of ["control"] as const) if (key === null || key === KEYS[kind]) refresh(kind);
  });

  /** The promise the requests waiting on the open prompt share. */
  const open = new Map<TokenKind, Promise<boolean>>();

  return {
    state,
    getToken: (kind) => read("browser", kind) ?? read("tab", kind) ?? memory[kind],
    setToken(kind, value, scope) {
      delete memory[kind];
      erase(scope === "tab" ? "browser" : "tab", kind);
      if (!write(scope, kind, value)) {
        memory[kind] = value;
        state.set((s) => ({ ...s, memoryOnly: true }));
      }
      state.set((s) => ({ ...s, [kind]: { present: true, scope } }));
    },
    lock(kind) {
      delete memory[kind];
      erase("tab", kind); erase("browser", kind);
      state.set((s) => ({ ...s, [kind]: none() }));
    },
    markUnlocked: (unlocked) => state.set((s) => (s.unlocked === unlocked ? s : { ...s, unlocked })),
    ask(kind, action, opts = {}) {
      const shared = open.get(kind);
      if (shared) return shared;
      const p = new Promise<boolean>((resolve) => {
        const prompt: Prompt = { kind, action, rejected: !!opts.rejected, resolve };
        state.set((s) => ({ ...s, prompt }));
      });
      open.set(kind, p);
      return p;
    },
    resolvePrompt(unlocked) {
      const p = state.get().prompt;
      if (!p) return;
      open.delete(p.kind);
      state.set((s) => ({ ...s, prompt: null }));
      p.resolve(unlocked);
    },
    openPanel: () => state.set((s) => ({ ...s, panelOpen: true })),
    closePanel: () => state.set((s) => ({ ...s, panelOpen: false })),
  };
}
