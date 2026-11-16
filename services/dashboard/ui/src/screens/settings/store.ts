// The Settings screen's state: the schema, each section's loaded values and edits, the restart list, the secret writes and
// the personality text. It lives outside the React tree (one per runtime) so edits and the restart banner survive moving
// between sections and screens, as the design requires (DASH-SET-006, DASH-SET-007), and so `beforeunload` can see them.
import { createStore, useStore, type Store } from "../../state/store";
import type { Api, ApiResult } from "../../state/api";
import type { Access } from "../../state/access";
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
  edits: Record<string, EditedKey>;
  /** The issues the last Check or Save answered with. */
  issues: Issue[];
  /** A save answered 409: the file changed since the section was loaded. */
  conflict: boolean;
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
  /** Whether `GET /services/control` said control is enabled; undefined until it answered. */
  control?: boolean;
  personality: PersonalityState;
}

export const PERSONALITY_CAP = 64 * 1024;
export const personalityBytes = (text: string): number => new TextEncoder().encode(text).length;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const blankSection = (): SectionState => ({ status: "loading", keys: {}, edits: {}, issues: [], conflict: false });
const detailOf = (r: Extract<ApiResult<unknown>, { ok: false }>): string => (r.status === 0 ? r.detail : `${r.status} ${r.detail}`);

export interface Settings {
  state: Store<SettingsState>;
  loadSchema(): Promise<void>;
  /** Reads a section. A section that holds edits is not read again (the edits belong to the values they were made on) unless `force`. */
  loadSection(path: string, force?: boolean): Promise<void>;
  loadControl(): Promise<void>;
  edit(section: string, key: string, value: unknown, error?: string): void;
  revert(section: string, key: string): void;
  discard(paths: string[]): void;
  /** Reload after a 409: reads the section again and drops its edits. */
  reload(path: string): Promise<void>;
  run(paths: string[], dryRun: boolean): Promise<void>;
  setSecrets(section: string, values: Record<string, string | null>, action: string): Promise<{ ok: true } | { ok: false; detail: string; paths?: string[] }>;
  restartUnits(): Promise<void>;
  dismissRestart(): void;
  loadPersonality(): Promise<void>;
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

export function createSettings(api: Api, access: Access, win: Pick<Window, "addEventListener" | "removeEventListener"> = window): Settings {
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
  async function readSection(path: string): Promise<boolean> {
    const r = await api.get<{ etag: string; keys: Record<string, KeyRead> }>(`/config/${encodeURIComponent(path)}`);
    if (r.ok && r.data && typeof r.data === "object" && r.data.keys) {
      patchSection(path, (s) => ({ ...s, status: "ready", error: undefined, etag: r.data.etag, keys: r.data.keys, edits: {}, issues: [], conflict: false }));
      return true;
    }
    const error = r.ok ? "The answer had an unexpected shape." : detailOf(r);
    patchSection(path, (s) => (s.status === "ready" ? s : { ...s, status: "error", error }));
    return false;
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
    async loadControl() {
      const r = await api.controlInfo();
      state.set((st) => ({ ...st, control: r.ok ? r.data.enabled : false }));
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
      for (const p of paths) { patchSection(p, (s) => ({ ...s, edits: {}, issues: [] })); setBar(p, { kind: "idle" }); }
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
      for (const path of todo) {
        const s = state.get().sections[path]!;
        const m = sectionModel(path);
        const values = changedValues(s, m);
        const sensitive = Object.keys(values).filter((k) => m?.keys.find((x) => x.key === k)?.sensitive).map((k) => `${path}.${k}`);
        const heldToken = access.getToken("control") !== undefined;
        const r = await api.put<{ etag?: string; restart?: string[]; warnings?: string[] }>(
          `/config/${encodeURIComponent(path)}${dryRun ? "?dryRun=1" : ""}`, { etag: s.etag, values },
          dryRun
            ? (heldToken ? { auth: "control", action: `Check ${m?.title ?? path} settings` } : {})
            : { auth: "control", action: sensitive.length ? `Change ${sensitive.join(", ")}` : `Save ${m?.title ?? path} settings`, requireToken: sensitive.length > 0 },
        );
        if (r.ok) {
          warnings.push(...(r.data?.warnings ?? []));
          if (dryRun) continue;
          restart.push(...(r.data?.restart ?? []));
          patchSection(path, (cur) => {
            const keys = { ...cur.keys };
            for (const [k, e] of Object.entries(cur.edits)) keys[k] = { ...keys[k], source: "literal", value: e.value };
            return { ...cur, keys, edits: {}, issues: [], conflict: false, etag: r.data?.etag ?? cur.etag };
          });
          continue;
        }
        if (r.status === 409) {
          patchSection(path, (cur) => ({ ...cur, conflict: true }));
          setBar(primary, { kind: "error", message: `${m?.title ?? path}: config.yaml changed since this section was loaded. Your edits are kept; reload to read the new file (this discards them).` });
          return;
        }
        if (r.status === 400 && r.data && typeof r.data === "object" && Array.isArray((r.data as { issues?: unknown }).issues)) {
          const issues = ((r.data as { issues: Issue[] }).issues).filter((i) => i && typeof i.message === "string").map((i) => ({ path: String(i.path ?? ""), message: i.message }));
          patchSection(path, (cur) => ({ ...cur, issues }));
          setBar(primary, { kind: "error", message: `${dryRun ? "Check" : "Save"} found ${issues.length} ${issues.length === 1 ? "problem" : "problems"}; ${m?.title ?? path} was not changed.` });
          return;
        }
        if (r.status === 0 && !dryRun) {
          // The answer was lost: read the section again and see whether the save happened (DASH-SET-012).
          const edited = state.get().sections[path]!.edits;
          await readSection(path);
          const after = state.get().sections[path]!;
          if (after.status === "ready" && Object.entries(edited).every(([k, e]) => same(after.keys[k]?.value, e.value))) {
            continue; // nothing to restart is known; the read shows the saved values
          }
          patchSection(path, (cur) => ({ ...cur, edits: edited }));
          setBar(primary, { kind: "error", message: `The save could not be confirmed: the dashboard did not answer (${r.detail}). Your edits are kept.` });
          return;
        }
        if (r.status === 403) access.markNotSetUp("control", true);
        setBar(primary, { kind: "error", message: r.locked ? r.detail : detailOf(r) });
        return;
      }
      if (!dryRun && restart.length > 0) addRestart(restart, warnings);
      setBar(primary, dryRun
        ? { kind: "ok", message: warnings.length ? "Check passed with warnings." : "Check passed: these edits are valid.", warnings }
        : { kind: "ok", message: "Saved.", warnings: restart.length > 0 ? [] : warnings });
    },
    async setSecrets(section, values, action) {
      const paths = Object.keys(values).map((k) => `${section}.${k}`);
      const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [`${section}.${k}`, v]));
      const r = paths.length === 1
        ? await api.put<{ set: boolean; restart: string[] }>(`/secrets/${encodeURIComponent(paths[0]!)}`, { value: Object.values(values)[0] }, { auth: "control", action, requireToken: true })
        : await api.put<{ set: Record<string, boolean>; restart: string[] }>("/secrets", { values: body }, { auth: "control", action, requireToken: true });
      if (!r.ok) {
        if (r.status === 403) access.markNotSetUp("control", true);
        const named = r.data && typeof r.data === "object" && Array.isArray((r.data as { paths?: unknown }).paths) ? (r.data as { paths: string[] }).paths : undefined;
        return { ok: false, detail: r.locked ? r.detail : detailOf(r), ...(named ? { paths: named } : {}) };
      }
      const setMap: Record<string, boolean> = typeof r.data.set === "boolean" ? { [paths[0]!]: r.data.set } : (r.data.set as Record<string, boolean>);
      patchSection(section, (cur) => {
        const keys = { ...cur.keys };
        for (const p of paths) { const k = p.slice(section.length + 1); keys[k] = { ...keys[k], secret: true, set: !!setMap[p] }; }
        return { ...cur, keys };
      });
      addRestart(r.data.restart ?? [], []);
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
    async loadPersonality() {
      const cur = state.get().personality;
      if (cur.status === "ready") return; // a loaded text, saved or not, is not replaced by a re-read
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
export function settingsFor(rt: { api: Api; access: Access }): Settings {
  let s = stores.get(rt);
  if (!s) { s = createSettings(rt.api, rt.access); stores.set(rt, s); }
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
