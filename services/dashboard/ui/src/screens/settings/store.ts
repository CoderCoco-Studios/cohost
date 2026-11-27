// The Settings screen's state: the schema, each section's loaded values and edits, the restart list, the secret writes and
// the personality text. It lives outside the React tree (one per runtime) so edits and the restart banner survive moving
// between sections and screens, as the design requires (DASH-SET-006, DASH-SET-007), and so `beforeunload` can see them.
import { createStore, useStore, type Store } from "../../state/store";
import type { Api, ApiResult } from "../../state/api";
import { useRuntime } from "../../app/providers";
import { parseSchema, matchIssue, type KeyRead, type SchemaModel, type SectionModel } from "./schemaModel";
import { toWire, validateKey } from "./validate";

export interface Issue { path: string; message: string }
export interface EditedKey { value: unknown; /** A message the control raised itself (text that is not JSON). */ error?: string }

export interface SectionState {
  status: "loading" | "ready" | "error";
  error?: string;
  etag?: string;
  keys: Record<string, KeyRead>;
  /** Dotted paths of keys the file holds under this section that the schema does not define (`unknown` of the read). */
  unknown: string[];
  edits: Record<string, EditedKey>;
  /** The issues the last Check or Save answered with. */
  issues: Issue[];
  /** The file changed since `etag` was read: a save answered 409, or the re-read after a lost answer showed another etag. */
  conflict: boolean;
  /** The file's etag when `conflict` was found; Discard takes it so the next save is not refused again. */
  currentEtag?: string;
}

export type BarState =
  | { kind: "idle" }
  | { kind: "busy"; what: "check" | "save" }
  | { kind: "ok"; message: string; warnings: string[] }
  | { kind: "error"; message: string };

export interface RestartState {
  units: string[];
  warnings: string[];
  running: boolean;
  /** The result of the last attempt per unit; a unit that restarted leaves the list. */
  results: Record<string, { ok: boolean; detail: string }>;
}

export type PersonalityState =
  | { status: "loading" | "error"; error?: string; loaded: ""; text: ""; saving: false; message?: undefined; failure?: undefined }
  | { status: "ready"; error?: undefined; loaded: string; text: string; saving: boolean; message?: string; failure?: string };

export interface SettingsState {
  schema: { status: "loading" | "ready" | "error"; error?: string; model?: SchemaModel };
  sections: Record<string, SectionState>;
  bars: Record<string, BarState>;
  restart: RestartState;
  personality: PersonalityState;
}

export const PERSONALITY_CAP = 64 * 1024;
export const personalityBytes = (text: string): number => new TextEncoder().encode(text).length;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/**
 * Whether a key as read holds `value`. "Not set" is written as an empty string, which the file's reader takes for no value at all:
 * it reads back as a literal with no `value` and a raw text of `""`.
 */
const holds = (read: KeyRead | undefined, value: unknown): boolean =>
  same(read?.value, value) || (value === "" && read?.source === "literal" && read.value === undefined && /^(""|'')$/.test(read.raw ?? ""));
const blankSection = (): SectionState => ({ status: "loading", keys: {}, unknown: [], edits: {}, issues: [], conflict: false });
const detailOf = (r: Extract<ApiResult<unknown>, { ok: false }>): string => (r.status === 0 ? r.detail : `${r.status} ${r.detail}`);

export interface Settings {
  state: Store<SettingsState>;
  loadSchema(): Promise<void>;
  /** Reads a section. A section that holds edits is not read again (the edits belong to the values they were made on) unless `force`. */
  loadSection(path: string, force?: boolean): Promise<void>;
  edit(section: string, key: string, value: unknown, error?: string): void;
  revert(section: string, key: string): void;
  discard(paths: string[]): void;
  /** Reload after a 409: reads the section again and drops its edits. */
  reload(path: string): Promise<void>;
  run(paths: string[], dryRun: boolean): Promise<void>;
  /** `offerRestart: false` keeps the units the write names out of the restart offer (a write that is part of a save that later fails). */
  setSecrets(section: string, values: Record<string, string | null>, action: string, options?: { offerRestart?: boolean }): Promise<{ ok: true } | { ok: false; detail: string; paths?: string[] }>;
  restartUnits(): Promise<void>;
  dismissRestart(): void;
  loadPersonality(force?: boolean): Promise<void>;
  setPersonalityText(text: string): void;
  savePersonality(): Promise<void>;
  /** Edits or personality text not yet saved. */
  dirty(): boolean;
  editCount(paths: string[]): number;
  dispose(): void;
}

/** The values a section's edits send: only the changed keys. */
export function changedValues(s: SectionState, model: SectionModel | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(s.edits)) out[k] = toWire(model?.keys.find((x) => x.key === k) ?? ({} as never), e.value);
  return out;
}

/** Whether every edit in a section passes validation and raised no error of its own. */
export function sectionValid(s: SectionState, model: SectionModel | undefined): boolean {
  return Object.entries(s.edits).every(([k, e]) => {
    if (e.error) return false;
    const km = model?.keys.find((x) => x.key === k);
    return !km || Object.keys(validateKey(km, e.value)).length === 0;
  });
}

// @spec DASH-SET-006, DASH-SET-011, DASH-SET-012, DASH-SET-031, DASH-SET-032, DASH-SET-033
export function createSettings(api: Api, win: Pick<Window, "addEventListener" | "removeEventListener"> = window): Settings {
  const state = createStore<SettingsState>({
    schema: { status: "loading" }, sections: {}, bars: {}, restart: { units: [], warnings: [], running: false, results: {} },
    personality: { status: "loading", loaded: "", text: "", saving: false },
  });
  const patchSection = (path: string, fn: (s: SectionState) => SectionState): void =>
    state.set((st) => ({ ...st, sections: { ...st.sections, [path]: fn(st.sections[path] ?? blankSection()) } }));
  const setBar = (path: string, bar: BarState): void => state.set((st) => ({ ...st, bars: { ...st.bars, [path]: bar } }));
  const addRestart = (units: string[], warnings: string[]): void => state.set((st) => ({
    ...st, restart: { ...st.restart, units: [...new Set([...st.restart.units, ...units])], warnings: [...new Set([...st.restart.warnings, ...warnings])] },
  }));
  const model = (): SchemaModel | undefined => state.get().schema.model;
  const sectionModel = (path: string): SectionModel | undefined => model()?.sections.find((s) => s.path === path);

  // Leaving the page with unsaved edits asks first (DASH-NAV-004). The listener exists only while something is unsaved.
  let guarding = false;
  const guard = (e: Event): void => { e.preventDefault(); (e as BeforeUnloadEvent).returnValue = ""; };
  const dirty = (): boolean => {
    const st = state.get();
    return Object.values(st.sections).some((s) => Object.keys(s.edits).length > 0) || (st.personality.status === "ready" && st.personality.text !== st.personality.loaded);
  };
  const syncGuard = (): void => {
    const d = dirty();
    if (d && !guarding) { win.addEventListener("beforeunload", guard); guarding = true; }
    else if (!d && guarding) { win.removeEventListener("beforeunload", guard); guarding = false; }
  };
  const unsubscribe = state.subscribe(syncGuard);

  /** Reads a section into the state; true when it answered. A failed read leaves earlier values on screen. */
  async function readSection(path: string, keepEdits = false): Promise<boolean> {
    const r = await api.get<{ etag: string; keys: Record<string, KeyRead>; unknown?: unknown }>(`/config/${encodeURIComponent(path)}`);
    if (r.ok && r.data && typeof r.data === "object" && r.data.keys) {
      patchSection(path, (s) => ({ ...s, status: "ready", error: undefined, etag: r.data.etag, keys: r.data.keys, unknown: Array.isArray(r.data.unknown) ? r.data.unknown.filter((u): u is string => typeof u === "string") : [], edits: keepEdits ? s.edits : {}, issues: [], conflict: false, currentEtag: undefined }));
      return true;
    }
    const error = r.ok ? "The answer had an unexpected shape." : detailOf(r);
    patchSection(path, (s) => (s.status === "ready" ? s : { ...s, status: "error", error }));
    return false;
  }

  /**
   * The etag belongs to the file, not to a section: a write changes it for every section. After `from` was replaced by `to`, a
   * loaded section that was consistent with `from` (it was read, or last written, at that file state) is consistent with `to` for
   * every key the write did not touch, so it takes `to`. A section whose etag is something else is stale and keeps it, so its own
   * save still answers 409. `to` must come from a write response: the etag of a re-read can include a write by someone else, which
   * a section holding the older etag has not seen.
   */
  function propagateEtag(from: string | undefined, to: string | undefined): void {
    if (!from || !to) return;
    state.set((st) => ({ ...st, sections: Object.fromEntries(Object.entries(st.sections).map(([p, sec]) => [p, sec.etag === from ? { ...sec, etag: to } : sec])) }));
  }

  /**
   * A write of `sent` (the edits the request carried) to `path` succeeded. The saved values come from what was sent. An edit is
   * cleared only while it still holds what was sent; a field changed while the request ran stays an unsaved edit, and one put back
   * to the old value (which `edit` had already dropped) becomes an edit again, because the file now holds the sent value.
   */
  function applySaved(path: string, sent: Record<string, EditedKey>, from: string | undefined, to: string | undefined): void {
    patchSection(path, (cur) => {
      const keys = { ...cur.keys };
      const edits = { ...cur.edits };
      for (const [k, e] of Object.entries(sent)) {
        const old = keys[k];
        keys[k] = { ...old, source: "literal", value: e.value };
        const now = edits[k];
        if (now === undefined) { if (old && "value" in old && !same(old.value, e.value)) edits[k] = { value: old.value }; }
        else if (!now.error && same(now.value, e.value)) delete edits[k];
      }
      return { ...cur, keys, edits, issues: [], conflict: false };
    });
    propagateEtag(from, to);
  }

  const self: Settings = {
    state,
    async loadSchema() {
      state.set((st) => ({ ...st, schema: { status: "loading" } }));
      const r = await api.get("/config/schema");
      if (!r.ok) { state.set((st) => ({ ...st, schema: { status: "error", error: detailOf(r) } })); return; }
      try { const m = parseSchema(r.data); state.set((st) => ({ ...st, schema: { status: "ready", model: m } })); }
      catch (e) { state.set((st) => ({ ...st, schema: { status: "error", error: (e as Error).message } })); }
    },
    async loadSection(path, force) {
      const cur = state.get().sections[path];
      if (!force && cur && Object.keys(cur.edits).length > 0) return;
      if (!cur) patchSection(path, (s) => s);
      else if (cur.status === "error") patchSection(path, (s) => ({ ...s, status: "loading", error: undefined }));
      await readSection(path);
    },
    edit(section, key, value, error) {
      patchSection(section, (s) => {
        const loaded = s.keys[key];
        const edits = { ...s.edits };
        if (!error && loaded && "value" in loaded && same(loaded.value, value)) delete edits[key];
        else edits[key] = error ? { value, error } : { value };
        return { ...s, edits, issues: s.issues.filter((i) => matchIssue(section, Object.keys(s.keys), i.path)?.key !== key), conflict: s.conflict };
      });
    },
    revert(section, key) { patchSection(section, (s) => { const edits = { ...s.edits }; delete edits[key]; return { ...s, edits }; }); },
    discard(paths) {
      for (const p of paths) {
        const conflicted = state.get().sections[p]?.conflict === true;
        // After a conflict the section's etag is the one the file has moved past: take the current one now, and read the values again.
        patchSection(p, (s) => ({ ...s, edits: {}, issues: [], ...(conflicted ? { conflict: false, etag: s.currentEtag ?? s.etag, currentEtag: undefined } : {}) }));
        setBar(p, { kind: "idle" });
        if (conflicted) void readSection(p);
      }
    },
    async reload(path) {
      setBar(path, { kind: "idle" });
      if (!(await readSection(path))) setBar(path, { kind: "error", message: `${sectionModel(path)?.title ?? path} could not be read again; your edits are kept.` });
    },
    async run(paths, dryRun) {
      const primary = paths[0]!;
      const todo = paths.filter((p) => Object.keys(state.get().sections[p]?.edits ?? {}).length > 0);
      if (todo.length === 0) return;
      setBar(primary, { kind: "busy", what: dryRun ? "check" : "save" });
      const warnings: string[] = [];
      const restart: string[] = [];
      const titleOf = (p: string): string => sectionModel(p)?.title ?? p;
      const saved: string[] = [];
      /** Ends the run on a failure: units of the sections already written still need their restart, and the bar names what was and was not saved. */
      const stop = (at: string, why: string, alone: string): void => {
        if (!dryRun && restart.length > 0) addRestart(restart, warnings);
        const unsaved = todo.slice(todo.indexOf(at));
        const parts = unsaved.map((p) => (p === at ? `${titleOf(p)} (${why})` : `${titleOf(p)} (not attempted)`));
        setBar(primary, { kind: "error", message: saved.length === 0 ? alone : `Saved: ${saved.map(titleOf).join(", ")}. Not saved: ${parts.join(", ")}. Your edits to ${unsaved.map(titleOf).join(", ")} are kept.` });
      };
      for (const path of todo) {
        const s = state.get().sections[path]!;
        const m = sectionModel(path);
        const sent = s.edits; // what this request carries; edits made while it is in flight are not part of it
        const values = changedValues(s, m);
        // A save is gated like every write, a sensitive key included; Check, a dry run, is never gated (DASH-SET-028).
        const r = await api.put<{ etag?: string; restart?: string[]; warnings?: string[] }>(
          `/config/${encodeURIComponent(path)}${dryRun ? "?dryRun=1" : ""}`, { etag: s.etag, values },
          dryRun ? {} : { auth: "control", action: `Save ${m?.title ?? path} settings` },
        );
        if (r.ok) {
          warnings.push(...(r.data?.warnings ?? []));
          if (dryRun) continue;
          restart.push(...(r.data?.restart ?? []));
          applySaved(path, sent, s.etag, r.data?.etag);
          saved.push(path);
          continue;
        }
        if (r.status === 409) {
          const current = r.data && typeof r.data === "object" && typeof (r.data as { etag?: unknown }).etag === "string" ? (r.data as { etag: string }).etag : undefined;
          patchSection(path, (cur) => ({ ...cur, conflict: true, currentEtag: current }));
          stop(path, `config.yaml changed since it was loaded; Reload re-reads it and discards your edits to ${titleOf(path)}`,
            `${titleOf(path)}: config.yaml changed since this section was loaded. Your edits are kept; reload to read the new file (this discards them).`);
          return;
        }
        if (r.status === 400 && r.data && typeof r.data === "object" && Array.isArray((r.data as { issues?: unknown }).issues)) {
          const issues = ((r.data as { issues: Issue[] }).issues).filter((i) => i && typeof i.message === "string").map((i) => ({ path: i.path ?? "", message: i.message }));
          patchSection(path, (cur) => ({ ...cur, issues }));
          const found = `${issues.length} ${issues.length === 1 ? "problem" : "problems"}`;
          stop(path, `${dryRun ? "check" : "save"} found ${found}`, `${dryRun ? "Check" : "Save"} found ${found}; ${titleOf(path)} was not changed.`);
          return;
        }
        if (r.status === 0 && !dryRun) {
          // The answer was lost: read the section again and see whether the save happened (DASH-SET-012).
          const ok = await readSection(path, true);
          const after = state.get().sections[path]!;
          if (ok && Object.entries(sent).every(([k, e]) => holds(after.keys[k], e.value))) {
            patchSection(path, (cur) => ({ ...cur, edits: Object.fromEntries(Object.entries(cur.edits).filter(([k, e]) => !holds(after.keys[k], e.value))) }));
            saved.push(path); // the section now holds the file's etag and values; no other section's etag is derived from a read
            continue; // nothing to restart is known; the read shows the saved values
          }
          // Not confirmed. The edits were made against the values and etag read before, so that etag stays: if the file has since
          // been changed by someone else, the next save is refused (409) instead of overwriting that change.
          const changed = ok && after.etag !== undefined && after.etag !== s.etag;
          patchSection(path, (cur) => ({ ...cur, etag: s.etag, ...(changed ? { conflict: true, currentEtag: after.etag } : {}) }));
          const held = ok
            ? `The file now holds ${Object.keys(sent).map((k) => `${m?.keys.find((x) => x.key === k)?.label ?? k}: ${after.keys[k] && "value" in after.keys[k]! ? JSON.stringify(after.keys[k]!.value) : "not set"}`).join("; ")}${changed ? ", and it changed since this section was loaded, so Save will be refused until you Reload (which discards your edits)" : ""}.`
            : "The file could not be read again to check.";
          stop(path, `the dashboard did not answer: ${r.detail}; whether it was written is unknown`,
            `The outcome of the save is unknown: the dashboard did not answer (${r.detail}). ${held} Your edits are kept.`);
          return;
        }
        stop(path, r.locked ? r.detail : detailOf(r), r.locked ? r.detail : detailOf(r));
        return;
      }
      if (!dryRun && restart.length > 0) addRestart(restart, warnings);
      setBar(primary, dryRun
        ? { kind: "ok", message: warnings.length ? "Check passed with warnings." : "Check passed: these edits are valid.", warnings }
        : { kind: "ok", message: "Saved.", warnings: restart.length > 0 ? [] : warnings });
    },
    async setSecrets(section, values, action, options) {
      const paths = Object.keys(values).map((k) => `${section}.${k}`);
      const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [`${section}.${k}`, v]));
      const r = paths.length === 1
        ? await api.put<{ set: boolean; restart: string[] }>(`/secrets/${encodeURIComponent(paths[0]!)}`, { value: Object.values(values)[0] }, { auth: "control", action })
        : await api.put<{ set: Record<string, boolean>; restart: string[] }>("/secrets", { values: body }, { auth: "control", action });
      if (!r.ok) {
        const named = r.data && typeof r.data === "object" && Array.isArray((r.data as { paths?: unknown }).paths) ? (r.data as { paths: string[] }).paths : undefined;
        return { ok: false, detail: r.locked ? r.detail : detailOf(r), ...(named ? { paths: named } : {}) };
      }
      const setMap: Record<string, boolean> = typeof r.data.set === "boolean" ? { [paths[0]!]: r.data.set } : (r.data.set as Record<string, boolean>);
      patchSection(section, (cur) => {
        const keys = { ...cur.keys };
        for (const p of paths) { const k = p.slice(section.length + 1); keys[k] = { ...keys[k], secret: true, set: !!setMap[p] }; }
        return { ...cur, keys };
      });
      if (options?.offerRestart !== false) addRestart(r.data.restart ?? [], []);
      return { ok: true };
    },
    async restartUnits() {
      const units = [...state.get().restart.units];
      state.set((st) => ({ ...st, restart: { ...st.restart, running: true } }));
      for (const id of units) {
        const r = await api.lifecycle(id, "restart", undefined, `Restart ${id}`);
        const result = r.ok ? { ok: true, detail: "restarted" } : { ok: false, detail: r.locked ? r.detail : (r.data && typeof r.data === "object" && typeof (r.data as { detail?: unknown }).detail === "string" ? `${r.status} ${(r.data as { detail: string }).detail}` : detailOf(r)) };
        state.set((st) => ({ ...st, restart: { ...st.restart, results: { ...st.restart.results, [id]: result }, units: result.ok ? st.restart.units.filter((u) => u !== id) : st.restart.units } }));
      }
      state.set((st) => ({ ...st, restart: { ...st.restart, running: false, warnings: st.restart.units.length === 0 ? [] : st.restart.warnings } }));
    },
    dismissRestart() { state.set((st) => ({ ...st, restart: { units: [], warnings: [], running: false, results: {} } })); },
    async loadPersonality(force) {
      const cur = state.get().personality;
      if (cur.status === "ready" && !force) return; // a loaded text, saved or not, is not replaced by a re-read
      state.set((st) => ({ ...st, personality: { status: "loading", loaded: "", text: "", saving: false } }));
      const r = await api.get<string>("/personality");
      if (!r.ok) { state.set((st) => ({ ...st, personality: { status: "error", error: detailOf(r), loaded: "", text: "", saving: false } })); return; }
      const text = typeof r.data === "string" ? r.data : "";
      state.set((st) => ({ ...st, personality: { status: "ready", loaded: text, text, saving: false } }));
    },
    setPersonalityText(text) {
      state.set((st) => st.personality.status === "ready" ? { ...st, personality: { ...st.personality, text, message: undefined, failure: undefined } } : st);
    },
    async savePersonality() {
      const p = state.get().personality;
      if (p.status !== "ready" || p.saving || personalityBytes(p.text) > PERSONALITY_CAP) return;
      const text = p.text;
      state.set((st) => st.personality.status === "ready" ? { ...st, personality: { ...st.personality, saving: true, message: undefined, failure: undefined } } : st);
      const r = await api.put("/personality", text, { auth: "control", action: "Save personality" });
      state.set((st) => {
        if (st.personality.status !== "ready") return st;
        return r.ok
          ? { ...st, personality: { ...st.personality, saving: false, loaded: text, message: "saved · brain reloaded" } }
          : { ...st, personality: { ...st.personality, saving: false, failure: r.locked ? r.detail : detailOf(r) } };
      });
    },
    dirty,
    editCount(paths) { const st = state.get(); return paths.reduce((n, p) => n + Object.keys(st.sections[p]?.edits ?? {}).length, 0); },
    dispose() { unsubscribe(); if (guarding) { win.removeEventListener("beforeunload", guard); guarding = false; } },
  };
  return self;
}

const stores = new WeakMap<object, Settings>();

/** The one Settings store of this runtime. */
export function settingsFor(rt: { api: Api }): Settings {
  let s = stores.get(rt);
  if (!s) { s = createSettings(rt.api); stores.set(rt, s); }
  return s;
}

/** Releases the store of a runtime (its `beforeunload` listener included); a test calls it. */
export function disposeSettings(rt: object): void { stores.get(rt)?.dispose(); stores.delete(rt); }

export function useSettings(): Settings { return settingsFor(useRuntime()); }

/** Reads a slice of the settings state. */
export function useSettingsState<S>(select: (s: SettingsState) => S): S {
  const { state } = useSettings();
  return useStore(state, select);
}
