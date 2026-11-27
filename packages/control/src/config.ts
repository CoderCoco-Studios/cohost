import type { BearerResult } from "@cohost/store";

/** The control configuration: the infrastructure safety switch (`CONTROL_ADVANCED`). */
export interface ControlConfig {
  advanced: boolean;
}

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
 * Parses CONTROL_* env: the infrastructure safety switch (`CONTROL_ADVANCED`). No control token is read: the dashboard checks a
 * bearer against the settings store's verifier (settings-store STORE-TOK-003) and refuses to start while the store holds none
 * (dashboard DASH-CTRL-002). `CONTROL_ENABLED` is not read: no variable switches control off. There is no runtime setting:
 * compose is the only runtime.
 */
// @spec CTRL-CONFIG-001, CTRL-CONFIG-002
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  return { advanced: env.CONTROL_ADVANCED === "1" };
}

/**
 * Checks an `Authorization` header: accepted only in the form `Bearer <token>` with a non-empty token that `verify` (the
 * settings store's verifier, STORE-TOK-003) accepts. A missing header, another scheme or an empty bearer is `bad` without a
 * check; `busy` passes through from a verifier with too many checks waiting.
 */
// @spec CTRL-CONFIG-003
export async function bearerOk(header: string | undefined, verify: (token: string) => Promise<BearerResult>): Promise<BearerResult> {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m || m[1]!.trim() === "") return "bad";
  return verify(m[1]!);
}
