/**
 * The service manifest: the ONLY source of ids, compose names, pnpm filters and consumer groups that
 * the runtime adapters may act on. Nothing from a request ever reaches an argv except by picking an
 * entry from this list. See docs/intent/control-plane/control-plane-specs.md.
 *
 * Each unit's settings declarations (`config`, `secrets`, `documents`, `stateKey`) and its Compose name come from
 * `UNIT_SETTINGS` in `@cohost/config`, the leaf the settings store reads too; this file adds the runtime fields.
 */
import { UNIT_SETTINGS, type DocumentName, type UnitSettings } from "@cohost/config";

export type StartMode = "resume" | "fresh";

export interface ServiceDef {
  /** Canonical service name (also the heartbeat `service` and the compose service name). */
  id: string;
  /** docker compose service name. */
  composeName: string;
  /** pnpm workspace filter, e.g. `@cohost/cortex`; undefined for compose-only services (ollama, tts, stt, ...). */
  pnpmFilter?: string;
  /** Redis consumer groups on `cohost:events` that a "fresh" start resets to `$`. */
  groups: readonly string[];
  /** Start mode when the caller does not pick one. */
  defaultMode: StartMode;
  /** redis/postgres: read-only unless CONTROL_ADVANCED=1. */
  infra: boolean;
  /** Units an isolated start of this unit also starts (transitively); never applied to restart or stop. */
  requires?: readonly string[];
  /** Env presets (add-isolated-backends) applied by an "isolated" start: one service, no external backends. */
  isolatedEnv: Readonly<Record<string, string>>;
  /** Dotted config schema paths of the sections this unit reads; the settings editor's section-to-unit map. */
  config: readonly string[];
  /**
   * The secret paths (paths of `SECRET_PATHS`, the wildcard `tools.servers.*.token` included) this unit reads, each inside a
   * section `config` names. The control plane projects exactly these into the unit's container (deployment DEPLOY-SECRET-003);
   * the list is explicit, not every secret under the unit's sections. Empty when the unit reads none.
   */
  secrets: readonly string[];
  /** The stored documents (`personality`, `expressions`) this unit reads (MOD-MAN-016). */
  documents: readonly DocumentName[];
  /** Whether the unit receives a per-unit state key to encrypt a credential it obtains at run time (MOD-MAN-017). */
  stateKey: boolean;
  /** Units whose absence degrades one of this unit's features; `requires` is the subset an isolated start brings up. */
  uses: readonly string[];
  /** Whether the unit honours the `pause` and `resume` control commands. */
  pause: boolean;
  /** What the dashboard may feed the unit and which events show its reaction. */
  test: UnitTest;
}

export interface UnitTest {
  /** Service-level injection kinds (`text`, `image`, `audio`) or bus event types. */
  inputs: readonly string[];
  /** Bus event types that show the unit's reaction. */
  observe: readonly string[];
}

/** The runtime fields a manifest entry sets; the settings declarations come from `UNIT_SETTINGS`. */
type RuntimeFields = Partial<Omit<ServiceDef, "id" | "composeName" | keyof UnitSettings>>;

/** The settings declarations of `id`; an id `UNIT_SETTINGS` lacks is a programming error. */
function declared(id: string): Pick<ServiceDef, "composeName" | "config" | "secrets" | "documents" | "stateKey"> {
  const u = UNIT_SETTINGS.find((x) => x.id === id);
  if (u === undefined) throw new Error(`manifest unit ${id} has no entry in UNIT_SETTINGS (@cohost/config)`);
  return { composeName: u.composeName, config: u.config, secrets: u.secrets, documents: u.documents, stateKey: u.stateKey };
}

const svc = (id: string, over: RuntimeFields = {}): ServiceDef => ({
  id, pnpmFilter: `@cohost/${id}`, groups: [], defaultMode: "resume", infra: false, isolatedEnv: {},
  uses: [], pause: false, test: { inputs: [], observe: [] }, ...over, ...declared(id),
});

const compose = (id: string, over: Omit<RuntimeFields, "pnpmFilter"> = {}): ServiceDef =>
  ({ ...svc(id, over), pnpmFilter: undefined });

// @spec CTRL-MANIFEST-001, CTRL-MANIFEST-002, CTRL-MANIFEST-003, CTRL-GUARD-008, MOD-MAN-001, MOD-MAN-002, MOD-MAN-003, MOD-MAN-004, MOD-MAN-005, CTRL-MANIFEST-006, MOD-MAN-013, MOD-MAN-014, MOD-MAN-015, MOD-MAN-016, MOD-MAN-017
export const SERVICE_MANIFEST: readonly ServiceDef[] = [
  svc("chat", {
    groups: ["chat"], defaultMode: "fresh", isolatedEnv: { CHAT_SOURCES: "[fake]" },
    test: { inputs: ["text"], observe: ["chat.message", "inject.result"] },
  }),
  svc("salience", {
    groups: ["salience"], defaultMode: "fresh", uses: ["affect", "cortex"], pause: true,
    test: { inputs: ["chat.message", "speech.heard", "vision.summary"], observe: ["attention.focus", "brain.say"] },
  }),
  svc("affect", {
    groups: ["affect"], defaultMode: "fresh", pause: true,
    test: { inputs: ["chat.message", "speech.heard", "vision.summary", "brain.say"], observe: ["affect.state"] },
  }),
  svc("memory", {
    groups: ["memory", "memory-recall", "memory-notes"], isolatedEnv: { MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash" },
    test: { inputs: ["chat.message", "memory.recall.request"], observe: ["memory.recall.reply", "memory.viewer"] },
  }),
  svc("cortex", {
    requires: ["salience", "affect"], groups: ["cortex"], defaultMode: "fresh", isolatedEnv: { LLM_PROVIDER: "mock" },
    uses: ["salience", "affect", "memory", "tools"], pause: true,
    test: { inputs: ["attention.focus"], observe: ["brain.status", "brain.say"] },
  }),
  // The tool-calling unit (services/tools, TOOL-SVC-*): it answers a tool call from cortex over the bus and reads no
  // model server. Its isolated start uses canned results (TOOLS_MODE=mock) and brings up no other unit.
  svc("tools", {
    groups: ["tools"], defaultMode: "fresh", isolatedEnv: { TOOLS_MODE: "mock" }, uses: ["memory"],
    test: { inputs: ["text"], observe: ["tool.result", "inject.result"] },
  }),
  svc("voice", {
    groups: ["voice"], defaultMode: "fresh", isolatedEnv: { VOICE_ENGINE: "stub" },
    test: { inputs: ["brain.say"], observe: ["voice.utterance", "voice.playing", "voice.done"] },
  }),
  svc("avatar", {
    groups: ["avatar"], defaultMode: "fresh", isolatedEnv: { AVATAR_DRIVER: "null" },
    uses: ["voice"], test: { inputs: ["brain.say", "affect.state"], observe: ["avatar.state"] },
  }),
  svc("eyes", {
    groups: ["eyes"], defaultMode: "fresh", isolatedEnv: { VISION_ENABLED: "false", VISION_PROVIDER: "stub" },
    test: { inputs: ["image"], observe: ["vision.summary", "inject.result"] },
  }),
  svc("ears", {
    groups: ["ears"], defaultMode: "fresh", isolatedEnv: { EARS_SOURCES: "[]", EARS_STT_ENGINE: "stub" },
    test: { inputs: ["audio"], observe: ["speech.heard", "inject.result"] },
  }),
  svc("mouth", {
    groups: ["mouth"], defaultMode: "fresh", isolatedEnv: { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" },
    uses: ["voice"], test: { inputs: ["brain.say"], observe: ["voice.playing", "voice.done", "voice.failed"] },
  }),
  // The Discord connector (CONN-*): it subscribes to `inject.request` only, for its test input (CONN-INJ-001), so its one
  // group is that subscription's. Its unit id is the process name; the platform name `discord` is its connector id, tags and
  // config section. The injected clip is answered with Discord off, so the isolation preset keeps the input working.
  svc("connector-discord", {
    groups: ["connector-discord"], defaultMode: "fresh", isolatedEnv: { CONNECTIONS_DISCORD_ENABLED: "false" },
    test: { inputs: ["audio"], observe: ["inject.result"] },
  }),
  compose("redis", { infra: true }),
  compose("postgres", { infra: true }),
  compose("ollama"),
  compose("tts"),
  compose("stt"),
  // The optional speech engine servers (profiles pocket, nemotron, kyutai): compose-only units that no unit uses or requires,
  // so a profile that is not enabled never annotates voice or ears (CTRL-MANIFEST-006, MOD-MAN-013, MOD-MAN-014).
  compose("tts-pocket"),
  compose("stt-nemotron"),
  compose("stt-kyutai"),
];

/** The public face of a unit, as `GET /services/manifest` lists it: no argv material, no compose or pnpm names. */
export interface UnitDescriptor {
  id: string; config: string[]; uses: string[]; requires: string[]; pause: boolean; test: UnitTest; infra: boolean; defaultMode: StartMode;
}

export function unitDescriptors(manifest: readonly ServiceDef[] = SERVICE_MANIFEST): UnitDescriptor[] {
  return manifest.map((s) => ({
    id: s.id, config: [...s.config], uses: [...s.uses], requires: [...(s.requires ?? [])], pause: s.pause,
    test: { inputs: [...s.test.inputs], observe: [...s.test.observe] }, infra: s.infra, defaultMode: s.defaultMode,
  }));
}

// @spec CTRL-MANIFEST-004
export function findService(id: string, manifest: readonly ServiceDef[] = SERVICE_MANIFEST): ServiceDef | undefined {
  return manifest.find((s) => s.id === id);
}

/**
 * Ids of the application units (those run from the pnpm workspace, which publish a heartbeat): the one list the health
 * tracker's default known names and `cohostctl status` use. The host-run dashboard is not a unit.
 */
// @spec CTRL-MANIFEST-005, MOD-MAN-006
export function appServiceIds(manifest: readonly ServiceDef[] = SERVICE_MANIFEST): string[] {
  return manifest.filter((s) => s.pnpmFilter !== undefined).map((s) => s.id);
}
