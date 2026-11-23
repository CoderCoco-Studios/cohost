import { tracked, type HeartbeatSpec } from "@cohost/shared";
import type { BuiltEngines } from "./engines.js";

/** One enabled listening source in the plan. `gap` is set when it cannot run for lack of configuration. */
export interface PlannedSource {
  name: string;
  kind: "http" | "dir" | "connector";
  gap?: string;
}

/** The set of sources to start (`sources`) and the ones among them that can run (`runnable`); empty `sources` is `off`. */
export interface EarsPlan {
  sources: PlannedSource[];
  runnable: PlannedSource[];
}

/** What `deps.stt` reports about the speech-to-text engines (EARS-HLTH-003..012), fixed at start-up. */
export interface SttInfo {
  /** The selected engine's name. */
  engine: string;
  /** The host the selected engine talks to (EARS-HLTH-009). */
  host: string;
  /** Whether the selected engine is streaming; its batch fallback is then the one that transcribes while it is down. */
  streaming: boolean;
  /** The batch engine of EARS-ENG-003, when there is one. */
  fallback?: string;
  /** A configuration gap (EARS-ENG-010): `deps.stt` is down with this text. */
  gap?: string;
  /** Whether the selected engine has a readiness probe (EARS-HLTH-008). */
  probes: boolean;
}

export function sttInfoOf(built: BuiltEngines): SttInfo {
  const streaming = built.selected.kind === "streaming";
  return {
    engine: built.selected.name,
    host: built.host,
    streaming,
    ...(streaming && built.batch ? { fallback: built.batch.name } : {}),
    ...(built.gap ? { gap: built.gap } : {}),
    probes: built.selected.kind === "streaming" && built.selected.ping !== undefined,
  };
}

// @spec EARS-SRC-003, EARS-SRC-001, EARS-START-004, EARS-CAP-004
/**
 * Pure decision for what ears starts: one entry per distinct source name. A `dir` source without a path is a gap; any
 * name other than `http` and `dir` is a connector tag (`discord` among them) and always runnable, because a connector
 * that is not present is a dependency `down`, not a gap. Never exits for a configuration gap.
 */
export function earsPlan(sources: readonly string[], hasDirPath: boolean): EarsPlan {
  const planned = [...new Set(sources)].map((name): PlannedSource => {
    if (name === "http") return { name, kind: "http" };
    if (name === "dir") return hasDirPath ? { name, kind: "dir" } : { name, kind: "dir", gap: "ears.dir.path is not set" };
    return { name, kind: "connector" };
  });
  return { sources: planned, runnable: planned.filter((x) => x.gap === undefined) };
}

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003, EARS-HLTH-004, EARS-HLTH-005, EARS-HLTH-006, EARS-HLTH-007, EARS-HLTH-008, EARS-HLTH-009, EARS-SRC-005, EARS-STUB-002
/**
 * ears: mode `off` with every dep n/a when no source is enabled; otherwise mode live (`mock` with the stub engine, whose
 * stt is n/a). One dep per enabled source named for it (`http`, `dir` or the connector tag, `discord` among them), `n/a`
 * for `discord`, `http` and `dir` when not enabled; a gap source is `down`, every other source follows `sourceStatus`.
 * `stt` follows the selected speech-to-text engine: down while it is in outage (or has a configuration gap), and while
 * it runs on its batch fallback. Its state is changed by the router (`selectedOk`, `selectedDown`, ...).
 */
export class EarsHealth {
  /** The reason the selected engine is down, while it is. */
  private selDown: string | undefined;
  /** The fallback's failure while the selected engine is down (EARS-HLTH-007). */
  private fbFail: string | undefined;
  /** Called after every change of `deps.stt`, so the heartbeat detail follows at once. */
  changed: (() => void) | undefined;

  constructor(
    private plan: EarsPlan,
    private stub = false,
    private sourceStatus: (name: string) => "ok" | "down" = () => "down",
    private info?: SttInfo,
  ) {
    if (info?.probes && info.gap === undefined) this.selDown = "awaiting first ping";
  }

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.plan.sources.length === 0 ? "off" : this.stub ? "mock" : "live"),
    deps: (): Record<string, "ok" | "down" | "n/a"> => {
      if (this.plan.sources.length === 0) return { discord: "n/a", stt: "n/a" };
      const deps: Record<string, "ok" | "down" | "n/a"> = { discord: "n/a", http: "n/a", dir: "n/a", stt: this.stub ? "n/a" : this.sttDown() ? "down" : "ok" };
      for (const src of this.plan.sources) {
        deps[src.name] = src.gap !== undefined ? "down" : this.sourceStatus(src.name);
      }
      return deps;
    },
  };

  /** `down` while the selected engine is in outage, its configuration has a gap, or it awaits its first ping. */
  sttDown(): boolean {
    return this.sttDetail() !== undefined;
  }

  /** The text of why `deps.stt` is down, or undefined when it is ok (EARS-HLTH-005..007, EARS-ENG-010). */
  sttDetail(): string | undefined {
    const i = this.info;
    if (this.stub || this.selDown === undefined && i?.gap === undefined) return undefined;
    if (!i) return this.selDown;
    if (i.gap !== undefined) return i.gap;
    if (this.selDown === undefined) return undefined;
    if (!i.streaming) return `${i.engine} unavailable: ${this.selDown}`;
    const tail = i.fallback !== undefined ? `transcribing with ${i.fallback}` : "no fallback engine, utterances dropped";
    const failed = this.fbFail !== undefined && i.fallback !== undefined ? `; fallback ${i.fallback} failed: ${this.fbFail}` : "";
    return `${i.engine} unavailable: ${this.selDown}; ${tail}${failed}`;
  }

  /** The selected engine and the host it talks to (EARS-HLTH-009). */
  sttSummary(): string | undefined {
    return this.info ? `${this.info.engine} at ${this.info.host}` : undefined;
  }

  /** The selected engine (or, for a batch selection, the batch engine) answered: `deps.stt` back to ok (EARS-HLTH-003, 011). */
  selectedOk(): void {
    if (this.selDown === undefined) return;
    this.selDown = undefined;
    this.fbFail = undefined;
    this.changed?.();
  }

  /** The selected engine is in outage (EARS-HLTH-003). */
  selectedDown(reason: string): void {
    this.selDown = reason;
    this.changed?.();
  }

  /** The fallback answered while the selected engine is down: `deps.stt` stays down (EARS-HLTH-005). */
  fallbackOk(): void {
    if (this.fbFail === undefined) return;
    this.fbFail = undefined;
    this.changed?.();
  }

  /** The fallback failed; recorded in the detail only while the selected engine is down (EARS-HLTH-007). */
  fallbackFailed(reason: string): void {
    if (this.selDown === undefined) return;
    this.fbFail = reason;
    this.changed?.();
  }

  /** Wraps a batch call of a batch-selected engine: its outcome sets `deps.stt`. */
  track<A extends unknown[]>(transcribe: (...a: A) => Promise<string>) {
    return tracked(transcribe, (ok) => { if (ok) this.selectedOk(); else this.selectedDown("the last call failed"); });
  }
}
