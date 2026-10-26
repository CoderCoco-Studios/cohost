/**
 * The service manifest: the ONLY source of ids, compose names, pnpm filters and consumer groups that
 * the runtime adapters may act on. Nothing from a request ever reaches an argv except by picking an
 * entry from this list. See openspec/specs/service-control.
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
  /** The dashboard: it may not stop or restart itself. */
  self: boolean;
  /** Env presets (add-isolated-backends) applied by an "isolated" start: one service, no external backends. */
  isolatedEnv: Readonly<Record<string, string>>;
}

const svc = (
  id: string,
  over: Partial<Omit<ServiceDef, "id" | "composeName">> = {},
): ServiceDef => ({
  id, composeName: id, pnpmFilter: `@cohost/${id}`, groups: [], defaultMode: "resume", infra: false, self: false, isolatedEnv: {}, ...over,
});

const compose = (id: string, over: Partial<Omit<ServiceDef, "id" | "composeName" | "pnpmFilter">> = {}): ServiceDef =>
  ({ ...svc(id, over), pnpmFilter: undefined });

export const SERVICE_MANIFEST: readonly ServiceDef[] = [
  svc("chat", { isolatedEnv: { CHAT_SOURCE: "fake" } }),
  svc("salience", { groups: ["salience"], defaultMode: "fresh" }),
  svc("affect", { groups: ["affect"], defaultMode: "fresh" }),
  svc("memory", { groups: ["memory", "memory-recall"], isolatedEnv: { MEMORY_STORE: "memory", MEMORY_EMBEDDER: "hash" } }),
  svc("cortex", { groups: ["cortex"], defaultMode: "fresh", isolatedEnv: { LLM_PROVIDER: "mock" } }),
  svc("voice", { groups: ["voice"], defaultMode: "fresh", isolatedEnv: { VOICE_ENGINE: "stub" } }),
  svc("avatar", { groups: ["avatar"], defaultMode: "fresh", isolatedEnv: { AVATAR_DRIVER: "null" } }),
  svc("eyes", { isolatedEnv: { VISION_ENABLED: "false" } }),
  svc("ears", { groups: ["ears"], isolatedEnv: { EARS_SOURCE: "off" } }),
  svc("dashboard", { self: true }),
  compose("redis", { infra: true }),
  compose("postgres", { infra: true }),
  compose("ollama"),
  compose("tts"),
  compose("stt"),
];

export function findService(id: string, manifest: readonly ServiceDef[] = SERVICE_MANIFEST): ServiceDef | undefined {
  return manifest.find((s) => s.id === id);
}
