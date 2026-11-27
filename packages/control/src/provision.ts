/**
 * Projections and credential delivery around every start (settings-store STORE-PROJ-003, STORE-DLV-001 to -006; control-plane
 * CTRL-RUNTIME-014, CTRL-RUNTIME-018, CTRL-CLI-019). Before a `docker compose` command that may start a container, the control
 * plane refuses a `CONTROL_TOKEN` in `.env` or its environment, writes every unit's projection and reads each container's
 * `State.StartedAt`; after it, it delivers each started unit's credentials message into the container's `/run/cohost` tmpfs
 * through `docker exec -i` with the message on standard input, and records the delivery (never a credential) in
 * `data/control/deliveries.json`.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dotEnvPath, UNIT_SETTINGS, type UnitSettings } from "@cohost/config";
import { credentialsMessage, messageText, openStore, pocketToken, writeProjections, type Store, type StoreOptions } from "@cohost/store";
import { SERVICE_MANIFEST, type ServiceDef } from "./manifest.js";
import type { RuntimeResult } from "./runtime.js";

/** Runs the docker CLI with fixed arguments: `compose` commands run with the project's environment and working directory. */
export type DockerRun = (args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

/** Where the control plane takes what it projects and delivers: the settings store, opened by the control plane alone. */
export interface CredentialSource {
  /** Writes every unit's projection (STORE-PROJ-003); throws with the reason, naming no secret value. */
  project(): Promise<void>;
  /** The credentials message of a unit id as text, or undefined for a unit that gets none (STORE-DLV-002). */
  message(unit: string): Promise<string | undefined>;
  /** The Pocket engine's token, empty when none is stored (STORE-DLV-006). */
  pocketToken(): Promise<string>;
}

/**
 * The settings store as a credential source: opened at the first use with the control plane's busy timeout (STORE-DB-003) and
 * kept open for the process; projections go under the workspace root `root`.
 */
export function storeSource(root: string, opts: StoreOptions = {}): CredentialSource & { close(): void } {
  let store: Promise<Store> | undefined;
  const open = (): Promise<Store> => {
    store ??= openStore({ ...opts, profile: "other" }).catch((e: unknown) => { store = undefined; throw e; });
    return store;
  };
  return {
    project: async () => { writeProjections(await open(), root); },
    message: async (unit) => {
      const m = credentialsMessage(await open(), unit);
      return m === undefined ? undefined : messageText(m);
    },
    pocketToken: async () => pocketToken(await open()),
    close: () => { void store?.then((s) => { s.close(); }, () => undefined); store = undefined; },
  };
}

/**
 * Why `CONTROL_TOKEN` stops the control plane (settings-store STORE-TOK-005): `.env` (the file `dotEnvPath()` names) or the
 * environment defines it with a value that is not empty after trimming. Names the file and line or the environment, never the
 * value; undefined when neither does.
 */
// @spec STORE-TOK-005
export function controlTokenRefusal(env: NodeJS.ProcessEnv = process.env, envFile: string = dotEnvPath()): string | undefined {
  const advice = "the control token belongs in your password manager and is set with mise run config:token -- --stdin; the settings store keeps only its verifier";
  let text = "";
  try { text = readFileSync(envFile, "utf8"); } catch { /* no .env */ }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?CONTROL_TOKEN\s*=(.*)$/.exec(lines[i]!);
    const value = m?.[1]?.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (value) return `${envFile} defines CONTROL_TOKEN on line ${i + 1}: remove that line; ${advice}`;
  }
  if ((env.CONTROL_TOKEN ?? "").trim() !== "") return `the environment defines CONTROL_TOKEN: unset it; ${advice}`;
  return undefined;
}

/** One container of the project, as the delivery reads it. */
export interface ContainerStart { id: string; name: string; service: string; startedAt: string; running: boolean }

/** One line per container: id, name, Compose service, `State.StartedAt` and whether it runs. */
const START_FORMAT = '{{.Id}} {{.Name}} {{index .Config.Labels "com.docker.compose.service"}} {{.State.StartedAt}} {{.State.Running}}';
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const STATUS_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 30_000;

/** The file in a container's `/run/cohost` tmpfs a delivery writes, through a temporary name and a rename. */
const DELIVERY_SCRIPT = (file: string): string => `umask 077 && cat > /run/cohost/.${file}.tmp && mv /run/cohost/.${file}.tmp /run/cohost/${file}`;
export const CREDENTIALS_SCRIPT = DELIVERY_SCRIPT("credentials.json");
export const POCKET_SCRIPT = DELIVERY_SCRIPT("hf_token");

/** A delivery the control plane recorded: the unit, the container and the `StartedAt` it was delivered at (no credential). */
export interface DeliveryRecord { unit: string; container: string; startedAt: string }

/** `data/control/deliveries.json` under the workspace root (STORE-DLV-003). */
export const deliveriesFile = (root: string): string => join(root, "data", "control", "deliveries.json");

/** The recorded deliveries by Compose service name; an absent or unreadable file records none. */
export function readDeliveries(root: string): Record<string, DeliveryRecord> {
  try {
    const raw = JSON.parse(readFileSync(deliveriesFile(root), "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, DeliveryRecord> : {};
  } catch {
    return {};
  }
}

/** Rewrites the whole record with mode 0600 through a temporary file and a rename: the dashboard and `cohostctl deliver` both write it. */
function writeDeliveries(root: string, records: Record<string, DeliveryRecord>): void {
  const file = deliveriesFile(root);
  mkdirSync(join(root, "data", "control"), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export interface ProvisionerOptions {
  /** The workspace root: `data/projections/` and `data/control/` are under it. */
  root: string;
  docker: DockerRun;
  env: NodeJS.ProcessEnv;
  /** The `.env` file checked for `CONTROL_TOKEN` (default `dotEnvPath()`). */
  envFile?: string;
  source: CredentialSource;
  manifest?: readonly ServiceDef[];
  units?: readonly UnitSettings[];
}

/** After the command: deliver to what it started. `oneShot` is the container a `run -d --name` created. */
export type AfterStart = (oneShot?: { name: string; unit: string }) => Promise<RuntimeResult>;

/** What runs around every command that may start a container. */
export interface Provisioner {
  /** Refuses `CONTROL_TOKEN`, writes the projections and reads `StartedAt`; a refusal or failure names no secret value. */
  before(): Promise<{ ok: true; after: AfterStart } | { ok: false; detail: string }>;
}

/** No projection and no delivery: for a test of the commands alone. */
export const NO_PROVISION: Provisioner = { before: async () => ({ ok: true, after: async () => ({ ok: true }) }) };

const firstLine = (err: unknown): string => ((err as Error)?.message ?? String(err)).split("\n")[0]!.slice(0, 300);

/** The delivery side of the control plane: `before`/`after` around a start, and the re-delivery to waiting units. */
// @spec STORE-DLV-001, STORE-DLV-003, STORE-DLV-006, CTRL-RUNTIME-014, CTRL-RUNTIME-018
export class ComposeProvisioner implements Provisioner {
  private readonly manifest: readonly ServiceDef[];
  private readonly units: readonly UnitSettings[];
  constructor(private readonly o: ProvisionerOptions) {
    this.manifest = o.manifest ?? SERVICE_MANIFEST;
    this.units = o.units ?? UNIT_SETTINGS;
  }

  /** The containers of the project with their `StartedAt`, by id; an empty map when Docker cannot say. */
  async containers(): Promise<Map<string, ContainerStart>> {
    const out = new Map<string, ContainerStart>();
    let ids: string[];
    try {
      ids = (await this.o.docker(["compose", "ps", "--all", "-q"], { timeoutMs: STATUS_TIMEOUT_MS })).stdout.split("\n").map((l) => l.trim()).filter((l) => CONTAINER_ID.test(l));
    } catch {
      return out;
    }
    if (ids.length === 0) return out;
    let stdout: string;
    try {
      ({ stdout } = await this.o.docker(["inspect", "--format", START_FORMAT, ...ids], { timeoutMs: STATUS_TIMEOUT_MS }));
    } catch {
      return out;
    }
    for (const line of stdout.split("\n")) {
      const m = /^(\S+) \/?(\S+) (\S*) (\S+) (true|false)$/.exec(line.trim());
      if (m) out.set(m[1]!, { id: m[1]!, name: m[2]!, service: m[3]!, startedAt: m[4]!, running: m[5] === "true" });
    }
    return out;
  }

  /** The unit whose message a container of Compose service `service` gets: its manifest unit, `memory` for the one-shots. */
  private unitOf(service: string): string | undefined {
    if (service === "consolidate" || service === "reembed") return "memory";
    return this.manifest.find((d) => d.composeName === service)?.id;
  }

  /** Writes `text` into the container's `/run/cohost` through `docker exec -i`; the failure names the unit and the status. */
  private async push(container: string, unit: string, script: string, text: string): Promise<string | undefined> {
    try {
      await this.o.docker(["exec", "-i", container, "sh", "-c", script], { input: text, timeoutMs: EXEC_TIMEOUT_MS });
      return undefined;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return `the credentials of ${unit} could not be delivered (docker exec exited ${typeof code === "number" ? code : firstLine(err)})`;
    }
  }

  /** Delivers to one container of Compose service `service`; undefined when there is nothing to deliver or it went through. */
  async deliverTo(c: Pick<ContainerStart, "id" | "service" | "startedAt">, records: Record<string, DeliveryRecord>): Promise<{ unit: string; error?: string } | undefined> {
    if (c.service === "tts-pocket") {
      const error = await this.push(c.id, "tts-pocket", POCKET_SCRIPT, await this.o.source.pocketToken());
      if (!error) records[c.service] = { unit: "tts-pocket", container: c.id, startedAt: c.startedAt };
      return { unit: "tts-pocket", ...(error ? { error } : {}) };
    }
    const unit = this.unitOf(c.service);
    if (unit === undefined) return undefined;
    const text = await this.o.source.message(unit);
    if (text === undefined) return undefined;
    const error = await this.push(c.id, unit, CREDENTIALS_SCRIPT, text);
    if (!error) records[c.service] = { unit, container: c.id, startedAt: c.startedAt };
    return { unit, ...(error ? { error } : {}) };
  }

  // @spec STORE-TOK-005, STORE-PROJ-003, STORE-DLV-003, CTRL-RUNTIME-014, CTRL-RUNTIME-018
  async before(): Promise<{ ok: true; after: AfterStart } | { ok: false; detail: string }> {
    const refusal = controlTokenRefusal(this.o.env, this.o.envFile);
    if (refusal) return { ok: false, detail: refusal };
    try {
      await this.o.source.project();
    } catch (err) {
      return { ok: false, detail: `the projections could not be written: ${firstLine(err)}` };
    }
    const seen = await this.containers();
    return {
      ok: true,
      after: async (oneShot) => {
        const records = readDeliveries(this.o.root);
        const failures: string[] = [];
        if (oneShot) {
          const text = await this.o.source.message(oneShot.unit);
          if (text !== undefined) {
            const error = await this.push(oneShot.name, oneShot.unit, CREDENTIALS_SCRIPT, text);
            if (error) failures.push(error);
          }
        }
        const now = await this.containers();
        for (const c of now.values()) {
          if (!c.running || (oneShot && c.name === oneShot.name)) continue;
          if (seen.get(c.id)?.startedAt === c.startedAt) continue; // not started by this command
          const r = await this.deliverTo(c, records);
          if (r?.error) failures.push(r.error);
        }
        try { writeDeliveries(this.o.root, records); } catch (err) { failures.push(`cannot record the deliveries: ${firstLine(err)}`); }
        return failures.length === 0 ? { ok: true } : { ok: false, detail: failures.join("; ") };
      },
    };
  }

  /**
   * Delivers to every running unit that gets a message and either is in `waiting` (its heartbeat says `waiting for
   * credentials`) or whose `StartedAt` differs from its recorded delivery, skipping a unit in `ready` with no recorded delivery
   * (it already holds its credentials); `tts-pocket` by `StartedAt` alone (STORE-DLV-005, CTRL-CLI-019). Returns the units
   * delivered to and the failures.
   */
  // @spec STORE-DLV-005, STORE-DLV-006, CTRL-CLI-019
  async redeliver(o: { waiting: ReadonlySet<string>; ready: ReadonlySet<string> }): Promise<{ delivered: string[]; failures: string[] }> {
    const records = readDeliveries(this.o.root);
    const delivered: string[] = [];
    const failures: string[] = [];
    for (const c of (await this.containers()).values()) {
      if (!c.running || c.service === "consolidate" || c.service === "reembed") continue;
      const unit = c.service === "tts-pocket" ? "tts-pocket" : this.unitOf(c.service);
      if (unit === undefined) continue;
      const def = this.units.find((u) => u.id === unit);
      if (unit !== "tts-pocket" && (def === undefined || (def.secrets.length === 0 && !def.stateKey))) continue;
      const record = records[c.service];
      const restarted = record === undefined ? !o.ready.has(unit) : record.startedAt !== c.startedAt || record.container !== c.id;
      if (!o.waiting.has(unit) && !restarted) continue;
      if (unit !== "tts-pocket" && record === undefined && o.ready.has(unit) && !o.waiting.has(unit)) continue;
      const r = await this.deliverTo(c, records);
      if (r?.error) failures.push(r.error);
      else if (r) delivered.push(r.unit);
    }
    try { writeDeliveries(this.o.root, records); } catch (err) { failures.push(`cannot record the deliveries: ${firstLine(err)}`); }
    return { delivered, failures };
  }
}
