import type http from "node:http";
import { loadConfig } from "@cohost/config";

/** How long a pick-list route waits for its backing server, connection and body together. */
export const OPTIONS_TIMEOUT_MS = 3000;
/** The most a pick-list route reads from its backing server. */
export const OPTIONS_MAX_BYTES = 1024 * 1024;

export interface OptionsDeps {
  /** The backing servers' base URLs: the service-URL helpers, never a request's text or a config value a caller can change. */
  urls: { tts: () => string; ollama: () => string };
  /** Defaults to `OPTIONS_TIMEOUT_MS`; tests shorten it. */
  timeoutMs?: number;
}

/** A refusal the route answers 502: `detail` names the cause and carries no text the upstream sent. */
class Upstream extends Error {}

const json = (res: http.ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};

/** The body as text, up to the cap, within the one deadline `signal` carries. */
async function readCapped(body: ReadableStream<Uint8Array> | null, who: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body?.getReader();
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- the reader is fixed; the loop ends at the stream's end, by break, or at the cap, by throw
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > OPTIONS_MAX_BYTES) { void reader.cancel().catch(() => {}); throw new Upstream(`${who} answered more than 1 MiB`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** GETs `<base><path>` once, no redirect followed, and returns the parsed JSON body; throws `Upstream` with a plain cause. */
async function fetchJson(base: string, path: string, who: string, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let up: Response;
    try {
      up = await fetch(`${base}${path}`, { signal: ctl.signal, redirect: "error", headers: { accept: "application/json" } });
    } catch {
      throw new Upstream(ctl.signal.aborted ? `${who} did not answer within ${timeoutMs / 1000} s` : `${who} is unreachable`);
    }
    if (!up.ok) { void up.body?.cancel().catch(() => {}); throw new Upstream(`${who} answered ${up.status}`); }
    const declared = Number(up.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > OPTIONS_MAX_BYTES) { void up.body?.cancel().catch(() => {}); throw new Upstream(`${who} answered more than 1 MiB`); }
    let text: string;
    try {
      text = await readCapped(up.body, who);
    } catch (e) {
      if (e instanceof Upstream) throw e;
      throw new Upstream(ctl.signal.aborted ? `${who} did not answer within ${timeoutMs / 1000} s` : `${who} dropped the answer`);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new Upstream(`${who} answered something other than JSON`); }
  } finally {
    clearTimeout(timer);
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

function voicesOf(body: unknown, who: string): string[] {
  const v = isObj(body) ? body["voices"] : undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Upstream(`${who} answered a body that is not a voice list`);
  return [...new Set(v as string[])].sort();
}

function modelsOf(body: unknown, who: string): string[] {
  const m = isObj(body) ? body["models"] : undefined;
  if (!Array.isArray(m) || !m.every((x) => isObj(x) && typeof x["name"] === "string")) throw new Upstream(`${who} answered a body that is not a model list`);
  return (m as { name: string }[]).map((x) => x.name).sort();
}

/**
 * `GET /options/voices` and `GET /options/models`: the settings pick lists, read from the voice server and Ollama at the
 * addresses the service-URL helpers give. Ungated like `GET /config/*`; the request contributes nothing to the upstream call.
 */
// @spec DASH-OPT-001, DASH-OPT-002, DASH-OPT-003, DASH-OPT-004, DASH-OPT-005
export async function handleOptions(d: OptionsDeps, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (req.method !== "GET") return false;
  const timeout = d.timeoutMs ?? OPTIONS_TIMEOUT_MS;
  try {
    if (url.pathname === "/options/voices") {
      // @spec DASH-OPT-001, DASH-OPT-005
      let engine: string;
      try {
        engine = loadConfig(true).voice.engine;
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
        return true;
      }
      if (engine !== "kokoro") {
        json(res, 502, { ok: false, detail: `no voice list for engine ${engine}` });
        return true;
      }
      const who = "the voice server";
      json(res, 200, { voices: voicesOf(await fetchJson(d.urls.tts(), "/v1/audio/voices", who, timeout), who) });
      return true;
    }
    if (url.pathname === "/options/models") {
      const who = "Ollama";
      json(res, 200, { models: modelsOf(await fetchJson(d.urls.ollama(), "/api/tags", who, timeout), who) });
      return true;
    }
  } catch (e) {
    if (!(e instanceof Upstream)) throw e;
    json(res, 502, { ok: false, detail: e.message });
    return true;
  }
  return false;
}
