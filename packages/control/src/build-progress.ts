/**
 * The parser of `docker compose --progress plain` output: BuildKit's numbered build vertices (`#7 [voice 3/8] RUN ...`,
 * `#7 CACHED`, `#7 DONE 3.2s`, `#7 ERROR: ...`) and Compose's container lines (`Container cohost-redis-1  Recreated`).
 * Pure: it holds what the lines said and nothing else. A line it does not recognise changes nothing.
 */

export type BuildRowState = "building" | "cached" | "built" | "failed";

/** One Compose service's build. */
export interface BuildRow {
  service: string;
  state: BuildRowState;
  /** The latest numbered step started, and the step count of its stage. */
  step?: number;
  of?: number;
  /** Every stage's step count, summed. */
  total: number;
  /** Numbered steps finished (cached or done), and how many of them were cache hits. */
  done: number;
  cached: number;
  /** The latest step's text, cut to 120 characters. */
  current?: string;
}

export interface BuildFailure {
  /** The service whose step failed; absent when the failing vertex belongs to no service. */
  service?: string;
  lines: string[];
}

interface Row {
  service: string;
  failed: boolean;
  built: boolean;
  step?: number;
  of?: number;
  current?: string;
  stages: Map<string, number>;
  done: Set<number>;
  cached: Set<number>;
  numbered: Set<number>;
}

const HEADER = /^#(\d+) \[([^\]]+)\] ?(.*)$/;
const VERTEX = /^#(\d+) (.*)$/;
const STEP = /^(\d+)\/(\d+)$/;
const OUTPUT = /^\d+(?:\.\d+)? (.*)$/;
const CONTAINER = /^\s*(?:\S\s+)?Container (\S+)\s+\S/;
const BUILT = /^\s*(?:\S\s+)?(?:Service\s+|Image\s+)?(\S+)\s+Built\s*$/;
const ERROR_LINES = 10;
const TEXT_MAX = 120;

/** The Compose service a container name belongs to: the service itself, or `<project>-<service>-<n>`. */
export function containerService(name: string, services: readonly string[]): string | undefined {
  if (services.includes(name)) return name;
  const base = /^(.+)-\d+$/.exec(name)?.[1];
  if (base === undefined) return undefined;
  // The longest matching service wins, so `connector-discord` is not read as `discord`.
  return services.filter((s) => base === s || base.endsWith(`-${s}`)).toSorted((a, b) => b.length - a.length)[0];
}

/** Collects the lines of `docker compose --progress plain up --build` into per-service rows, a failure and the touched containers. */
// @spec CTRL-STACK-022, CTRL-STACK-023, CTRL-STACK-024
export class BuildProgress {
  private rowsBy = new Map<string, Row>();
  private vertexService = new Map<number, string>();
  private vertexStep = new Map<number, number>();
  private output = new Map<number, string[]>();
  private fail?: BuildFailure;
  private containers: string[] = [];

  /** Takes one line; true when a row, the failure or the touched containers changed. */
  push(line: string): boolean {
    const header = HEADER.exec(line);
    if (header) return this.onHeader(Number(header[1]), header[2]!.trim().split(/\s+/), header[3] ?? "");
    const vertex = VERTEX.exec(line);
    if (vertex) return this.onVertex(Number(vertex[1]), vertex[2]!);
    const container = CONTAINER.exec(line);
    if (container) {
      const name = container[1]!;
      if (!this.containers.includes(name)) this.containers.push(name);
      for (const r of this.rowsBy.values()) if (state(r) === "building") r.built = true;
      return true;
    }
    const built = BUILT.exec(line);
    if (built) {
      const r = [...this.rowsBy.values()].find((x) => x.service === built[1] || built[1]!.endsWith(`-${x.service}`));
      if (r && !r.built) { r.built = true; return true; }
    }
    return false;
  }

  rows(): BuildRow[] {
    return [...this.rowsBy.values()].map((r) => ({
      service: r.service, state: state(r),
      ...(r.step !== undefined ? { step: r.step, of: r.of! } : {}),
      total: [...r.stages.values()].reduce((a, b) => a + b, 0),
      done: r.done.size, cached: r.cached.size,
      ...(r.current !== undefined ? { current: r.current } : {}),
    }));
  }

  failure(): BuildFailure | undefined { return this.fail ? { ...this.fail, lines: [...this.fail.lines] } : undefined; }

  /** The container names Compose has acted on, in first-seen order. */
  touched(): string[] { return [...this.containers]; }

  private row(service: string): Row {
    let r = this.rowsBy.get(service);
    if (!r) {
      r = { service, failed: false, built: false, stages: new Map(), done: new Set(), cached: new Set(), numbered: new Set() };
      this.rowsBy.set(service, r);
    }
    return r;
  }

  private onHeader(n: number, tokens: string[], text: string): boolean {
    const last = tokens.at(-1)!;
    const step = STEP.exec(last);
    if (tokens.length < 2) {
      // `[internal]` or `[2/6]` of a single unnamed build: no service to attribute.
      return false;
    }
    const service = tokens[0]!;
    this.vertexService.set(n, service);
    const r = this.row(service);
    if (step) {
      const stage = tokens.slice(1, -1).join(" ");
      r.stages.set(stage, Number(step[2]));
      r.step = Number(step[1]);
      r.of = Number(step[2]);
      r.current = text.slice(0, TEXT_MAX);
      r.numbered.add(n);
      this.vertexStep.set(n, r.step);
    }
    return true;
  }

  private onVertex(n: number, rest: string): boolean {
    const service = this.vertexService.get(n);
    const r = service ? this.rowsBy.get(service) : undefined;
    if (rest === "CACHED" || rest.startsWith("DONE")) {
      if (!r || !r.numbered.has(n) || r.done.has(n)) return false;
      r.done.add(n);
      if (rest === "CACHED") r.cached.add(n);
      return true;
    }
    if (rest.startsWith("ERROR")) {
      const lines = [...(this.output.get(n) ?? []).slice(-ERROR_LINES), rest];
      if (r) r.failed = true;
      this.fail ??= { ...(service ? { service } : {}), lines };
      return true;
    }
    const out = OUTPUT.exec(rest);
    if (out) {
      const list = this.output.get(n) ?? [];
      list.push(out[1]!);
      if (list.length > ERROR_LINES) list.shift();
      this.output.set(n, list);
    }
    return false;
  }
}

function state(r: Row): BuildRowState {
  if (r.failed) return "failed";
  const all = r.numbered.size > 0 && r.done.size === r.numbered.size && [...r.stages.values()].reduce((a, b) => a + b, 0) <= r.done.size;
  if (all) return r.cached.size === r.done.size ? "cached" : "built";
  if (r.built) return "built";
  return "building";
}
