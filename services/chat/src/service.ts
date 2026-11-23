/**
 * chat — reads chat from every source listed in `chat.sources` at once and publishes `chat.message` events.
 *
 * Each source sits behind the `ChatSource` contract (source.ts). The plan (plan.ts) says which listed sources run
 * and which are configuration gaps; the service starts the runnable ones, tracks each one's state for the heartbeat,
 * and signals `ready` once every listed source has had a first outcome (or after 30 s). Every value comes from the
 * loaded config; the process environment supplies none of them.
 *
 * `chatService(deps)` is the service minus the process: `index.ts` hands its `main` to `runService`, and a test
 * hands it fake sources, a fake Twitch client and an injected clock.
 */
import type { Readable } from "node:stream";
import type { Bus } from "@cohost/bus";
import type { Config, Logger } from "@cohost/config";
import { startIdle, subscribeInject, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { channelName, createChatFilter, type ChatSender } from "./filter.js";
import { chatHealth } from "./health.js";
import { FakeSource } from "./fake.js";
import { createInjectHandler } from "./inject.js";
import { sourcePlan } from "./plan.js";
import { tokenFile } from "./token-store.js";
import { createMessageHandler, TwitchSource, type CreateAuth, type CreateClient } from "./twitch.js";
import { YouTubeSource } from "./youtube.js";
import type { ChatPlatform, ChatRemoval, ChatSource, ChatSourceName, ChatSourceStartEnv, ChatSourceState, ChatSourceStatus } from "./source.js";

export type { ChatClientLike } from "./twitch.js";

/** The clock the 30 s ready bound runs on; a test injects its own. */
export interface ChatClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatServiceDeps {
  /** Where refreshed tokens are kept (default `<dataDir()>/chat/twitch-token.json`). */
  tokenPath?: string;
  createClient?: CreateClient;
  createAuth?: CreateAuth;
  stdin?: Readable & { isTTY?: boolean };
  /** Idle-plan reminder period, ms (default 60000). */
  idleWarnEveryMs?: number;
  exit?: (code: number) => void;
  /** Builds a named source instead of the default one; only the names given are overridden. */
  sourceFactories?: Partial<Record<ChatSourceName, () => ChatSource>>;
  /** Timer for the 30 s ready bound (default the process timers). */
  clock?: ChatClock;
}

const READY_BOUND_MS = 30_000;
const systemClock: ChatClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const defaultPlatform = (name: ChatSourceName): ChatPlatform => (name === "youtube" ? "youtube" : "twitch");

export function chatService(deps: ChatServiceDeps = {}): { health(cfg: Config): HeartbeatSpec; main(ctx: ServiceContext<Bus>): Promise<void> } {
  // Each listed source's latest reported state, read by the heartbeat.
  const states = new Map<ChatSourceName, ChatSourceStatus>();

  return {
    // @spec CHAT-HEALTH-001, CHAT-HEALTH-002, CHAT-HEALTH-004, CHAT-HEALTH-005, CHAT-HEALTH-007, CHAT-HEALTH-008
    health(cfg) {
      return chatHealth(sourcePlan(cfg.chat).map((e) => e.source), () => Object.fromEntries(states));
    },

    // @spec CHAT-PLAN-001, CHAT-PLAN-003, CHAT-PLAN-006, CHAT-PLAN-008, CHAT-PLAN-010, CHAT-PLAN-011, CHAT-PLAN-015, CHAT-SRC-002, CHAT-SRC-003, CHAT-SRC-004, CHAT-SRC-005, CHAT-SRC-006, CHAT-SRC-007, CHAT-SRC-008, CHAT-INJ-001
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = sourcePlan(cfg.chat);

      // Test injection is handled whatever the sources; it needs no channel or connection, and is subscribed before any
      // source starts or any plan signals `ready`.
      await subscribeInject({
        bus, group: "chat", log, exit: deps.exit,
        handler: createInjectHandler({ bus, log, cohostName: cfg.cohost.name, viewerText: cfg.viewer_text }),
      });

      // Nothing listed: stay up in mode off, quiet.
      if (plan.length === 0) {
        heartbeat.ready();
        return;
      }

      for (const e of plan) {
        if (e.status === "gap") states.set(e.source, { state: "stopped", reason: e.reasons.join("; ") });
      }

      // Every listed source a gap: the shared idle plan, with the reasons as its one error and its detail.
      const runnable = plan.filter((e) => e.status === "runnable");
      if (runnable.length === 0) {
        const idle = startIdle({
          heartbeat, log, kind: "degraded",
          reason: plan.flatMap((e) => (e.status === "gap" ? e.reasons : [])).join("; "),
          warnEveryMs: deps.idleWarnEveryMs,
        });
        onStop(() => idle.stop());
        return;
      }

      for (const e of plan) {
        if (e.status === "gap") log.error(`chat source ${e.source} is not running: ${e.reasons.join("; ")}`);
      }

      // The fake source stands in for the platforms: say so once, so a run that is not live is visible in the log.
      if (plan.some((e) => e.status === "runnable" && e.source === "fake")) {
        log.warn({ intervalMs: cfg.chat.fake.interval_ms }, "chat.sources includes fake: publishing scripted/stdin messages (mode mock)");
      }

      // Ready once every listed source has had a first outcome, or at the 30 s bound, whichever comes first.
      const clock = deps.clock ?? systemClock;
      const outcomes = new Set<ChatSourceName>(plan.filter((e) => e.status === "gap").map((e) => e.source));
      let readySignalled = false;
      let bound: unknown;
      const markReady = () => {
        if (readySignalled) return;
        readySignalled = true;
        clock.clearTimeout(bound);
        heartbeat.ready();
      };
      const checkReady = () => {
        if (outcomes.size === plan.length) markReady();
      };
      bound = clock.setTimeout(markReady, READY_BOUND_MS);

      // Stop: cancel the bound, then stop every built source, each in its own try so one failure stops none of the others.
      const built: ChatSource[] = [];
      let closed = false;
      onStop(() => {
        closed = true;
        clock.clearTimeout(bound);
        for (const src of built) {
          try {
            src.stop();
          } catch (err) {
            log.warn(`chat source ${src.name} did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      });

      const publishers = new Map<ChatPlatform, ReturnType<typeof createMessageHandler>>();
      const publisherFor = (platform: ChatPlatform) => {
        let pub = publishers.get(platform);
        if (!pub) {
          pub = createMessageHandler({ toEvent: createChatFilter(cfg, platform), bus, log });
          publishers.set(platform, pub);
        }
        return pub;
      };

      // A removal is what the platform did: it is published as it is, and ignore lists never apply to it (CHAT-FORGET-006).
      const publishRemoval = async (removal: ChatRemoval): Promise<void> => {
        try {
          await bus.publish("chat.removed", removal);
        } catch (err) {
          log.warn({ err: String(err) }, "chat.removed publish failed");
        }
      };

      const envFor = (name: ChatSourceName): ChatSourceStartEnv => ({
        log,
        // @spec CHAT-SRC-007, CHAT-SRC-006
        emit: (sender: ChatSender, text, messageId) => {
          if (closed) return;
          void publisherFor(sender.platform ?? defaultPlatform(name))(sender, text, messageId);
        },
        // @spec CHAT-FORGET-001, CHAT-FORGET-006
        emitRemoval: (removal) => {
          if (closed) return;
          void publishRemoval(removal);
        },
        // @spec CHAT-SRC-002
        onState: (state: ChatSourceState, reason?: string) => {
          if (closed) return;
          states.set(name, { state, reason });
          if (state !== "starting") outcomes.add(name);
          // Once ready, a change publishes at once (a reconnect may come back before the heartbeat's own check sees it).
          if (readySignalled) heartbeat.ready();
          else checkReady();
        },
      });

      const make = (name: ChatSourceName): ChatSource => {
        const factory = deps.sourceFactories?.[name];
        if (factory) return factory();
        switch (name) {
          case "fake":
            return new FakeSource({ cohostName: cfg.cohost.name, intervalMs: cfg.chat.fake.interval_ms, stdin: deps.stdin ?? process.stdin });
          case "twitch":
            return new TwitchSource({
              channel: channelName(cfg.chat), twitch: cfg.chat.twitch, tokenPath: deps.tokenPath ?? tokenFile(),
              createClient: deps.createClient, createAuth: deps.createAuth,
            });
          case "youtube":
            return new YouTubeSource();
        }
      };

      // Each runnable source starts in isolation: a rejected start stops only that source (CHAT-PLAN-011).
      await Promise.all(runnable.map(async (e) => {
        const src = make(e.source);
        built.push(src);
        states.set(e.source, { state: "starting" });
        try {
          await src.start(envFor(e.source));
        } catch (err) {
          // A start that fails after shutdown is not news: no state, no log.
          if (closed) return;
          const reason = err instanceof Error ? err.message : String(err);
          states.set(e.source, { state: "stopped", reason });
          outcomes.add(e.source);
          log.error(`chat source ${e.source} did not start: ${reason}`);
          // After ready, publish at once, as a source state change does.
          if (readySignalled) heartbeat.ready();
          else checkReady();
        }
      }));
    },
  };
}
