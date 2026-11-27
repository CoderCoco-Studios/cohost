import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The control configuration: the one lock (`CONTROL_TOKEN`, trimmed) and the infrastructure safety switch (`CONTROL_ADVANCED`). */
export interface ControlConfig {
  token: string;
  advanced: boolean;
}

/** The shortest `CONTROL_TOKEN` accepted, after trimming (CTRL-CONFIG-001). */
export const MIN_CONTROL_TOKEN_LENGTH = 32;

export const LOOPBACK_BIND = "127.0.0.1";

// @spec DASH-AVR-031
/**
 * True when a socket's remote address is this machine: `::1`, an IPv4 address in 127.0.0.0/8, or either of those written
 * IPv4-mapped (`::ffff:127.x.y.z`, what a dual-stack listener reports for an IPv4 peer). A LAN address, mapped or not, is not.
 * A NAT or forwarding layer that makes a remote client arrive from loopback makes it look local: this check cannot see that.
 */
export function isLoopbackPeer(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.toLowerCase();
  const v4 = a.startsWith("::ffff:") ? a.slice("::ffff:".length) : a;
  return v4 === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * True for exactly `localhost`, `::1` and an IPv4 address in 127.0.0.0/8 written as four decimal octets of 0 to 255; a name
 * that merely starts with `127.` (`127.example.com`) is not loopback. The dashboard's Host rule shares it.
 */
// @spec CTRL-CONFIG-002
export function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * Why `CONTROL_TOKEN` cannot be used, naming the variable and never its value: unset or empty, or shorter than 32 characters
 * after trimming. Undefined when it is usable.
 */
export function controlTokenProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = (env.CONTROL_TOKEN ?? "").trim();
  if (token.length >= MIN_CONTROL_TOKEN_LENGTH) return undefined;
  const what = token === "" ? "CONTROL_TOKEN is missing" : "CONTROL_TOKEN is too short";
  return `${what}: it must be at least ${MIN_CONTROL_TOKEN_LENGTH} characters. The installer writes one into .env; to make one by hand, run \`openssl rand -hex 24\` and put the result in .env as CONTROL_TOKEN=<that value>`;
}

/**
 * Parses CONTROL_* env. `CONTROL_TOKEN` is cohost's one lock and always required: throws (fail fast) when it is unset or shorter
 * than 32 characters after trimming, never including the value. `CONTROL_ENABLED` is not read: no variable switches control off.
 * There is no runtime setting: compose is the only runtime.
 */
// @spec CTRL-CONFIG-001, CTRL-CONFIG-002
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  const problem = controlTokenProblem(env);
  if (problem !== undefined) throw new Error(problem);
  return { token: (env.CONTROL_TOKEN ?? "").trim(), advanced: env.CONTROL_ADVANCED === "1" };
}

/** The label the ears listener key is an HMAC of (CTRL-RUNTIME-017); it differs from the dashboard's session-key label. */
export const EARS_LISTENER_LABEL = "cohost/ears-listener/v1";

/**
 * The ears listener key: HMAC-SHA256 keyed with the trimmed control token, of `EARS_LISTENER_LABEL`, as 64 lowercase hex digits
 * (CTRL-RUNTIME-017). The token cannot be recovered from it, and it only lets a client post audio.
 */
// @spec CTRL-RUNTIME-017
export function earsListenerKey(token: string): string {
  return createHmac("sha256", token.trim()).update(EARS_LISTENER_LABEL).digest("hex");
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
// @spec CTRL-CONFIG-003
export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m || !token) return false;
  // Hash both sides so the comparison is fixed-length (timingSafeEqual requires equal lengths).
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
