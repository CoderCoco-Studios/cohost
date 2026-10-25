import { createHash, timingSafeEqual } from "node:crypto";

export type ControlConfig =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      /** Address the dashboard listens on. */
      bind: string;
      /** True when bind was set explicitly (CONTROL_BIND), so the caller can warn if non-loopback. */
      bindExplicit: boolean;
      runtime: "compose" | "process";
      advanced: boolean;
      processMode: "dev" | "start";
    };

export const LOOPBACK_BIND = "127.0.0.1";

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Parses CONTROL_* env. Throws (fail fast) when enabled without a token or with an unknown runtime. */
export function loadControlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig {
  if (env.CONTROL_ENABLED !== "1") return { enabled: false };
  const token = env.CONTROL_TOKEN ?? "";
  if (token.trim() === "") throw new Error("CONTROL_ENABLED=1 requires CONTROL_TOKEN to be set to a non-empty secret");
  const runtime = env.CONTROL_RUNTIME || "compose";
  if (runtime !== "compose" && runtime !== "process") throw new Error(`CONTROL_RUNTIME must be "compose" or "process", got ${JSON.stringify(runtime)}`);
  const processMode = env.CONTROL_PROCESS_MODE || "dev";
  if (processMode !== "dev" && processMode !== "start") throw new Error(`CONTROL_PROCESS_MODE must be "dev" or "start", got ${JSON.stringify(processMode)}`);
  const bind = env.CONTROL_BIND?.trim();
  return {
    enabled: true, token, bind: bind || LOOPBACK_BIND, bindExplicit: !!bind,
    runtime, advanced: env.CONTROL_ADVANCED === "1", processMode,
  };
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m || !token) return false;
  // Hash both sides so the comparison is fixed-length (timingSafeEqual requires equal lengths).
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}
