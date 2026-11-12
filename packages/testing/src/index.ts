/** Shared helpers for region tests: a full config, a recording bus, a silent logger. */
import { ConfigSchema, type Config } from "@cohost/config";
import { EventPayloads, type BusEvent, type EventInput, type EventType, type Publisher } from "@cohost/bus";
import { startHeartbeat, type HeartbeatSpec } from "@cohost/shared";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** A complete, schema-validated config with the timing knobs zeroed so tests don't wait. */
// @spec BUS-TEST-005
export function testConfig(over: Record<string, unknown> = {}): Config {
  const base = {
    cohost: { name: "Coco", streamer: "Chris", timezone: "UTC" },
    llm: { model: "m", embed_model: "e" },
    vision: { model: "v", obs: {} },
    chat: { twitch: { channel: "chan" } },
    brain: { salience: { cooldown_ms: 0, idle_chatter_ms: 0 } },
    voice: {},
    avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
    ears: { discord: {} },
    dashboard: {},
  };
  return ConfigSchema.parse(merge(base, over));
}

// @spec BUS-TEST-010
export const silentLog = { warn() {}, info() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never;

/** A logger that keeps what it was told, by level. */
// @spec BUS-TEST-010
export function recordingLog() {
  const lines: { level: string; obj: unknown; msg?: string }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: typeof obj === "string" ? obj : msg }); };
  const log = { warn: at("warn"), info: at("info"), error: at("error"), debug: at("debug"), fatal: at("fatal") } as never;
  return { log, lines, msgs: (level: string) => lines.filter((l) => l.level === level).map((l) => l.msg) };
}

let lastMs = 0;
let lastSeq = 0;
/** A Redis-form stream id, `<ms>-<seq>`, strictly increasing within the process (BUS-TEST-011). */
function nextId(): string {
  const now = Date.now();
  if (now > lastMs) { lastMs = now; lastSeq = 0; } else lastSeq++;
  return `${lastMs}-${lastSeq}`;
}

/** Validates like the real Bus, records instead of talking to Redis. */
// @spec BUS-TEST-004, BUS-TEST-009
export class FakeBus implements Publisher {
  published: { type: EventType; data: unknown }[] = [];
  /** Heartbeats published via publishHealth (the real Bus puts these on cohost:health). */
  health: BusEvent<"service.heartbeat">["data"][] = [];
  private healthIds: string[] = [];
  readonly consumer = "fake-instance";
  fail?: (type: EventType) => boolean;
  /** Make publishHealth reject, to test publish-failure handling. */
  failHealth = false;
  /** Uploads stored by `putUpload`, by id. */
  uploads = new Map<string, { bytes: Buffer; ttlMs: number }>();
  /** Make putUpload reject, to test upload-store failure handling. */
  failUpload = false;
  // @spec BUS-TEST-012
  async putUpload(id: string, bytes: Buffer, ttlMs: number): Promise<void> {
    if (this.failUpload) throw new Error("putUpload failed");
    this.uploads.set(id, { bytes, ttlMs });
  }
  // @spec BUS-TEST-012
  async takeUpload(id: string): Promise<Buffer | null> {
    const u = this.uploads.get(id);
    this.uploads.delete(id);
    return u?.bytes ?? null;
  }
  // @spec BUS-TEST-002
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    if (this.failHealth) throw new Error("publishHealth failed");
    const id = nextId();
    this.health.push(parsed);
    this.healthIds.push(id);
    return id;
  }
  // @spec BUS-TEST-003
  async recentHealth(count = 100): Promise<BusEvent<"service.heartbeat">[]> {
    const from = Math.max(0, this.health.length - count);
    return this.health.slice(from).map((data, i) => ({
      id: this.healthIds[from + i] ?? String(from + i), type: "service.heartbeat" as const, ts: Date.now(), source: data.service, data,
    }));
  }
  // @spec BUS-TEST-001
  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    if (this.fail?.(type)) throw new Error(`publish ${type} failed`);
    this.published.push({ type, data: parsed });
    return nextId();
  }
  of<T extends EventType>(type: T): BusEvent<T>["data"][] {
    return this.published.filter((p) => p.type === type).map((p) => p.data as BusEvent<T>["data"]);
  }
  types(): EventType[] {
    return this.published.map((p) => p.type);
  }
  clear(): void { this.published = []; this.health = []; this.healthIds = []; }
}

/** A bus event as a subscriber would receive it. */
// @spec BUS-TEST-006
export function event<T extends EventType>(type: T, data: EventInput<T>, source = "test"): BusEvent<T> {
  return { id: nextId(), type, ts: Date.now(), source, data: EventPayloads[type].parse(data) as never } as BusEvent<T>;
}

/**
 * Run a service's heartbeat against a FakeBus: `drive` moves it through its lifecycle,
 * then the stopping heartbeat is sent. Returns every heartbeat published, in order.
 */
// @spec BUS-TEST-007
export async function runHeartbeat(
  spec: HeartbeatSpec,
  drive: (hb: ReturnType<typeof startHeartbeat>) => void | Promise<void> = (hb) => hb.ready(),
): Promise<BusEvent<"service.heartbeat">["data"][]> {
  const bus = new FakeBus();
  const hb = startHeartbeat(bus, { ...spec, intervalMs: 60_000 });
  await drive(hb);
  await new Promise((r) => setTimeout(r, 10));
  await hb.stop();
  return bus.health;
}

// @spec BUS-TEST-008
export async function waitFor(cond: () => boolean, what = "condition", ms = 2000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
export { unitContractTests, entryProblem } from "./unit-contract.js";
