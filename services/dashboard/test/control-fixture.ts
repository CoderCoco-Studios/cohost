/**
 * The one lock as the dashboard tests use it: a control token of at least 32 characters (settings-store STORE-TOK-001), the
 * header that carries it, a gate that accepts exactly that token and keys sessions with a fixed key (the store's verifier and
 * session key stand behind the real one, `storeGate`), and a `control` dependency for `createDashboardHandler` with a
 * controller a test does not drive.
 */
import type { Store } from "@cohost/store";
import type { Gate } from "../src/access.js";
import type { DashboardDeps } from "../src/routes.js";

export const TOKEN = "s3cret-control-token-0123456789abcdef";
export const AUTH = { authorization: `Bearer ${TOKEN}` } as const;
/** The session key of `TEST_GATE`. */
export const SESSION_KEY = Buffer.alloc(32, 7);

/** A gate that accepts `token` as a bearer and sessions made under `key`. */
export const gateFor = (token: string, key: Buffer | undefined = SESSION_KEY): Gate => ({ verify: async (t) => (t === token ? "ok" : "bad"), sessionKey: () => key });

/** A gate that accepts `TOKEN` as a bearer and sessions made under `SESSION_KEY`. */
export const TEST_GATE: Gate = gateFor(TOKEN);

/** The `control` dependency of a handler: the test gate and, unless given, a controller no route of the test reaches. */
export const testControl = (over: Partial<DashboardDeps["control"]> = {}): DashboardDeps["control"] =>
  ({ gate: TEST_GATE, runtime: "compose", advanced: false, controller: {} as never, ...over });

/** The `store` dependency of a handler whose test reaches no route that reads or writes the settings store. */
export const UNUSED_STORE = {} as unknown as Store;
