/**
 * The service manifest: the ONLY source of ids, compose names, pnpm filters and consumer groups that
 * the runtime adapters may act on. Nothing from a request ever reaches an argv except by picking an
 * entry from this list. See docs/intent/control-plane/control-plane-specs.md.
 */

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

const svc = (
  id: string,
  over: Partial<Omit<ServiceDef, "id" | "composeName">> = {},
): ServiceDef => ({
  id, composeName: id, pnpmFilter: `@cohost/${id}`, groups: [], defaultMode: "resume", infra: false, isolatedEnv: {},
  config: [], uses: [], pause: false, test: { inputs: [], observe: [] }, ...over,
});

const compose = (id: string, over: Partial<Omit<ServiceDef, "id" | "composeName" | "pnpmFilter">> = {}): ServiceDef =>
  ({ ...svc(id, over), pnpmFilter: undefined });

// @spec CTRL-MANIFEST-001, CTRL-MANIFEST-002, CTRL-MANIFEST-003, CTRL-GUARD-008, MOD-MAN-001, MOD-MAN-002, MOD-MAN-003, MOD-MAN-004, MOD-MAN-005
export const SERVICE_MANIFEST: readonly ServiceDef[] = [
  svc("chat", {
    groups: ["chat"], defaultMode: "fresh", isolatedEnv: { CHAT_SOURCE: "fake" },
    config: ["chat"], test: { inputs: ["text"], observe: ["chat.message", "inject.result"] },
  }),
  svc("salience", {
    groups: ["salience"], defaultMode: "fresh",
    config: ["brain.salience", "brain.working_memory_events", "cohost", "llm"], uses: ["affect", "cortex"], pause: true,
    test: { inputs: ["chat.message", "speech.heard", "vision.summary"], observe: ["attention.focus", "brain.say"] },
  }),
  svc("affect", {
    groups: ["affect"], defaultMode: "fresh",
    config: ["brain.affect", "cohost", "llm"], pause: true,
    test: { inputs: ["chat.message", "speech.heard", "vision.summary", "brain.say"], observe: ["affect.state"] },
  }),
  svc("memory", {
    groups: ["memory", "memory-recall", "memory-notes"], isolatedEnv: { MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash" },
    config: ["brain.memory", "cohost", "llm"],
    test: { inputs: ["chat.message", "memory.recall.request"], observe: ["memory.recall.reply", "memory.viewer"] },
  }),
  svc("cortex", {
    requires: ["salience", "affect"], groups: ["cortex"], defaultMode: "fresh", isolatedEnv: { LLM_PROVIDER: "mock" },
    config: ["brain.cortex", "brain.working_memory_events", "cohost", "llm"], uses: ["salience", "affect", "memory"], pause: true,
    test: { inputs: ["attention.focus"], observe: ["brain.status", "brain.say"] },
  }),
  svc("voice", {
    groups: ["voice"], defaultMode: "fresh", isolatedEnv: { VOICE_ENGINE: "stub" },
    config: ["voice"], test: { inputs: ["brain.say"], observe: ["voice.utterance", "voice.playing", "voice.done"] },
  }),
  svc("avatar", {
    groups: ["avatar"], defaultMode: "fresh", isolatedEnv: { AVATAR_DRIVER: "null" },
    config: ["avatar"], uses: ["voice"], test: { inputs: ["brain.say", "affect.state"], observe: ["avatar.state"] },
  }),
  svc("eyes", {
    groups: ["eyes"], defaultMode: "fresh", isolatedEnv: { VISION_ENABLED: "false", VISION_ENGINE: "stub" },
    config: ["vision"], test: { inputs: ["image"], observe: ["vision.summary", "inject.result"] },
  }),
  svc("ears", {
    groups: ["ears"], defaultMode: "fresh", isolatedEnv: { EARS_SOURCE: "off", EARS_STT_ENGINE: "stub" },
    config: ["ears"], test: { inputs: ["audio"], observe: ["speech.heard", "inject.result"] },
  }),
  svc("mouth", {
    groups: ["mouth"], defaultMode: "fresh", isolatedEnv: { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" },
    config: ["mouth"], uses: ["voice"], test: { inputs: ["brain.say"], observe: ["voice.playing", "voice.done", "voice.failed"] },
  }),
  // The Discord connector (CONN-*): a connector, not a bus subscriber, so it owns no consumer group and takes no test input.
  { ...svc("discord", {
    isolatedEnv: { CONNECTIONS_DISCORD_ENABLED: "false" }, config: ["connections"],
  }), composeName: "connector-discord", pnpmFilter: "@cohost/connector-discord" },
  compose("redis", { infra: true }),
  compose("postgres", { infra: true }),
  compose("ollama"),
  compose("tts"),
  compose("stt"),
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
