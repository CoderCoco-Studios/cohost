import { createHash, timingSafeEqual } from "node:crypto";

export type ControlConfig =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      advanced: boolean;
    };

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

/** Parses CONTROL_* env. Throws (fail fast) when enabled without a token. There is no runtime setting: compose is the only runtime. */
// @spec CTRL-CONFIG-001, CTRL-CONFIG-002
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  if (env.CONTROL_ENABLED !== "1") return { enabled: false };
  const token = env.CONTROL_TOKEN ?? "";
  if (token.trim() === "") throw new Error("CONTROL_ENABLED=1 requires CONTROL_TOKEN to be set to a non-empty secret");
  return { enabled: true, token, advanced: env.CONTROL_ADVANCED === "1" };
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
