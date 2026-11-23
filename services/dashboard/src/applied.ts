import type { Logger } from "@cohost/config";
import { sameModel } from "./models.js";

/** A one-at-a-time lock: each run starts after the previous one has settled (DASH-AVR-028). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** A stored model that loads (listed without an `error`), with its version (DASH-MDL-004). */
export interface Loadable { name: string; version: string }

/** The `renderer` section's values the applied view takes (DASH-AVR-023, DASH-AVR-024). */
export interface Framing { model: string; zoom: number; offset_y: number; turn: number }

/** The applied view: what the renderer shows now (DASH-AVR-023 to DASH-AVR-029). */
export interface Applied {
  /** The applied model's stored name and version, or null when none is applied. */
  model: { name: string; version: string } | null;
  /** The `renderer.model` name the file held at the last start or successful save, kept for the settings note. */
  configuredModel: string;
  zoom: number;
  offsetY: number;
  turn: number;
}

/** The model a selection names among the loadable ones, without regard to ASCII case. */
export const resolveLoadable = (models: readonly Loadable[], name: string): Loadable | undefined => models.find((m) => sameModel(m.name, name));

/** The issue a save of `model` raises, or undefined when it is blank or names a loadable stored model (DASH-MDL-037). */
// @spec DASH-MDL-037
export function modelIssue(models: readonly Loadable[], model: string): string | undefined {
  if (model === "" || resolveLoadable(models, model)) return undefined;
  return `renderer.model must be empty or the name of a stored model that loads; ${model} is not one`;
}

/** The applied view: one record, set at start and after each successful save of `renderer` (DASH-AVR-023, DASH-AVR-024). */
export class AppliedView {
  /** Held across upload commit, delete and the check and apply of a save (DASH-AVR-028). */
  readonly lock = new Mutex();
  private state: Applied = { model: null, configuredModel: "", zoom: 1, offsetY: 0, turn: 0 };
  private readonly listeners = new Set<(s: Applied) => void>();

  constructor(private readonly log?: Pick<Logger, "warn">) {}

  get(): Applied {
    return { ...this.state, model: this.state.model && { ...this.state.model } };
  }

  /** Calls `fn` with the view after each change (the relay's hook, DASH-AVR-021). */
  onChange(fn: (s: Applied) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sets the view at start from `renderer.*`; a `renderer.model` naming no loadable model logs a warning (DASH-AVR-023). */
  // @spec DASH-AVR-023
  start(f: Framing, models: readonly Loadable[]): void {
    const model = f.model === "" ? undefined : resolveLoadable(models, f.model);
    if (f.model !== "" && !model) this.log?.warn({ key: "renderer.model", model: f.model }, "renderer.model names no stored model that loads: the renderer shows no model");
    this.apply(f, models);
  }

  /** Sets the view from a saved `renderer` section, before the save answers (DASH-AVR-024). */
  // @spec DASH-AVR-024
  apply(f: Framing, models: readonly Loadable[]): void {
    const model = f.model === "" ? undefined : resolveLoadable(models, f.model);
    this.set({ model: model ? { name: model.name, version: model.version } : null, configuredModel: f.model, zoom: f.zoom, offsetY: f.offset_y, turn: f.turn });
  }

  /** After an upload replaced a file: the applied model's version follows the new file (DASH-AVR-027). */
  // @spec DASH-AVR-027
  refresh(models: readonly Loadable[]): void {
    const cur = this.state.model;
    if (!cur) return;
    const m = resolveLoadable(models, cur.name);
    if (m && m.version !== cur.version) this.set({ ...this.state, model: { name: m.name, version: m.version } });
  }

  private set(next: Applied): void {
    this.state = next;
    const snap = this.get();
    for (const fn of this.listeners) fn(snap);
  }
}
