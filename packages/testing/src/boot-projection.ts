/**
 * The per-unit boot test against a projection (module-contract MOD-MAN-018): a unit's entry runs through `runService` with
 * the real projection loader reading a `settings.json` that holds only the sections and documents the unit's manifest entry
 * declares (built here from the committed examples under `config/`), its credentials message delivered through the real
 * receiver on a descriptor, its isolation preset in `COHOST_ISOLATION`, and the real `Bus` over an in-memory transport that
 * delivers injected events to every consumer group. A read of an undeclared section throws in the loader's guard, so the
 * boot fails and so does the test.
 */
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Bus, EventPayloads, type BusEvent, type BusReader, type EntryFields, type EventInput, type EventStream, type EventType, type GroupRead, type RawEntry,
} from "@cohost/bus";
import {
  ISOLATION_ENV, PROJECTION_FILE, PROJECTION_FORMAT, encodeIsolation, parseYaml, resetConfigCache, unitSettings, type Logger,
} from "@cohost/config";
import { CREDENTIALS_FD_ENV, getsCredentials } from "@cohost/shared";
import { FakeFrameTransport, FakeTransport, busError } from "./fake-transport.js";
import { waitFor } from "./index.js";

const repoPath = (rel: string): string => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const getIn = (root: unknown, segs: readonly string[]): unknown => segs.reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), root);

/** What the boot test takes from a unit's manifest entry: its isolation preset and its declared test inputs. */
export interface ManifestEntry { id: string; isolatedEnv: Readonly<Record<string, string>>; test: { inputs: readonly string[]; observe: readonly string[] } }

/** The manifest entry of `unit`, loaded from the built control package by path so no service needs a dependency on it. */
export async function manifestEntry(unit: string): Promise<ManifestEntry> {
  const mod = (await import(pathToFileURL(repoPath("packages/control/dist/manifest.js")).href)) as { SERVICE_MANIFEST: (ManifestEntry & { pnpmFilter?: string })[] };
  const entry = mod.SERVICE_MANIFEST.find((s) => s.id === unit && s.pnpmFilter !== undefined);
  if (entry === undefined) throw new Error(`${unit} is not an application unit of the manifest`);
  return entry;
}

export interface ProjectionOptions {
  /** Declared sections to leave out of the projection (the guard test: a missing declaration). */
  omit?: readonly string[];
}

/**
 * Writes the projection of `unit` into `dir` as the settings store writes one (settings-store STORE-PROJ-001): each section
 * its `UNIT_SETTINGS` entry declares, as the seed example holds it (`null` for one the example does not hold, so its schema
 * defaults apply), and each document it declares from the committed examples. Nothing else.
 */
export function writeUnitProjection(unit: string, dir: string, opts: ProjectionOptions = {}): void {
  const declared = unitSettings(unit);
  if (declared === undefined) throw new Error(`${unit} has no entry in UNIT_SETTINGS`);
  const seed = parseYaml(readFileSync(repoPath("config/config.example.yaml"), "utf8")) as unknown;
  const sections: Record<string, unknown> = {};
  for (const path of declared.config) {
    if (opts.omit?.includes(path)) continue;
    sections[path] = getIn(seed, path.split(".")) ?? null;
  }
  const documents: Record<string, unknown> = {};
  for (const name of declared.documents) {
    documents[name] = name === "personality"
      ? readFileSync(repoPath("config/personality.example.md"), "utf8")
      : parseYaml(readFileSync(repoPath("config/expressions.example.yaml"), "utf8"));
  }
  const projection = { format: PROJECTION_FORMAT, unit, revision: 1, sections, documents };
  writeFileSync(join(dir, PROJECTION_FILE), `${JSON.stringify(projection)}\n`, { mode: 0o600 });
}

/**
 * A `BusTransport` that behaves like an idle Redis with one events stream: every consumer group created on it receives each
 * entry `deliver` appends from then on, a group's pending drain is empty, and a blocking read waits for an entry or `close()`.
 * Everything the bus appends is recorded, so `published` and `heartbeats` decode what the unit wrote.
 */
export class StreamTransport extends FakeTransport {
  /** The entries waiting for each consumer group. */
  private queues = new Map<string, RawEntry[]>();
  private wakers = new Set<() => void>();
  private seq = 0;
  /** The groups a reader has blocked on for new entries: subscribed and positioned. */
  readonly reading = new Set<string>();

  override createGroup(group: string): Promise<boolean> {
    const created = !this.queues.has(group);
    if (created) this.queues.set(group, []);
    return this.run("createGroup", [group], () => created);
  }
  /** The groups created so far. */
  groups(): string[] { return [...this.queues.keys()]; }

  /** Puts one entry on the events stream, for every existing group. */
  deliver(fields: EntryFields): string {
    const id = `${Date.now()}-${this.seq++}`;
    for (const q of this.queues.values()) q.push({ id, ...fields });
    for (const w of [...this.wakers]) w();
    return id;
  }

  override openReader(): BusReader {
    this.record("openReader", []);
    if (this.closed) throw busError("BUS_CLOSED", "transport closed");
    let closed = false;
    return {
      readGroup: async (group: string, _consumer: string, cursor: string): Promise<GroupRead> => {
        for (;;) {
          if (closed || this.closed) throw busError("BUS_CLOSED", "reader closed");
          if (cursor !== ">") return { entries: [], ackErrors: [] };
          this.reading.add(group);
          const q = this.queues.get(group);
          if (q && q.length > 0) return { entries: q.splice(0, q.length), ackErrors: [] };
          await new Promise<void>((resolve) => {
            const wake = (): void => { this.wakers.delete(wake); resolve(); };
            this.wakers.add(wake);
          });
        }
      },
      ack: (): void => {},
      read: async (_stream: EventStream): Promise<RawEntry[] | null> => {
        await new Promise<void>((resolve) => {
          const wake = (): void => { if (closed || this.closed) { this.wakers.delete(wake); resolve(); } };
          this.wakers.add(wake);
        });
        throw busError("BUS_CLOSED", "reader closed");
      },
      close: (): void => { closed = true; for (const w of [...this.wakers]) w(); },
    };
  }

  override async close(): Promise<void> {
    await super.close();
    for (const w of [...this.wakers]) w();
  }

  /** Decoded entries the unit appended to `stream`. */
  appended(stream: EventStream): { type: string; source: string; data: unknown }[] {
    return this.of("append").filter((c) => c.args[0] === stream).map((c) => {
      const f = c.args[1] as EntryFields;
      return { type: f.type, source: f.source, data: JSON.parse(f.data) as unknown };
    });
  }
}

/** A logger that keeps every line with its level, its message and its object (the `err` of a fatal line included). */
function keepingLog(): { log: Logger; lines: { level: string; msg: string; obj: unknown }[] } {
  const lines: { level: string; msg: string; obj: unknown }[] = [];
  const at = (level: string) => (obj: unknown, msg?: string): void => {
    lines.push({ level, obj, msg: typeof obj === "string" ? obj : msg ?? "" });
  };
  const log = { warn: at("warn"), info: at("info"), error: at("error"), debug: at("debug"), fatal: at("fatal"), trace: at("trace"), child: () => log } as unknown as Logger;
  return { log, lines };
}

/** The projection guard's error (config CFG-LOAD-001): a unit read a section its projection does not hold. */
const UNDECLARED = /read the settings section \S+, which its projection does not hold/;

/** A log line's message and every error message or string its object carries, as one text. */
function lineText(l: { msg: string; obj: unknown }): string {
  const parts = [l.msg];
  if (isObj(l.obj)) for (const v of Object.values(l.obj)) parts.push(v instanceof Error ? v.message : typeof v === "string" ? v : "");
  return parts.filter(Boolean).join(": ");
}

/** What a unit's boot function receives from the harness: the `runService` replacements for a test (no `loadConfig`). */
export interface BootDeps<B = Bus> {
  createBus: (service: string, log: Logger) => B;
  onShutdown: (fn: () => void | Promise<void>) => void;
  exit: (code: number) => void;
  log: Logger;
}

export interface BootedUnit {
  unit: string;
  entry: ManifestEntry;
  transport: StreamTransport;
  frames: FakeFrameTransport;
  /** The unit's data directory (`COHOST_DATA_DIR`), a temporary directory. */
  dataDir: string;
  /** Exit codes the bootstrap asked for. */
  exits: number[];
  /** Every log line. */
  lines: { level: string; msg: string; obj: unknown }[];
  /** The settled boot promise's error, if it rejected. */
  bootError?: unknown;
  /** Whether the boot function's promise has settled. */
  settled: boolean;
  /** Events the unit published, decoded, of `type`. */
  published<T extends EventType>(type: T): BusEvent<T>["data"][];
  /** The heartbeat states the unit published, in order. */
  states(): string[];
  /** Publishes `type` as another process would (the dashboard's inject route): validated, delivered to every group. */
  inject<T extends EventType>(type: T, data: EventInput<T>): string;
  /** Stores an upload under `id` for the unit's `takeUpload` (what the dashboard's `putUpload` writes). */
  putUpload(id: string, bytes: Buffer): void;
  /** Waits for the unit to have created `group` and be blocked reading it (subscribed and positioned). */
  subscribed(group: string): Promise<void>;
  /** The failure text of a failed boot: the error lines' messages and errors, joined. */
  failure(): string;
  /**
   * Every log line that reports a read of a section the projection does not hold: one a handler or a background step caught
   * and logged instead of failing the boot.
   */
  undeclaredReads(): string[];
  /**
   * Runs the shutdown steps the unit registered, restores the environment and removes the temporary directories; then throws
   * when any line reported a read of an undeclared section, so a read caught and logged inside the unit still fails the test.
   */
  stop(): Promise<void>;
}

export interface BootOptions<B> extends ProjectionOptions {
  /** Starts the unit the way its entry file does, with the harness's replacements; the promise its entry would start. */
  start: (deps: BootDeps<B>) => Promise<void>;
}

/**
 * Boots `unit` against its projection: writes the projection into a temporary config directory, delivers an empty credentials
 * message (with a state key for a unit that declares one) on a descriptor, sets the unit's isolation preset, then calls
 * `start`. The environment it sets is restored by `stop`.
 */
// @spec MOD-MAN-018
export async function bootUnit<B = Bus>(unit: string, opts: BootOptions<B>): Promise<BootedUnit> {
  const entry = await manifestEntry(unit);
  const root = mkdtempSync(join(tmpdir(), `cohost-boot-${unit}-`));
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { mode: 0o700 });
  mkdirSync(dataDir, { mode: 0o700 });
  writeUnitProjection(unit, configDir, opts);

  const saved: Record<string, string | undefined> = {};
  const setEnv = (name: string, value: string | undefined): void => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  setEnv("CONFIG_DIR", configDir);
  setEnv("COHOST_DATA_DIR", dataDir);
  setEnv(ISOLATION_ENV, encodeIsolation(entry.isolatedEnv));
  if (getsCredentials(unit)) {
    const message = { format: 1, unit, revision: 1, credentials: {}, ...(unitSettings(unit)?.stateKey ? { state_key: Buffer.alloc(32, 7).toString("base64url") } : {}) };
    const file = join(root, "credentials.json");
    writeFileSync(file, JSON.stringify(message), { mode: 0o600 });
    setEnv(CREDENTIALS_FD_ENV, String(openSync(file, "r")));
  } else {
    setEnv(CREDENTIALS_FD_ENV, undefined);
  }
  resetConfigCache();

  const transport = new StreamTransport();
  const frames = new FakeFrameTransport();
  const shutdown: (() => void | Promise<void>)[] = [];
  const exits: number[] = [];
  const { log, lines } = keepingLog();
  const uploads = new Map<string, Buffer>();
  transport.takeUpload = (id: string) => transport.run("takeUpload", [id], () => { const b = uploads.get(id) ?? null; uploads.delete(id); return b; });

  const booted: BootedUnit = {
    unit, entry, transport, frames, dataDir, exits, lines, settled: false,
    published: <T extends EventType>(type: T) => transport.appended("events").filter((e) => e.type === type).map((e) => e.data as BusEvent<T>["data"]),
    states: () => transport.appended("health").map((e) => (e.data as { state: string }).state),
    inject: <T extends EventType>(type: T, data: EventInput<T>) => {
      const parsed = EventPayloads[type].parse(data);
      return transport.deliver({ type, ts: String(Date.now()), source: "dashboard", data: JSON.stringify(parsed) });
    },
    putUpload: (id, bytes) => { uploads.set(id, bytes); },
    subscribed: async (group) => {
      await waitFor(() => transport.reading.has(group), `${unit} subscribed to ${group}`, 10_000);
    },
    failure: () => lines.filter((l) => l.level === "error" || l.level === "fatal").map(lineText).join("\n")
      + (booted.bootError instanceof Error ? `\n${booted.bootError.message}` : ""),
    undeclaredReads: () => lines.map(lineText).filter((t) => UNDECLARED.test(t)),
    stop: async () => {
      for (const fn of shutdown.splice(0)) await fn();
      await transport.close();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      resetConfigCache();
      rmSync(root, { recursive: true, force: true });
      const undeclared = booted.undeclaredReads();
      if (undeclared.length > 0 && opts.omit === undefined) throw new Error(`${unit} read a section its projection does not hold:\n${undeclared.join("\n")}`);
    },
  };
  const deps: BootDeps<B> = {
    createBus: (service, l) => new Bus(service, l, "redis://boot-test", { transport: transport.factory, frames: frames.factory, retryBaseMs: 5, retryMaxMs: 20 }) as unknown as B,
    onShutdown: (fn) => { shutdown.push(fn); },
    exit: (code) => { exits.push(code); },
    log,
  };
  void opts.start(deps).then(
    () => { booted.settled = true; },
    (err: unknown) => { booted.settled = true; booted.bootError = err; },
  );
  return booted;
}

/**
 * Waits until the unit has started: it published a heartbeat past `starting` (`ready`, `degraded` or `idle`), or failed.
 * Throws with the failure text when the boot failed (an exit status or a rejected boot), as a read of an undeclared section
 * makes it.
 */
export async function started(u: BootedUnit, ms = 10_000): Promise<void> {
  await waitFor(() => u.exits.length > 0 || u.bootError !== undefined || u.states().some((s) => s !== "starting" && s !== "stopping"), `${u.unit} to start`, ms);
  if (u.exits.length > 0 || u.bootError !== undefined) throw new Error(`${u.unit} failed to boot against its projection (exit ${u.exits.join(",")}):\n${u.failure()}`);
}

/** Waits for the boot to fail and returns its failure text. */
export async function bootFailure(u: BootedUnit, ms = 10_000): Promise<string> {
  await waitFor(() => u.exits.length > 0 || u.bootError !== undefined, `${u.unit} to fail`, ms);
  return u.failure();
}
