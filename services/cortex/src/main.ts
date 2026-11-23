import type { Bus, Publisher } from "@cohost/bus";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { createLogger, loadPersonality as loadPersonalityFile, type Config } from "@cohost/config";
import { createChatProvider as createChatProviderFor } from "@cohost/llm";
import { hookHealth, pingHooks } from "@cohost/modules";
import { createCritic as createCriticFor } from "./critic.js";
import { Cortex } from "./cortex.js";
import { NOMINAL_PING_DETAIL, cortexHealth } from "./health.js";
import { startCortex, trackLlm, waitForLlm } from "./startup.js";

/** What `main` needs from a Bus; tests pass a fake. */
export type CortexBus = Publisher & HealthPublisher & Pick<Bus, "subscribe" | "resetGroup" | "stop">;

/** The process-level collaborators of the service, replaceable so a test runs it without Redis, a model or signals. */
export type CortexEnv = Pick<RunServiceOptions<CortexBus>, "loadConfig" | "createBus" | "onShutdown" | "exit" | "log" | "stopTimeoutMs"> & {
  createChatProvider?: typeof createChatProviderFor;
  createCritic?: typeof createCriticFor;
  loadPersonality?: () => string;
};

/** The model backend's reachability as the heartbeat reports it. */
interface LlmState {
  ok: boolean;
  /** A provider whose ping always answers true says nothing until a reply has been tried (CTX-HEALTH-004). */
  probed: boolean;
  /** The tool catalog's state as the cortex reads it, once it is built (CTX-HEALTH-008). */
  tools?: () => "ok" | "down" | "n/a";
}

/** Where `cortexMain` publishes the critic hook's health so the heartbeat, started earlier by the bootstrap, can read it. */
export interface HookSink { current?: ReturnType<typeof hookHealth> }

/**
 * Builds and starts the service. The provider, the critic and the `Cortex` are built here, inside the bootstrap's
 * handler, so a rejected critic configuration takes the `fatal` path like any startup failure (CTX-START-005).
 */
export async function cortexMain(ctx: ServiceContext<CortexBus>, llmState: LlmState, env: CortexEnv = {}, hooks: HookSink = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const exit = env.exit ?? ((code: number) => process.exit(code));
  const provider = (env.createChatProvider ?? createChatProviderFor)(cfg.llm);
  llmState.probed = !provider.pingIsNominal;
  // @spec CTX-HEALTH-003
  const llm = trackLlm(provider, (ok) => { llmState.ok = ok; llmState.probed = true; });
  const critic = (env.createCritic ?? createCriticFor)(cfg, log); // @spec CTX-START-005
  hooks.current = hookHealth([critic]); // @spec CTX-HEALTH-006: the critic hook's dependency and mode, read by the heartbeat
  void pingHooks([critic], log); // @spec CTX-HEALTH-007
  const cortex = new Cortex({
    cfg, bus, llm, critic, log, loadPersonality: env.loadPersonality ?? loadPersonalityFile, heartbeat,
    standingDetail: cfg.llm.provider === "bedrock" ? NOMINAL_PING_DETAIL : undefined,
  });
  llmState.tools = () => cortex.toolsState();
  onStop(() => cortex.stop());

  // @spec CTX-START-002
  if (llm.name === "mock") log.warn("llm.provider is mock: replies are canned echoes, not a real model (mode mock)");
  // @spec CTX-START-001, CTX-HEALTH-002
  await waitForLlm(provider, { log, setOk: (ok) => { llmState.ok = ok; }, onDown: (detail) => heartbeat.degraded(detail) });
  await startCortex({ bus, cortex, heartbeat, onFatal: (err) => { log.error({ err }, "fatal"); exit(1); } });
  log.info({ provider: llm.name, model: llm.model, critic: critic.kind, name: cfg.cohost.name }, "cortex online");
}

/** The service entry: bootstrap, then `cortexMain`. */
export function runCortex(env: CortexEnv = {}): Promise<void> { // @spec CTX-START-004
  const boot = { ...env };
  delete boot.createChatProvider;
  delete boot.createCritic;
  delete boot.loadPersonality;
  const exit = boot.exit ?? ((code: number) => process.exit(code));
  const log = boot.log ?? createLogger("cortex");
  // `health` runs before `main`: it reads the state `cortexMain` keeps current. Bedrock's ping is nominal, so until the
  // first reply `deps.llm` reads `n/a` (CTX-HEALTH-004).
  const llmState: LlmState = { ok: false, probed: true };
  const hooks: HookSink = {};
  return runService<CortexBus>({
    service: "cortex",
    health: (cfg: Config) => {
      llmState.probed = cfg.llm.provider !== "bedrock";
      const base = cortexHealth(() => llmState.ok, cfg.llm.provider, () => llmState.probed, cfg.llm.provider === "bedrock", () => llmState.tools?.() ?? "n/a");
      // Until main has built the critic only the model backend is reported; afterwards the hook adds its dependency and may set mode mock.
      return {
        ...base,
        mode: () => (base.mode === "mock" || hooks.current?.mode() === "mock" ? "mock" : "live"),
        deps: () => ({ ...(typeof base.deps === "function" ? base.deps() : base.deps), ...hooks.current?.deps() }),
      };
    },
    main: (ctx) => cortexMain(ctx, llmState, env, hooks),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
