/**
 * The catalog: every tool the service knows, its label, effect, marks, pin and offer state, and each server's
 * state. Built from the config the service loaded at start and the sources it was given (TOOL-CAT-001 to TOOL-CAT-015).
 */
import { createHash } from "node:crypto";
import type { EventInput } from "@cohost/bus";
import { offLanHost, type Config } from "@cohost/config";
import type { SourceState, SourceTool, ToolSource } from "./source.js";

export type Mode = "live" | "mock";
export type Label = "read" | "acts" | "unlabelled";
export type Effect = "read" | "acts";
export type CatalogReason = "not_enabled" | "acts_not_allowed" | "not_approved" | "changed" | "server_down";
export type DepStatus = "ok" | "down" | "n/a";

/** The fixed limits of a listed tool (TOOL-CAT-002, TOOL-CAT-003): not settings. */
export const DESCRIPTION_MAX = 400;
export const TITLE_MAX = 100;
export const SCHEMA_MAX = 4000;
/** The deepest an argument schema may nest, counting the schema itself as one object or array (TOOL-CAT-002). */
export const SCHEMA_DEPTH_MAX = 64;
export const QUALIFIED_NAME_MAX = 64;

const PART = /^[A-Za-z0-9_-]+$/;

/** The one cut of a server's title and description: the value shown, and the value the pin hashes (TOOL-PIN-001). */
// @spec TOOL-CAT-003
export function cutTitle(s: string): string { return s.slice(0, TITLE_MAX); }
export function cutDescription(s: string): string { return s.slice(0, DESCRIPTION_MAX); }

/** JSON with the keys of every object sorted in code-unit order and no whitespace outside strings (TOOL-PIN-001). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * The pinned hash of an MCP definition: lower-case hex SHA-256 of the canonical JSON of its qualified name, its cut
 * title (absent when none), its cut description, its schema and its label (TOOL-PIN-001). The catalog computes it from
 * each listed definition in live mode, so a source cannot supply or skip the pin.
 */
// @spec TOOL-PIN-001
export function definitionHash(d: { name: string; title?: string | undefined; description: string; parameters: Record<string, unknown>; label: Label }): string {
  const cut = { name: d.name, title: d.title === undefined ? undefined : cutTitle(d.title), description: cutDescription(d.description), parameters: d.parameters, label: d.label };
  return createHash("sha256").update(canonicalJson(cut), "utf8").digest("hex");
}

/** The label of a listed tool from its server's `readOnlyHint` (TOOL-CAT-005). */
export function labelOf(readOnlyHint: boolean | undefined): Label {
  return readOnlyHint === true ? "read" : readOnlyHint === false ? "acts" : "unlabelled";
}

/** The effect every rule that depends on effect uses (TOOL-CAT-008). */
export function effectOf(label: Label, acts: boolean): Effect {
  return label !== "read" || acts ? "acts" : "read";
}

/** A tool the catalog lists, with what the pipeline and the publication need. */
export interface KnownTool {
  name: string;
  server: string;
  /** The source's own name for the tool. */
  own: string;
  source: ToolSource;
  title?: string;
  description: string;
  parameters: Record<string, unknown>;
  label: Label;
  effect: Effect;
  enabled: boolean;
  acts: boolean;
  chat: boolean;
  confirm: boolean;
  /** The pin of the definition the server lists now (TOOL-PIN-002); absent in mock mode, where no pin is checked. */
  hash?: string;
  /** The hash the owner approved (`tools.allow.<name>.hash`); empty when none. */
  recordedHash: string;
  serverState: SourceState;
  offered: boolean;
  reason?: CatalogReason;
}

export interface CatalogServer {
  name: string;
  state: SourceState;
  external: boolean;
  /** The tools of the server the catalog left out (TOOL-CAT-014). */
  leftOut: number;
  detail: string;
}

export interface Snapshot {
  mode: Mode;
  tools: KnownTool[];
  servers: CatalogServer[];
  byName: Map<string, KnownTool>;
  /** The qualified names of every enabled `tools.allow` entry, listed or not (TOOL-MCP-010): a server with one is a dependency. */
  enabledNames: string[];
}

/**
 * Whether an argument schema can be listed: it serializes to at most 4000 characters and nests at most 64 levels deep. The
 * serialization is guarded, and the depth is walked without recursion, so a hostile schema is refused and never throws
 * (TOOL-CAT-002).
 */
// @spec TOOL-CAT-002
export function schemaListable(schema: unknown): boolean {
  let text: string | undefined;
  try { text = JSON.stringify(schema); } catch { return false; }
  if (text === undefined || text.length > SCHEMA_MAX) return false;
  const stack: [unknown, number][] = [[schema, 1]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (depth > SCHEMA_DEPTH_MAX) return false;
    const kids = Array.isArray(v) ? v : v !== null && typeof v === "object" ? Object.values(v) : [];
    for (const kid of kids) if (kid !== null && typeof kid === "object") stack.push([kid, depth + 1]);
  }
  return true;
}

const hostOf = (url: string): string | undefined => {
  try { return new URL(url).hostname; } catch { return undefined; }
};

/**
 * Whether a configured server is external: its host is off the LAN by the LAN rule, or `external` is set, or its URL has no
 * readable host (TOOL-MCP-009). The egress entry of the server uses the same rule (CFG-EGR-014).
 */
// @spec TOOL-MCP-009
export function serverExternal(entry: { url: string; external: boolean }, lan: readonly string[]): boolean {
  const host = hostOf(entry.url);
  return entry.external || (host === undefined ? true : offLanHost(host, lan));
}

const STATE_WORDS: Record<SourceState, string> = { ok: "connected", down: "not connected", auth: "refused its credential", mock: "mock server" };

/**
 * Builds the catalog. `sources` is every source the service has, in any order; the servers are taken from
 * `tools.servers` in its order, and a configured server with no source is `down`. A tool that cannot be listed
 * (a bad name part, a long qualified name, a schema over 4000 characters) and a tool past a limit are left out and
 * counted in the server's detail (TOOL-CAT-002, TOOL-CAT-013, TOOL-CAT-014). The per-server limit counts listable
 * tools only.
 */
// @spec TOOL-CAT-001, TOOL-CAT-002, TOOL-CAT-003, TOOL-CAT-005, TOOL-CAT-006, TOOL-CAT-007, TOOL-CAT-008, TOOL-CAT-009, TOOL-CAT-010, TOOL-CAT-013, TOOL-CAT-014, TOOL-CAT-015, TOOL-PIN-003, TOOL-PIN-004, TOOL-PIN-005
export function buildSnapshot(cfg: Config, sources: readonly ToolSource[], mode: Mode): Snapshot {
  const lan = cfg.network?.lan ?? [];
  const bySource = new Map(sources.map((s) => [s.name, s] as const));
  const tools: KnownTool[] = [];
  const byName = new Map<string, KnownTool>();
  const servers: CatalogServer[] = [];
  let total = 0;

  for (const [server, entry] of Object.entries(cfg.tools.servers)) {
    const source = bySource.get(server);
    const state: SourceState = mode === "mock" ? "mock" : source ? source.state : "down";
    // Mock mode reaches no server and ignores `tools.servers.<name>.external`: no server is external there.
    const external = mode === "mock" ? false : serverExternal(entry, lan);
    let listed = 0;
    let left = 0;
    for (const def of source?.list() ?? []) {
      if (source === undefined) break; // unreachable: an absent source lists nothing
      const name = `${server}__${def.name}`;
      // The cheap checks come first: the limits are counted before any schema is serialized, so a server with thousands of
      // tools costs one check per tool it may list (TOOL-CAT-013, TOOL-CAT-014).
      if (!PART.test(server) || !PART.test(def.name) || name.length > QUALIFIED_NAME_MAX) {
        left++;
        continue;
      }
      if (listed >= cfg.tools.max_tools_per_server || total >= cfg.tools.max_tools) {
        left++;
        continue;
      }
      if (!schemaListable(def.parameters)) {
        left++;
        continue;
      }
      // One tool whose definition cannot be read leaves the snapshot whole: it is left out and counted (TOOL-CAT-002).
      let known: KnownTool;
      try {
        known = listTool(cfg, source, server, name, def, state, mode);
      } catch {
        left++;
        continue;
      }
      listed++;
      total++;
      tools.push(known);
      byName.set(name, known);
    }
    const parts = [STATE_WORDS[state], `${listed} tools listed`];
    if (left > 0) parts.push(`${left} left out`);
    if (source?.detail) parts.push(source.detail);
    servers.push({ name: server, state, external, leftOut: left, detail: parts.join("; ") });
  }
  const enabledNames = Object.entries(cfg.tools.allow).filter(([, a]) => a.enabled).map(([name]) => name);
  return { mode, tools, servers, byName, enabledNames };
}

function listTool(cfg: Config, source: ToolSource, server: string, name: string, def: SourceTool, state: SourceState, mode: Mode): KnownTool {
  const allow = cfg.tools.allow[name];
  const enabled = allow?.enabled ?? false;
  const acts = allow?.acts ?? false;
  const recordedHash = allow?.hash ?? "";
  const label = labelOf(def.readOnlyHint);
  const effect = effectOf(label, acts);
  const hash = mode === "live"
    ? definitionHash({ name, title: def.title, description: def.description, parameters: def.parameters, label })
    : undefined;
  const known: KnownTool = {
    name, server, own: def.name, source,
    description: cutDescription(def.description), parameters: def.parameters,
    label, effect, enabled, acts, chat: allow?.chat ?? false, confirm: allow?.confirm ?? true,
    recordedHash, serverState: state, offered: false,
  };
  if (def.title !== undefined) known.title = cutTitle(def.title);
  if (hash !== undefined) known.hash = hash;
  // The order of the reasons (TOOL-CAT-007): the first that applies.
  let reason: CatalogReason | undefined;
  if (!enabled) reason = "not_enabled";
  else if (label !== "read" && !acts) reason = "acts_not_allowed";
  else if (mode === "live" && recordedHash === "") reason = "not_approved";
  else if (mode === "live" && hash !== recordedHash) reason = "changed";
  else if (state === "down" || state === "auth") reason = "server_down";
  if (reason === undefined) known.offered = true;
  else known.reason = reason;
  return known;
}

/** The catalog entry as `tool.catalog` carries it: the members of TOOL-CAT-009 that apply, and no unset one. */
export function publishedTool(t: KnownTool): EventInput<"tool.catalog">["tools"][number] {
  return {
    name: t.name,
    server: t.server,
    ...(t.title !== undefined ? { title: t.title } : {}),
    description: t.description,
    parameters: t.parameters,
    label: t.label,
    effect: t.effect,
    enabled: t.enabled,
    acts: t.acts,
    chat: t.chat,
    confirm: t.confirm,
    ...(t.hash !== undefined ? { hash: t.hash } : {}),
    offered: t.offered,
    ...(t.reason !== undefined ? { reason: t.reason } : {}),
  };
}

/** The published server entries (TOOL-CAT-010). */
export function publishedServers(s: Snapshot): EventInput<"tool.catalog">["servers"] {
  return s.servers.map((x) => ({ name: x.name, state: x.state, external: x.external, left_out: x.leftOut, detail: x.detail }));
}
