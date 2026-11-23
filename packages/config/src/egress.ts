import { isIP } from "node:net";
import { urls } from "./index.js";
import type { Config } from "./schema.js";

/** One destination private data is sent to: the service that sends it, what it is, and whether it leaves the LAN. */
export interface EgressEntry {
  service: "voice" | "ears" | "eyes" | "cortex";
  /** `text` a prompt or line of speech, `audio` a clip sent to a transcriber, `frames` a screenshot. */
  data: "text" | "audio" | "frames";
  /** The engine or provider the entry is for (`kokoro`, `speaches`, `ollama`, `openai` ...). */
  engine: string;
  /** The host name or address without a port and without URL brackets; absent for a hosted provider. */
  host?: string;
  /** The provider's name, for a hosted provider with no host of its own (`anthropic`, `bedrock`). */
  hosted?: string;
  offLan: boolean;
}

const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?\.?$/;

/** A parsed IP address: its family and its value as a bigint. */
type Ip = { family: 4 | 6; value: bigint };

/** Parses a dotted IPv4 address or an IPv6 address (brackets already removed); undefined for anything else. */
function parseIp(text: string): Ip | undefined {
  const v = isIP(text);
  if (v === 4) {
    const parts = text.split(".").map(Number);
    return { family: 4, value: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n) };
  }
  if (v === 6) {
    let s = text.toLowerCase();
    const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (tail) {
      const q = parseIp(tail[1]!)!.value;
      s = `${s.slice(0, s.length - tail[1]!.length)}${((q >> 16n) & 0xffffn).toString(16)}:${(q & 0xffffn).toString(16)}`;
    }
    const [head, rest] = s.includes("::") ? s.split("::") as [string, string] : [s, undefined];
    const left = head ? head.split(":") : [];
    const right = rest === undefined ? [] : rest ? rest.split(":") : [];
    const fill = rest === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
    const groups = [...left, ...fill, ...right].map((g) => BigInt(`0x${g}`));
    return { family: 6, value: groups.reduce((acc, g) => (acc << 16n) | g, 0n) };
  }
  return undefined;
}

/** The IPv4 address an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) carries, or the address itself. */
function unmap(ip: Ip): Ip {
  if (ip.family === 6 && ip.value >> 32n === 0xffffn) return { family: 4, value: ip.value & 0xffffffffn };
  return ip;
}

/** Whether `ip` lies inside the CIDR block `network/prefix` of the same family. */
function inside(ip: Ip, network: Ip, prefix: number): boolean {
  if (ip.family !== network.family) return false;
  const bits = network.family === 4 ? 32n : 128n;
  const shift = bits - BigInt(prefix);
  return ip.value >> shift === network.value >> shift;
}

/** The IPv4 CIDR form `a.b.c.d/n` or IPv6 form `x::y/n` of a range entry, or undefined when the entry is not a range. */
function parseRange(entry: string): { network: Ip; prefix: number } | undefined {
  const slash = entry.indexOf("/");
  if (slash < 0) return undefined;
  const network = parseIp(entry.slice(0, slash));
  const text = entry.slice(slash + 1);
  if (!network || !/^\d+$/.test(text)) return undefined;
  const prefix = Number(text);
  return prefix <= (network.family === 4 ? 32 : 128) ? { network, prefix } : undefined;
}

/**
 * Whether one `network.lan` entry is well formed (CFG-SCH-071): a host name, a single IPv4 or IPv6 address, a dot suffix such as
 * `.ts.net`, or a CIDR range.
 */
// @spec CFG-SCH-071
export function isLanEntry(entry: string): boolean {
  if (entry.startsWith(".")) return HOST_NAME.test(entry.slice(1)) && !entry.endsWith(".");
  if (entry.includes("/")) return parseRange(entry) !== undefined;
  return parseIp(entry) !== undefined || HOST_NAME.test(entry);
}

/** The v4 or v6 address a host names, judged with URL brackets removed; `undefined` for a name. */
const addressOf = (host: string): Ip | undefined => parseIp(host.replace(/^\[|\]$/g, ""));

/** The host of a URL without its port, and with the brackets of an IPv6 literal removed. */
const hostOf = (url: string): string => new URL(url).hostname.replace(/^\[|\]$/g, "");

/**
 * Whether a host lies off the LAN (CFG-EGR-008 to CFG-EGR-012). `network.lan` entries win: an exact host, a dot suffix or a
 * range that contains the address makes it on the LAN. Otherwise the host is judged by its form alone and never resolved.
 */
// @spec CFG-EGR-008, CFG-EGR-009, CFG-EGR-010, CFG-EGR-011, CFG-EGR-012
export function offLanHost(host: string, lan: readonly string[]): boolean {
  const lower = host.toLowerCase();
  const ip = addressOf(host);
  const judged = ip ? unmap(ip) : undefined;
  for (const entry of lan) {
    const e = entry.toLowerCase();
    if (e.startsWith(".")) {
      if (lower.endsWith(e)) return false;
      continue;
    }
    const range = parseRange(entry);
    if (range) {
      if (judged && inside(judged, range.network, range.prefix)) return false;
      continue;
    }
    if (lower === e) return false;
    const entryIp = parseIp(entry);
    if (entryIp && judged && entryIp.family === judged.family && entryIp.value === judged.value) return false;
  }
  if (judged) {
    if (judged.family === 4) {
      const a = judged.value >> 24n;
      const b = (judged.value >> 16n) & 0xffn;
      return !(a === 127n || a === 10n || (a === 172n && b >= 16n && b <= 31n) || (a === 192n && b === 168n) || (a === 169n && b === 254n));
    }
    if (judged.value === 1n) return false;
    const top7 = judged.value >> 121n; // fc00::/7
    const top10 = judged.value >> 118n; // fe80::/10
    return !(top7 === 0x7en || top10 === 0x3fan);
  }
  if (lower === "localhost" || lower === "host.docker.internal" || lower.endsWith(".local")) return false;
  return lower.includes(".");
}

/**
 * Every destination the configured engines send private data to (CFG-EGR-001 to CFG-EGR-013): voice text, ears audio, eyes
 * frames and cortex text. A stub engine, the mock chat provider and a blank server value give no entry. A hosted provider
 * (anthropic, bedrock) has no host, only its name, and is off the LAN.
 */
// @spec CFG-EGR-001, CFG-EGR-002, CFG-EGR-003, CFG-EGR-004, CFG-EGR-005, CFG-EGR-006, CFG-EGR-007, CFG-EGR-013
export function egressDestinations(config: Config): EgressEntry[] {
  const lan = config.network?.lan ?? [];
  const out: EgressEntry[] = [];
  const add = (service: EgressEntry["service"], data: EgressEntry["data"], engine: string, url: string | undefined) => {
    if (url === undefined || url === "") return;
    const host = hostOf(url);
    out.push({ service, data, engine, host, offLan: offLanHost(host, lan) });
  };
  const hosted = (service: EgressEntry["service"], data: EgressEntry["data"], provider: string) =>
    out.push({ service, data, engine: provider, hosted: provider, offLan: true });

  // voice: text to the speech server of the selected engine
  const v = config.voice;
  if (v.engine === "kokoro") add("voice", "text", "kokoro", urls.tts());
  else if (v.engine === "openai") add("voice", "text", "openai", v.openai.base_url);
  else if (v.engine === "pocket") add("voice", "text", "pocket", v.pocket.url);

  // ears: audio to the selected engine, and to the fallback while the selected engine is a streaming one
  const e = config.ears;
  const sttUrl = (engine: string): string | undefined => {
    if (engine === "speaches") return urls.stt();
    if (engine === "openai") return e.openai.base_url;
    if (engine === "nemotron") return e.nemotron.url;
    if (engine === "kyutai") return e.kyutai.url;
    return undefined;
  };
  add("ears", "audio", e.stt_engine, sttUrl(e.stt_engine));
  if ((e.stt_engine === "nemotron" || e.stt_engine === "kyutai") && e.stt_fallback_engine !== "none") {
    add("ears", "audio", e.stt_fallback_engine, sttUrl(e.stt_fallback_engine));
  }

  // eyes: frames to the vision provider, whether or not vision is enabled
  const p = config.vision.provider;
  if (p === "ollama") add("eyes", "frames", "ollama", urls.ollama());
  else if (p === "openai") add("eyes", "frames", "openai", config.llm.openai.base_url);
  else if (p === "anthropic" || p === "bedrock") hosted("eyes", "frames", p);

  // cortex: text to the chat provider
  const l = config.llm.provider;
  if (l === "ollama") add("cortex", "text", "ollama", urls.ollama());
  else if (l === "openai") add("cortex", "text", "openai", config.llm.openai.base_url);
  else if (l === "anthropic" || l === "bedrock") hosted("cortex", "text", l);

  return out;
}
