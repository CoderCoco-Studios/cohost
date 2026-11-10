import { findService, SERVICE_MANIFEST, type ServiceDef, type StartMode } from "./manifest.js";
import type { Runtime, RuntimeResult, StartOptions } from "./runtime.js";

export type LifecycleAction = "start" | "stop" | "restart";

/** Why a request was refused before anything ran. */
export type Refusal = "unknown" | "conflict" | "forbidden";

export interface ControlResult extends RuntimeResult {
  /** Set when the request was refused (404 / 409 / 403) and nothing was executed. */
  refused?: Refusal;
}

export interface ActionOptions {
  mode?: StartMode;
  /** Start with the service's isolation presets (add-isolated-backends env vars). */
  isolated?: boolean;
}

export interface LifecycleRecord { service: string; action: LifecycleAction; by: string; ok: boolean; detail?: string }

/** Resets one consumer group to `$` (creating it if missing). `Bus` satisfies this. */
export interface GroupResetter { resetGroup(group: string): Promise<void> }

export interface ControllerOptions {
  runtime: Runtime;
  groups: GroupResetter;
  /** `dashboard` or `cohostctl`; recorded in the audit event. */
  by: string;
  /** Called after every executed attempt (publishes `service.lifecycle`). Errors are swallowed. */
  audit?: (rec: LifecycleRecord) => void | Promise<void>;
  /** CONTROL_ADVANCED: allow infra (redis, postgres) mutations. */
  advanced?: boolean;
  manifest?: readonly ServiceDef[];
}

/** Resets every group; stops at the first failure. */
export async function resetConsumerGroups(r: GroupResetter, groups: readonly string[]): Promise<RuntimeResult> {
  try {
    for (const g of groups) await r.resetGroup(g);
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `consumer group reset failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Applies the safety guards (manifest-only ids, infra) and the resume/fresh orchestration
 * (stop, reset groups, start) on top of a Runtime. UI-agnostic: the dashboard and cohostctl share it.
 */
export class ServiceController {
  private manifest: readonly ServiceDef[];
  constructor(private o: ControllerOptions) {
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
  }

  start(id: string, opts: ActionOptions = {}) { return this.act("start", id, opts); }
  stop(id: string) { return this.act("stop", id, {}); }
  restart(id: string, opts: ActionOptions = {}) { return this.act("restart", id, opts); }

  // @spec CTRL-GUARD-001, CTRL-GUARD-003
  private guard(action: LifecycleAction, id: string): { def: ServiceDef } | { refusal: ControlResult } {
    const def = findService(id, this.manifest);
    if (!def) return { refusal: { ok: false, refused: "unknown", detail: "unknown service" } };
    if (def.infra && !this.o.advanced) return { refusal: { ok: false, refused: "forbidden", detail: `${id} is infrastructure; set CONTROL_ADVANCED=1 to control it` } };
    return { def };
  }

  // @spec CTRL-GUARD-004, CTRL-GUARD-005, CTRL-GUARD-006, CTRL-GUARD-007, CTRL-GUARD-008
  private async act(action: LifecycleAction, id: string, a: ActionOptions): Promise<ControlResult> {
    const g = this.guard(action, id);
    if ("refusal" in g) return g.refusal;
    const { def } = g;
    const mode = def.infra ? "resume" : a.mode ?? def.defaultMode;
    const start: StartOptions = {
      env: a.isolated && !def.infra ? { ...def.isolatedEnv } : undefined,
    };
    const fresh = mode === "fresh" && def.groups.length > 0;
    let res: RuntimeResult;
    if (action === "stop") {
      res = await this.o.runtime.stop(def.id);
    } else if (action === "start") {
      const closure = a.isolated && !def.infra ? await this.startRequired(def) : { ok: true };
      // The named unit is not executed when a required unit failed, so it gets no audit record of its own.
      if (!closure.ok) return { ok: false, ...(closure.detail ? { detail: closure.detail } : {}) };
      res = fresh ? await this.resetThen(def, () => this.o.runtime.start(def.id, start)) : await this.o.runtime.start(def.id, start);
    } else if (!fresh && !start.env) {
      res = await this.o.runtime.restart(def.id, start);
    } else {
      // stop -> reset (only after stop resolved) -> start
      res = await this.o.runtime.stop(def.id);
      if (res.ok) res = fresh ? await this.resetThen(def, () => this.o.runtime.start(def.id, start)) : await this.o.runtime.start(def.id, start);
    }
    try {
      await this.o.audit?.({ service: def.id, action, by: this.o.by, ok: res.ok, ...(res.detail ? { detail: res.detail } : {}) });
    } catch { /* the audit is best effort (e.g. bus down while stopping redis) */ }
    return { ok: res.ok, ...(res.detail ? { detail: res.detail } : {}) };
  }

  /**
   * Starts the units `def` requires, transitively and depth-first in `requires` order (each once),
   * each isolated and in its own default mode, each audited as its own start. Stops at the first failure.
   */
  private async startRequired(def: ServiceDef): Promise<RuntimeResult> {
    const seen = new Set<string>([def.id]);
    const visit = async (d: ServiceDef): Promise<RuntimeResult> => {
      for (const rid of d.requires ?? []) {
        if (seen.has(rid)) continue;
        seen.add(rid);
        const r = findService(rid, this.manifest);
        if (!r) return { ok: false, detail: `required unit ${rid} is not in the manifest` };
        const sub = await visit(r);
        if (!sub.ok) return sub;
        const res = await this.runRequiredStart(r);
        if (!res.ok) return { ok: false, detail: `required unit ${rid} failed to start${res.detail ? `: ${res.detail}` : ""}` };
      }
      return { ok: true };
    };
    return visit(def);
  }

  private async runRequiredStart(r: ServiceDef): Promise<RuntimeResult> {
    const opts: StartOptions = { env: r.infra ? undefined : { ...r.isolatedEnv } };
    const run = () => this.o.runtime.start(r.id, opts);
    const res = r.defaultMode === "fresh" && r.groups.length > 0 && !r.infra ? await this.resetThen(r, run) : await run();
    try {
      await this.o.audit?.({ service: r.id, action: "start", by: this.o.by, ok: res.ok, ...(res.detail ? { detail: res.detail } : {}) });
    } catch { /* the audit is best effort */ }
    return res;
  }

  private async resetThen(def: ServiceDef, run: () => Promise<RuntimeResult>): Promise<RuntimeResult> {
    const reset = await resetConsumerGroups(this.o.groups, def.groups);
    return reset.ok ? run() : reset;
  }
}
