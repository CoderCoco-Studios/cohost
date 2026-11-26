import type http from "node:http";
import { readFileSync } from "node:fs";
import { secretPathMatches, secretPathOf, secretsPath, setSecretPaths, toolServerNames, updateSecrets } from "@cohost/config";
import type { Logger } from "@cohost/config";
import type { ServiceDef } from "@cohost/control";
import { NO_TOKEN_DETAIL, tokenRefusal, type TokenGate } from "./access.js";
import { BodyTooLarge, readText } from "./body.js";
import type { StackSnapshot } from "./stack.js";

export interface SecretsDeps {
  /** Who must present the control token (DASH-SECRET-003, DASH-CTRL-011). */
  gate: TokenGate;
  /** The operator's secrets file (`secrets/secrets.yaml`). Defaults to the loader's. */
  file?: () => string;
  /** Path of the saved `config.yaml`, read per request: a token is set only for a server it holds under `tools.servers`. */
  config: () => string;
  manifest: readonly ServiceDef[];
  /** The latest stack status, for the `restart` list. */
  stack: () => Pick<StackSnapshot, "docker" | "services">;
  log: Pick<Logger, "warn" | "error">;
}

/** `CONTROL_TOKEN` from the process environment in either control mode: undefined when unset or blank. */
// @spec DASH-SECRET-004
export function controlTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.CONTROL_TOKEN !== undefined && env.CONTROL_TOKEN.trim() !== "" ? env.CONTROL_TOKEN : undefined;
}

/** The two credentials a Bedrock client needs together; exactly one set makes the services that build it refuse to start. */
export const BEDROCK_PAIR = ["llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"] as const;

const UNKNOWN = { ok: false, detail: "unknown secret" } as const;

const json = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
};

/**
 * A value that is `null`, or a string non-empty after trimming with no control character inside (C0 and DEL, so no line
 * break, NUL or tab); otherwise why not. The page refuses the same characters before it sends.
 */
// @spec DASH-SECRET-006
function checkValue(v: unknown): { ok: true; value: string | null } | { ok: false; why: string } {
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, why: "value must be a string, or null to clear the secret" };
  const trimmed = v.trim();
  if (trimmed === "") return { ok: false, why: "value is empty after trimming; to remove a secret, send null" };
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, why: "value must be a single line of printable characters" };
  return { ok: true, value: trimmed };
}

/** The `tools.servers` names of the saved config.yaml, read fresh; none when the file is missing or unreadable. */
function savedServerNames(d: SecretsDeps): ReadonlySet<string> {
  try { return new Set(toolServerNames(readFileSync(d.config(), "utf8"))); } catch { return new Set(); }
}

const SERVER_TOKEN = /^tools\.servers\.(.+)\.token$/;

/** True for a set (non-null) of `tools.servers.<name>.token` whose name the saved config does not hold. */
function unknownServerSet(d: SecretsDeps, path: string, value: unknown): boolean {
  if (value === null) return false;
  const m = SERVER_TOKEN.exec(path);
  // config.yaml is read only for a server token: every other secret path never locates it (DASH-SECRET-010)
  return m !== null && !savedServerNames(d).has(m[1]!);
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Replaces every occurrence of a submitted value in text bound for a response or a log, as a last line of defence. */
const scrub = (text: string, values: readonly (string | null)[]): string =>
  values.reduce<string>((t, v) => (v ? t.split(v).join("[redacted]") : t), text);

/**
 * `PUT /secrets/:path` sets or clears one secret and `PUT /secrets` several in one atomic write, in `secrets/secrets.yaml`
 * through `updateSecrets`. Gated by the control token where it is required (checked before the path, so there a wrong token
 * and an unknown path answer 401 and the right token 404), write-only, and never touches `config.yaml` or `.env` or a unit.
 */
// @spec DASH-SECRET-001, DASH-SECRET-002, DASH-SECRET-003, DASH-SECRET-004, DASH-SECRET-005, DASH-SECRET-006, DASH-SECRET-007, DASH-SECRET-008, DASH-SECRET-009, DASH-SECRET-010, DASH-SECRET-011, DASH-SECRET-012
// @spec DASH-SECRET-013, DASH-SECRET-014, DASH-SECRET-015
export async function handleSecrets(d: SecretsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const multi = url.pathname === "/secrets";
  if (req.method !== "PUT" || !(multi || url.pathname.startsWith("/secrets/"))) return false;

  if (refuseSecretToken(res, tokenRefusal(d.gate, req.headers.authorization))) { req.resume(); return true; }
  let raw: string;
  try { raw = await readText(req); } catch (e) {
    if (e instanceof BodyTooLarge) { json(res, 413, { ok: false, detail: "body too large" }); return true; }
    throw e;
  }

  let changes: [string, string | null][];
  if (multi) {
    const parsed = parseObject(raw);
    const values = parsed?.["values"];
    if (!isObj(values) || Object.keys(values).length === 0) {
      json(res, 400, { ok: false, detail: "the body must be { values: { <secret path>: <string | null>, ... } } with at least one path" });
      return true;
    }
    const entries = Object.entries(values);
    const unknown = entries.map(([p]) => p).filter((p) => secretPathOf(p) === undefined);
    if (unknown.length) { json(res, 404, { ...UNKNOWN, paths: unknown }); return true; }
    const ghosts = entries.filter(([p, v]) => unknownServerSet(d, p, v)).map(([p]) => p);
    if (ghosts.length) { json(res, 404, { ...UNKNOWN, paths: ghosts }); return true; }
    changes = [];
    for (const [p, v] of entries) {
      const c = checkValue(v);
      if (!c.ok) { json(res, 400, { ok: false, detail: `${p}: ${c.why}`, paths: [p] }); return true; }
      changes.push([p, c.value]);
    }
  } else {
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice("/secrets/".length)); } catch { json(res, 404, UNKNOWN); return true; }
    if (secretPathOf(path) === undefined) { json(res, 404, UNKNOWN); return true; }
    const parsed = parseObject(raw);
    if (!parsed || !("value" in parsed)) { json(res, 400, { ok: false, detail: "the body must be { value: <string | null> }" }); return true; }
    if (unknownServerSet(d, path, parsed["value"])) { json(res, 404, UNKNOWN); return true; }
    const c = checkValue(parsed["value"]);
    if (!c.ok) { json(res, 400, { ok: false, detail: c.why }); return true; }
    changes = [[path, c.value]];
  }
  const submitted = changes.map(([, v]) => v);

  // From here to the write nothing awaits, so two requests in flight are applied one after the other.
  const file = (d.file ?? secretsPath)();
  try {
    if (changes.some(([p]) => (BEDROCK_PAIR as readonly string[]).includes(p))) {
      const set = new Set(setSecretPaths(file));
      for (const [p, v] of changes) { if (v === null) set.delete(p); else set.add(p); }
      if (set.has(BEDROCK_PAIR[0]) !== set.has(BEDROCK_PAIR[1])) {
        json(res, 400, { ok: false, detail: `${BEDROCK_PAIR[0]} and ${BEDROCK_PAIR[1]} must be set or cleared together: with only one of them set the services that build the model client refuse to start`, paths: [...BEDROCK_PAIR] });
        return true;
      }
    }
    updateSecrets(file, Object.fromEntries(changes));
  } catch (e) {
    const detail = scrub(e instanceof Error ? e.message : "the write failed", submitted);
    d.log.error({ detail }, "secret write failed");
    json(res, 500, { ok: false, detail });
    return true;
  }

  const restart = restartFor(d, changes.map(([p]) => p));
  json(res, 200, multi
    ? { ok: true, set: Object.fromEntries(changes.map(([p, v]) => [p, v !== null])), restart }
    : { ok: true, set: changes[0]![1] !== null, restart });
  return true;
}

/**
 * Answers the control-token refusal of the secret routes, shared by recovery mode's token check (DASH-RCV-022): 403 naming
 * `CONTROL_TOKEN` and `CONTROL_ENABLED` when none is configured, 401 with `www-authenticate: Bearer` when the request's is
 * missing or wrong. True when it answered.
 */
// @spec DASH-SECRET-003, DASH-SECRET-004
export function refuseSecretToken(res: http.ServerResponse, refusal: "none" | "wrong" | undefined): boolean {
  if (refusal === "none") { json(res, 403, { ok: false, detail: NO_TOKEN_DETAIL }); return true; }
  if (refusal === "wrong") { json(res, 401, { ok: false, detail: "unauthorized" }, { "www-authenticate": "Bearer" }); return true; }
  return false;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return undefined; }
  return isObj(j) ? j : undefined;
}

/** The units whose manifest `secrets` list declares any of `paths` and that the latest stack status shows running, in manifest order. */
// @spec DASH-SECRET-001, DASH-SECRET-013
function restartFor(d: SecretsDeps, paths: readonly string[]): string[] {
  const stack = d.stack();
  if (!stack.docker.ok) return [];
  const running = new Set(stack.services.filter((s) => s.status === "running").map((s) => s.service));
  return d.manifest.filter((u) => running.has(u.id) && u.secrets.some((declared) => paths.some((p) => secretPathMatches(p, declared)))).map((u) => u.id);
}
