/**
 * What each unit of the control plane's manifest may read of the settings: its id and Compose name, the sections (`config`),
 * the credentials (`secrets`), the stored documents (`documents`) and whether it gets a per-unit state key (`stateKey`).
 *
 * This is data only, in this leaf package, so both `@cohost/control` (whose `SERVICE_MANIFEST` takes each unit's settings
 * declarations from here and adds its runtime fields) and `@cohost/store` (which depends on `@cohost/config` alone,
 * settings-store STORE-PKG-002) read the one copy: `config:set` names the units a change reaches (STORE-TASK-002), and the
 * projection loader and the credentials receiver check a unit's reads against it.
 */

/** A stored document a unit may read besides its sections (module-contract MOD-MAN-016). */
export type DocumentName = "personality" | "expressions";

export interface UnitSettings {
  /** The unit id: the heartbeat `service`, the manifest id. */
  id: string;
  /** The docker compose service name; the name of the unit's projection directory. */
  composeName: string;
  /** Dotted config schema paths of the sections this unit reads; the settings editor's section-to-unit map. */
  config: readonly string[];
  /**
   * The secret paths (paths of `SECRET_PATHS`, the wildcard `tools.servers.*.token` included) this unit reads, each inside a
   * section `config` names. The list is explicit, not every secret under the unit's sections. Empty when the unit reads none.
   */
  secrets: readonly string[];
  /** The stored documents the unit reads (MOD-MAN-016). */
  documents: readonly DocumentName[];
  /** Whether the unit persists a credential it obtains at run time and so receives a state key (MOD-MAN-017, STORE-STATE-001). */
  stateKey: boolean;
}

/** The chat-model credentials of the `llm` section: every unit that builds the model client declares them (MOD-MAN-015). */
const LLM_SECRETS = ["llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"] as const;

const unit = (id: string, over: Partial<Omit<UnitSettings, "id">> = {}): UnitSettings =>
  ({ id, composeName: id, config: [], secrets: [], documents: [], stateKey: false, ...over });

/**
 * Every unit of the manifest, in the manifest's order. The compose-only units (infrastructure and model servers) read no
 * setting: their lists are empty.
 */
// @spec MOD-MAN-002, MOD-MAN-015, MOD-MAN-016, MOD-MAN-017
export const UNIT_SETTINGS: readonly UnitSettings[] = [
  unit("chat", {
    config: ["chat", "viewer_text", "cohost", "logging"],
    secrets: ["chat.twitch.client_id", "chat.twitch.client_secret", "chat.twitch.access_token", "chat.twitch.refresh_token", "chat.youtube.api_key"],
    stateKey: true,
  }),
  unit("salience", {
    config: ["brain.salience", "brain.cortex", "brain.working_memory_events", "brain.working_memory_own_lines", "brain.input_limits", "viewer_text", "cohost", "llm", "tools", "logging"],
    secrets: LLM_SECRETS,
  }),
  unit("affect", { config: ["brain.affect", "brain.input_limits", "viewer_text", "cohost", "llm", "logging"], secrets: LLM_SECRETS }),
  unit("memory", { config: ["brain.memory", "brain.input_limits", "viewer_text", "cohost", "llm", "logging"], secrets: LLM_SECRETS, documents: ["personality"] }),
  unit("cortex", {
    config: ["brain.cortex", "brain.memory", "brain.salience", "brain.working_memory_events", "brain.working_memory_own_lines", "brain.input_limits", "viewer_text", "cohost", "llm", "tools", "logging"],
    secrets: LLM_SECRETS, documents: ["personality"],
  }),
  // The MCP tokens and the stream-info credentials; tools reads the chat section but uses no chat user token (TOOL-SVC-010).
  unit("tools", {
    config: ["tools", "cohost", "chat", "viewer_text", "brain.input_limits", "network", "logging"],
    secrets: ["tools.servers.*.token", "chat.twitch.client_id", "chat.twitch.client_secret", "chat.youtube.api_key"],
  }),
  unit("voice", { config: ["voice", "network", "logging"], secrets: ["voice.openai.api_key"] }),
  unit("avatar", { config: ["avatar", "logging"], documents: ["expressions"], stateKey: true }),
  unit("eyes", { config: ["vision", "llm", "network", "logging"], secrets: ["vision.obs.password", ...LLM_SECRETS] }),
  unit("ears", { config: ["ears", "network", "logging"], secrets: ["ears.openai.api_key", "ears.nemotron.api_key", "ears.kyutai.api_key"] }),
  unit("mouth", { config: ["mouth", "logging"] }),
  unit("connector-discord", { config: ["connections", "logging"], secrets: ["connections.discord.token"] }),
  unit("redis"),
  unit("postgres"),
  unit("ollama"),
  unit("tts"),
  unit("stt"),
  unit("tts-pocket"),
  unit("stt-nemotron"),
  unit("stt-kyutai"),
];

/** The settings declarations of one unit, or undefined for an id the manifest does not hold. */
export function unitSettings(id: string): UnitSettings | undefined {
  return UNIT_SETTINGS.find((u) => u.id === id);
}

/**
 * The ids of the units whose `config` declares the section `section`, in manifest order: the units a change to it reaches
 * at their next start (settings-store STORE-TASK-002).
 */
// @spec STORE-TASK-002
export function unitsReadingSection(section: string): string[] {
  return UNIT_SETTINGS.filter((u) => u.config.includes(section)).map((u) => u.id);
}
