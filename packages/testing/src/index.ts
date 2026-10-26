/** Shared helpers for region tests: a full config, a recording bus, a silent logger. */
import { randomUUID } from "node:crypto";
import { ConfigSchema, type Config } from "@cohost/config";
import { EventPayloads, startHeartbeat, type BusEvent, type EventInput, type EventType, type HeartbeatSpec, type Publisher } from "@cohost/bus";

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

/** A complete, schema-validated config with the timing knobs zeroed so tests don't wait. */
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

export const silentLog = { warn() {}, info() {}, error() {}, debug() {}, fatal() {}, trace() {} } as never;

/** A logger that keeps what it was told, by level. */
export function recordingLog() {
  const lines: { level: string; obj: unknown; msg?: string }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string) => { lines.push({ level, obj, msg: typeof obj === "string" ? obj : msg }); };
  const log = { warn: at("warn"), info: at("info"), error: at("error"), debug: at("debug") } as never;
  return { log, lines, msgs: (level: string) => lines.filter((l) => l.level === level).map((l) => l.msg) };
}

/** Validates like the real Bus, records instead of talking to Redis. */
export class FakeBus implements Publisher {
  published: { type: EventType; data: unknown }[] = [];
  /** Heartbeats published via publishHealth (the real Bus puts these on cohost:health). */
  health: BusEvent<"service.heartbeat">["data"][] = [];
  readonly consumer = "fake-instance";
  fail?: (type: EventType) => boolean;
  /** Make publishHealth reject, to test publish-failure handling. */
  failHealth = false;
  async publishHealth(data: EventInput<"service.heartbeat">): Promise<string> {
    const parsed = EventPayloads["service.heartbeat"].parse(data);
    if (this.failHealth) throw new Error("publishHealth failed");
    this.health.push(parsed);
    return String(this.health.length);
  }
  async recentHealth(count = 100): Promise<BusEvent<"service.heartbeat">[]> {
    return this.health.slice(-count).map((data, i) => ({
      id: String(i), type: "service.heartbeat" as const, ts: Date.now(), source: data.service, data,
    }));
  }
  async publish<T extends EventType>(type: T, data: EventInput<T>): Promise<string> {
    if (type === "service.heartbeat") throw new Error("service.heartbeat goes on the health stream: use publishHealth()");
    const parsed = EventPayloads[type].parse(data);
    if (this.fail?.(type)) throw new Error(`publish ${type} failed`);
    this.published.push({ type, data: parsed });
    return String(this.published.length);
  }
  of<T extends EventType>(type: T): BusEvent<T>["data"][] {
    return this.published.filter((p) => p.type === type).map((p) => p.data as BusEvent<T>["data"]);
  }
  types(): EventType[] {
    return this.published.map((p) => p.type);
  }
  clear(): void { this.published = []; this.health = []; }
}

/** A bus event as a subscriber would receive it. */
export function event<T extends EventType>(type: T, data: EventInput<T>, source = "test"): BusEvent<T> {
  return { id: randomUUID(), type, ts: Date.now(), source, data: EventPayloads[type].parse(data) as never } as BusEvent<T>;
}

/**
 * Run a service's heartbeat against a FakeBus: `drive` moves it through its lifecycle,
 * then the stopping heartbeat is sent. Returns every heartbeat published, in order.
 */
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

export async function waitFor(cond: () => boolean, what = "condition", ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
