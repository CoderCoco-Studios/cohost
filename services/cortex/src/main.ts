import type { Bus, Publisher } from "@cohost/bus";
import { runService, type HealthPublisher, type RunServiceOptions, type ServiceContext } from "@cohost/shared";
import { createLogger, loadPersonality as loadPersonalityFile, type Config } from "@cohost/config";
import { createChatProvider as createChatProviderFor } from "@cohost/llm";
import { createCritic as createCriticFor } from "./critic.js";
import { Cortex } from "./cortex.js";
import { cortexHealth } from "./health.js";
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
}

/**
 * Builds and starts the service. The provider, the critic and the `Cortex` are built here, inside the bootstrap's
 * handler, so a rejected critic configuration takes the `fatal` path like any startup failure (CTX-START-005).
 */
export async function cortexMain(ctx: ServiceContext<CortexBus>, llmState: LlmState, env: CortexEnv = {}): Promise<void> {
  const { cfg, bus, log, heartbeat, onStop } = ctx;
  const exit = env.exit ?? ((code: number) => process.exit(code));
  const provider = (env.createChatProvider ?? createChatProviderFor)(cfg.llm);
  llmState.probed = !provider.pingIsNominal;
  // @spec CTX-HEALTH-003
  const llm = trackLlm(provider, (ok) => { llmState.ok = ok; llmState.probed = true; });
  const critic = (env.createCritic ?? createCriticFor)(cfg, log); // @spec CTX-START-005
  const cortex = new Cortex({ cfg, bus, llm, critic, log, loadPersonality: env.loadPersonality ?? loadPersonalityFile, heartbeat });
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
  return runService<CortexBus>({
    service: "cortex",
    health: (cfg: Config) => {
      llmState.probed = cfg.llm.provider !== "bedrock";
      return cortexHealth(() => llmState.ok, cfg.llm.provider, () => llmState.probed, cfg.llm.provider === "bedrock");
    },
    main: (ctx) => cortexMain(ctx, llmState, env),
    ...boot,
    log,
  }).catch((err) => { log.error({ err }, "fatal"); exit(1); }); // a bus that cannot be built is a startup failure too
}
