import { tracked, type HeartbeatSpec } from "@cohost/shared";

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

// @spec EARS-HLTH-001, EARS-HLTH-002, EARS-HLTH-003, EARS-SRC-005, EARS-STUB-002
/**
 * ears: mode `off` with every dep n/a when no source is enabled; otherwise mode live (`mock` with the stub engine, whose
 * stt is n/a). One dep per enabled source named for it (`http`, `dir` or the connector tag, `discord` among them), `n/a`
 * for `discord`, `http` and `dir` when not enabled; a gap source is `down`, every other source follows `sourceStatus`.
 * `stt` is the last transcription, shared by all sources.
 */
export class EarsHealth {
  private stt: "ok" | "down" = "ok";
  constructor(
    private plan: EarsPlan,
    private stub = false,
    private sourceStatus: (name: string) => "ok" | "down" = () => "down",
  ) {}

  readonly spec: HeartbeatSpec = {
    service: "ears",
    mode: () => (this.plan.sources.length === 0 ? "off" : this.stub ? "mock" : "live"),
    deps: (): Record<string, "ok" | "down" | "n/a"> => {
      if (this.plan.sources.length === 0) return { discord: "n/a", stt: "n/a" };
      const deps: Record<string, "ok" | "down" | "n/a"> = { discord: "n/a", http: "n/a", dir: "n/a", stt: this.stub ? "n/a" : this.stt };
      for (const src of this.plan.sources) {
        deps[src.name] = src.gap !== undefined ? "down" : this.sourceStatus(src.name);
      }
      return deps;
    },
  };

  track<A extends unknown[]>(transcribe: (...a: A) => Promise<string>) {
    return tracked(transcribe, (ok) => { this.stt = ok ? "ok" : "down"; });
  }
}
