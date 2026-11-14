/**
 * The adapter from the native addon to `BusTransport` (the events path only), and the only file that imports the addon
 * (BUS-NAT-API-010).
 * Loads `../native/cohost-bus.<platform>-<arch>-gnu.node` relative to this file and nothing else: no search path, no
 * environment override, no fallback transport (BUS-NAT-BLD-004). The binding's types are declared here, so no file the
 * napi CLI generates is needed (BUS-NAT-BLD-009). linux-x64-gnu is the only target (BUS-NAT-BLD-006).
 */
import { createRequire } from "node:module";
import type { BusTransport, TransportFactory } from "./transport.js";

/** What `crates/cohost-bus-node` exports: the events transport, the connector key naming and the health stream cap. */
interface Binding {
  /** Begins opening the shared connection without blocking or throwing, even when Redis is unreachable (BUS-NAT-TRN-004). */
  Transport: new (url: string, prefix: string, failFast: boolean) => BusTransport;
  connectorKey(prefix: string, id: string): string;
  HEALTH_MAXLEN: number;
}

// @spec BUS-NAT-BLD-004, BUS-NAT-BLD-005
function load(): Binding {
  const { platform, arch } = process;
  const file = `cohost-bus.${platform}-${arch}-gnu.node`;
  const path = new URL(`../native/${file}`, import.meta.url).pathname;
  const fail = (why: string, cause?: unknown): never => {
    throw Object.assign(
      new Error(`@cohost/bus cannot load the native addon (${why}): looked for ${file} for platform ${platform}, arch ${arch} at ${path}. Build it with \`pnpm build:native\`.`, { cause }),
      { code: "BUS_INTERNAL" },
    );
  };
  if (platform !== "linux" || arch !== "x64") return fail("only linux-x64-gnu is supported");
  try {
    return createRequire(import.meta.url)(path) as Binding;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), err);
  }
}

const binding = load();

/** Production default of `BusOptions.transport` (BUS-NAT-API-003). */
export const createNativeTransport: TransportFactory = (url, opts) => new binding.Transport(url, opts.prefix, opts.failFast);

// @spec BUS-NAT-RS-006
/** `<prefix>:connector:<id>`, built by the crate; synchronous (BUS-NAT-TRN-013). */
export const connectorKey = binding.connectorKey;
// @spec BUS-NAT-RS-004
/** The health stream's cap, defined by the crate. */
export const HEALTH_MAXLEN = binding.HEALTH_MAXLEN;
