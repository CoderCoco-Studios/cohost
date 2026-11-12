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
}

const svc = (
  id: string,
  over: Partial<Omit<ServiceDef, "id" | "composeName">> = {},
): ServiceDef => ({
  id, composeName: id, pnpmFilter: `@cohost/${id}`, groups: [], defaultMode: "resume", infra: false, isolatedEnv: {}, ...over,
});

const compose = (id: string, over: Partial<Omit<ServiceDef, "id" | "composeName" | "pnpmFilter">> = {}): ServiceDef =>
  ({ ...svc(id, over), pnpmFilter: undefined });

// @spec CTRL-MANIFEST-001, CTRL-MANIFEST-002, CTRL-MANIFEST-003, CTRL-GUARD-008
export const SERVICE_MANIFEST: readonly ServiceDef[] = [
  svc("chat", { groups: ["chat"], defaultMode: "fresh", isolatedEnv: { CHAT_SOURCE: "fake" } }),
  svc("salience", { groups: ["salience"], defaultMode: "fresh" }),
  svc("affect", { groups: ["affect"], defaultMode: "fresh" }),
  svc("memory", { groups: ["memory", "memory-recall", "memory-notes"], isolatedEnv: { MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash" } }),
  svc("cortex", { requires: ["salience", "affect"], groups: ["cortex"], defaultMode: "fresh", isolatedEnv: { LLM_PROVIDER: "mock" } }),
  svc("voice", { groups: ["voice"], defaultMode: "fresh", isolatedEnv: { VOICE_ENGINE: "stub" } }),
  svc("avatar", { groups: ["avatar"], defaultMode: "fresh", isolatedEnv: { AVATAR_DRIVER: "null" } }),
  svc("eyes", { groups: ["eyes"], defaultMode: "fresh", isolatedEnv: { VISION_ENABLED: "false", VISION_ENGINE: "stub" } }),
  svc("ears", { groups: ["ears"], defaultMode: "fresh", isolatedEnv: { EARS_SOURCE: "off", EARS_STT_ENGINE: "stub" } }),
  svc("mouth", { groups: ["mouth"], defaultMode: "fresh", isolatedEnv: { MOUTH_DISCORD_ENABLED: "false", MOUTH_DRYRUN_ENABLED: "true" } }),
  compose("redis", { infra: true }),
  compose("postgres", { infra: true }),
  compose("ollama"),
  compose("tts"),
  compose("stt"),
];

/** The public face of a unit, as `GET /services/manifest` lists it: no argv material, no compose or pnpm names. */
export interface UnitDescriptor { id: string; requires: string[]; infra: boolean; defaultMode: StartMode }

export function unitDescriptors(manifest: readonly ServiceDef[] = SERVICE_MANIFEST): UnitDescriptor[] {
  return manifest.map((s) => ({ id: s.id, requires: [...(s.requires ?? [])], infra: s.infra, defaultMode: s.defaultMode }));
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
