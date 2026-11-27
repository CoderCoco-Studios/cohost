import type http from "node:http";
import { pass, type Gate } from "./access.js";
import { secretPathMatches, secretPathOf } from "@cohost/config";
import type { Logger } from "@cohost/config";
import type { ServiceDef } from "@cohost/control";
import type { Store } from "@cohost/store";
import { BodyTooLarge, readText } from "./body.js";
import type { StackSnapshot } from "./stack.js";

export interface SecretsDeps {
  /** The one lock (DASH-CTRL-011). */
  gate: Gate;
  /**
   * The settings store: the credentials it holds (paths only), the stored `tools` section (a token is set only for a server it
   * holds) and the one write, which encrypts each value (settings-store STORE-SET-001, STORE-KEY-006).
   */
  store: Pick<Store, "secretPaths" | "settingsTree" | "writeWithRetry">;
  manifest: readonly ServiceDef[];
  /** The latest stack status, for the `restart` list. */
  stack: () => Pick<StackSnapshot, "docker" | "services">;
  log: Pick<Logger, "warn" | "error">;
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

/** The `tools.servers` names of the stored `tools` section, read fresh. */
function savedServerNames(d: SecretsDeps): ReadonlySet<string> {
  const servers = (d.store.settingsTree().tools as { servers?: unknown } | undefined)?.servers;
  return new Set(isObj(servers) ? Object.keys(servers) : []);
}

const SERVER_TOKEN = /^tools\.servers\.(.+)\.token$/;

/** The tail of the write queue: each secret write waits for the one before it (DASH-SECRET-009). */
let queue: Promise<void> = Promise.resolve();

/** True for a set (non-null) of `tools.servers.<name>.token` whose name the saved config does not hold. */
function unknownServerSet(d: SecretsDeps, path: string, value: unknown): boolean {
  if (value === null) return false;
  const m = SERVER_TOKEN.exec(path);
  return m !== null && !savedServerNames(d).has(m[1]!);
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Replaces every occurrence of a submitted value in text bound for a response or a log, as a last line of defence. */
const scrub = (text: string, values: readonly (string | null)[]): string =>
  values.reduce<string>((t, v) => (v ? t.split(v).join("[redacted]") : t), text);

/**
 * `PUT /secrets/:path` sets or clears one secret and `PUT /secrets` several in one store write (settings-store STORE-SET-001,
 * which encrypts each value). Always behind the one gate (DASH-CTRL-011), checked before the path, so a wrong token and an
 * unknown path answer 401 and the right token 404; write-only, and never touches a setting, `.env` or a unit. Writes are applied
 * one after the other in arrival order (DASH-SECRET-009).
 */
// @spec DASH-SECRET-001, DASH-SECRET-002, DASH-SECRET-003, DASH-SECRET-005, DASH-SECRET-006, DASH-SECRET-007, DASH-SECRET-008, DASH-SECRET-009, DASH-SECRET-010, DASH-SECRET-011, DASH-SECRET-012
// @spec DASH-SECRET-013, DASH-SECRET-014, DASH-SECRET-015
export async function handleSecrets(d: SecretsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const multi = url.pathname === "/secrets";
  if (req.method !== "PUT" || !(multi || url.pathname.startsWith("/secrets/"))) return false;

  if (!(await pass(d.gate, req, res, "json"))) return true;
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

  // One write at a time, in arrival order: the pair check reads the credentials the write before it left (DASH-SECRET-009).
  const turn = queue.then(async () => {
    if (changes.some(([p]) => (BEDROCK_PAIR as readonly string[]).includes(p))) {
      const set = new Set(d.store.secretPaths());
      for (const [p, v] of changes) { if (v === null) set.delete(p); else set.add(p); }
      if (set.has(BEDROCK_PAIR[0]) !== set.has(BEDROCK_PAIR[1])) return "pair" as const;
    }
    return d.store.writeWithRetry({ secrets: Object.fromEntries(changes) });
  });
  queue = turn.then(() => undefined, () => undefined);
  let written: Awaited<typeof turn>;
  try {
    written = await turn;
  } catch (e) {
    const detail = scrub(e instanceof Error ? e.message : "the write failed", submitted);
    d.log.error({ detail }, "secret write failed");
    json(res, 500, { ok: false, detail });
    return true;
  }
  if (written === "pair") {
    json(res, 400, { ok: false, detail: `${BEDROCK_PAIR[0]} and ${BEDROCK_PAIR[1]} must be set or cleared together: with only one of them set the services that build the model client refuse to start`, paths: [...BEDROCK_PAIR] });
    return true;
  }
  if (!written.ok) {
    // A server the tools section no longer holds (the store checks it inside its transaction) is an unknown secret; any other
    // refusal names the path, never a value.
    const issues = written.conflict ? [] : written.issues;
    const ghosts = issues.filter((i) => /holds no server/.test(i.message)).map((i) => i.path);
    if (ghosts.length) json(res, 404, multi ? { ...UNKNOWN, paths: ghosts } : UNKNOWN);
    else json(res, 500, { ok: false, detail: scrub(issues.map((i) => `${i.path}: ${i.message}`).join("; ") || "the write failed", submitted) });
    return true;
  }

  const restart = restartFor(d, changes.map(([p]) => p));
  json(res, 200, multi
    ? { ok: true, set: Object.fromEntries(changes.map(([p, v]) => [p, v !== null])), restart }
    : { ok: true, set: changes[0]![1] !== null, restart });
  return true;
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
