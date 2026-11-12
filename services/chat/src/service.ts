/**
 * chat — ingests Twitch chat and publishes `chat.message` events.
 *
 * Works read-only with just TWITCH_CHANNEL set (anonymous IRC). Add client id /
 * secret / tokens in .env to connect as the bot account (needed later if you
 * want the co-host to also *type* in chat).
 *
 * `chatService(deps)` is the service minus the process: `index.ts` hands its `main` to `runService`, and a test
 * hands it a fake Twitch client and auth provider.
 */
import type { Readable } from "node:stream";
import type { AuthProvider, RefreshingAuthProvider } from "@twurple/auth";
import type { Bus } from "@cohost/bus";
import type { Config } from "@cohost/config";
import { startIdle, subscribeInject, type HeartbeatSpec, type ServiceContext } from "@cohost/shared";
import { channelName, chatPlan, createChatFilter, type ChatUserInfo } from "./filter.js";
import { chatHealth } from "./health.js";
import { startFakeSource } from "./fake.js";
import { createInjectHandler } from "./inject.js";
import { loadStoredToken, saveStoredToken, tokenFile, type StoredToken } from "./token-store.js";
import { createMessageHandler, registerUserToken } from "./twitch.js";

/** The part of `@twurple/chat`'s `ChatClient` the service uses. */
export interface ChatClientLike {
  onConnect(cb: () => void): unknown;
  onDisconnect(cb: (manually: boolean, reason?: Error) => void): unknown;
  onMessage(cb: (channel: string, user: string, text: string, msg: { userInfo: ChatUserInfo }) => void): unknown;
  connect(): unknown;
  quit(): unknown;
}

export interface ChatServiceDeps {
  /** The environment the Twitch credentials are read from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Where refreshed tokens are kept (default `<dataDir()>/chat/twitch-token.json`). */
  tokenPath?: string;
  createClient?: (opts: { authProvider?: AuthProvider; channels: string[]; logger: { minLevel: "warning" } }) => ChatClientLike | Promise<ChatClientLike>;
  createAuth?: (clientId: string, clientSecret: string) => Promise<RefreshingAuthProvider> | RefreshingAuthProvider;
  stdin?: Readable & { isTTY?: boolean };
  /** Idle-plan reminder period, ms (default 60000). */
  idleWarnEveryMs?: number;
  exit?: (code: number) => void;
}

async function defaultCreateClient(opts: Parameters<NonNullable<ChatServiceDeps["createClient"]>>[0]): Promise<ChatClientLike> {
  const { ChatClient } = await import("@twurple/chat");
  return new ChatClient(opts) as unknown as ChatClientLike;
}

async function defaultCreateAuth(clientId: string, clientSecret: string): Promise<RefreshingAuthProvider> {
  const { RefreshingAuthProvider } = await import("@twurple/auth");
  return new RefreshingAuthProvider({ clientId, clientSecret });
}

export function chatService(deps: ChatServiceDeps = {}): { health(cfg: Config): HeartbeatSpec; main(ctx: ServiceContext<Bus>): Promise<void> } {
  let connected = false;
  let channel = "";
  const env = deps.env ?? process.env;

  return {
    // @spec CHAT-HEALTH-001
    health(cfg) {
      channel = channelName(cfg.chat);
      return chatHealth(channel, () => connected, cfg.chat.source);
    },

    // @spec CHAT-PLAN-001, CHAT-PLAN-002, CHAT-PLAN-003, CHAT-PLAN-005, CHAT-PLAN-006
    async main({ cfg, bus, log, heartbeat, onStop }) {
      const plan = chatPlan(cfg.chat);
      const toEvent = createChatFilter(cfg);

      // Test injection is handled whatever the source (twitch/fake/idle); it needs no channel or connection.
      // The subscription is established before any plan signals `ready`.
      // @spec CHAT-INJ-001, CHAT-INJ-009, CHAT-INJ-010
      await subscribeInject({
        bus, group: "chat", log, exit: deps.exit,
        handler: createInjectHandler({ bus, log, cohostName: cfg.cohost.name }),
      });

      if (plan === "fake") {
        // @spec CHAT-HEALTH-002
        // No channel, credentials or network; @twurple is never loaded.
        log.warn({ intervalMs: cfg.chat.fake.interval_ms }, "chat.source is fake: publishing scripted/stdin messages (mode mock)");
        const stop = startFakeSource({
          toEvent,
          publish: (ev) => bus.publish("chat.message", ev),
          cohostName: cfg.cohost.name,
          intervalMs: cfg.chat.fake.interval_ms,
          stdin: deps.stdin ?? process.stdin,
          // @spec CHAT-FAKE-006
          onError: (err) => log.warn({ err }, "fake chat publish failed"),
        });
        heartbeat.ready();
        onStop(stop);
      } else if (plan === "idle") {
        // @spec CHAT-HEALTH-005
        // A configuration gap, not a crash: stay up so a supervisor sees `degraded`, not a restart loop.
        const idle = startIdle({ heartbeat, log, kind: "degraded", reason: "TWITCH_CHANNEL is not set", warnEveryMs: deps.idleWarnEveryMs });
        onStop(() => idle.stop());
      } else {
        await startTwitch(channel);
      }

      // @spec CHAT-TW-001, CHAT-TW-002, CHAT-TW-003, CHAT-TW-010, CHAT-TW-011, CHAT-TW-012
      async function buildAuth(): Promise<AuthProvider | undefined> {
        const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN } = env;
        if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_ACCESS_TOKEN) return undefined;
        const provider = await (deps.createAuth ?? defaultCreateAuth)(TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET);
        const file = deps.tokenPath ?? tokenFile();
        const envRefresh = (TWITCH_REFRESH_TOKEN ?? "").trim();
        provider.onRefresh((_userId, token) => {
          log.info({ expiresIn: token.expiresIn }, "twitch token refreshed");
          if (!token.refreshToken) return;
          try {
            saveStoredToken(file, { ...token, refreshToken: token.refreshToken } as StoredToken, envRefresh);
          } catch (err) {
            log.warn({ err: String(err), file }, "could not persist the refreshed twitch token");
          }
        });
        // @spec CHAT-TW-006
        const stored = envRefresh ? loadStoredToken(file, envRefresh) : undefined;
        if (stored) log.info({ file }, "using the stored twitch token");
        await registerUserToken(provider, { accessToken: TWITCH_ACCESS_TOKEN, refreshToken: TWITCH_REFRESH_TOKEN, stored });
        return provider;
      }

      // @spec CHAT-PLAN-002, CHAT-PLAN-005
      async function startTwitch(chan: string): Promise<void> {
        const authProvider = await buildAuth();
        // `reconnect` is left at the library default (true): CHAT-TW-009.
        const client = await (deps.createClient ?? defaultCreateClient)({ authProvider, channels: [chan], logger: { minLevel: "warning" } });

        // @spec CHAT-TW-004, CHAT-TW-009
        client.onConnect(() => {
          connected = true;
          heartbeat.ready();
          log.info({ channel: chan, authenticated: !!authProvider }, "connected to twitch chat");
        });
        // @spec CHAT-TW-005
        client.onDisconnect((manually, reason) => {
          connected = false;
          log.warn({ manually, reason }, "twitch chat disconnected");
        });

        // @spec CHAT-TW-008
        const handleMessage = createMessageHandler({ toEvent, bus, log });
        // @spec CHAT-TW-007
        client.onMessage((_chan, user, text, msg) => { void handleMessage(user, text, msg.userInfo); });

        client.connect();
        // @spec CHAT-PLAN-006
        onStop(() => { client.quit(); });
      }
    },
  };
}
