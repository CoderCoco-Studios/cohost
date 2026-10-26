/**
 * chat — ingests Twitch chat and publishes `chat.message` events.
 *
 * Works read-only with just TWITCH_CHANNEL set (anonymous IRC). Add client id /
 * secret / tokens in .env to connect as the bot account (needed later if you
 * want the co-host to also *type* in chat).
 */
import type { AuthProvider } from "@twurple/auth";
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { channelName, chatPlan, createChatFilter } from "./filter.js";
import { chatHealth } from "./health.js";
import { startFakeSource } from "./fake.js";
import { createInjectHandler } from "./inject.js";

const log = createLogger("chat");
const cfg = loadConfig();
const bus = new Bus("chat", log);

const channel = channelName(cfg.chat);
const source = cfg.chat.source;
const plan = chatPlan(cfg.chat);
let connected = false;
const heartbeat = startHeartbeat(bus, { ...chatHealth(channel, () => connected, source), log });
const toEvent = createChatFilter(cfg);

// Test injection is handled whatever the source (twitch/fake/idle); it needs no channel or connection.
void bus.subscribe(
  { group: "chat", types: ["inject.request"], fromNow: true },
  createInjectHandler({ bus, log, cohostName: cfg.cohost.name }),
);

if (plan === "fake") {
  // No channel, credentials or network; @twurple is never loaded.
  log.warn({ intervalMs: cfg.chat.fake.interval_ms }, "chat.source is fake: publishing scripted/stdin messages (mode mock)");
  const stop = startFakeSource({
    toEvent,
    publish: (ev) => bus.publish("chat.message", ev),
    cohostName: cfg.cohost.name,
    intervalMs: cfg.chat.fake.interval_ms,
    stdin: process.stdin,
    onError: (err) => log.warn({ err }, "fake chat publish failed"),
  });
  heartbeat.ready();
  onShutdown(() => { stop(); bus.stop(); });
} else if (plan === "idle") {
  // A configuration gap, not a crash: stay up so a supervisor sees `degraded`, not a restart loop.
  const complain = () => log.error("TWITCH_CHANNEL is not set; chat is idle and publishing nothing");
  complain();
  heartbeat.degraded("TWITCH_CHANNEL is not set");
  const timer = setInterval(complain, 60_000);
  onShutdown(() => { clearInterval(timer); bus.stop(); });
} else {
  await startTwitch(channel);
}

async function buildAuth(): Promise<AuthProvider | undefined> {
  const { RefreshingAuthProvider } = await import("@twurple/auth");
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_ACCESS_TOKEN, TWITCH_REFRESH_TOKEN } = process.env;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_ACCESS_TOKEN) return undefined;
  const provider = new RefreshingAuthProvider({ clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET });
  provider.onRefresh((_userId, token) => log.info({ expiresIn: token.expiresIn }, "twitch token refreshed"));
  void provider.addUserForToken(
    {
      accessToken: TWITCH_ACCESS_TOKEN,
      refreshToken: TWITCH_REFRESH_TOKEN ?? null,
      expiresIn: 0,
      obtainmentTimestamp: 0,
    },
    ["chat"],
  );
  return provider;
}

async function startTwitch(channel: string): Promise<void> {
  const { ChatClient } = await import("@twurple/chat");
  const authProvider = await buildAuth();
  const client = new ChatClient({ authProvider, channels: [channel], logger: { minLevel: "warning" } });

  client.onConnect(() => {
    connected = true;
    heartbeat.ready();
    log.info({ channel, authenticated: !!authProvider }, "connected to twitch chat");
  });
  client.onDisconnect((manually, reason) => {
    connected = false;
    log.warn({ manually, reason }, "twitch chat disconnected");
  });

  client.onMessage(async (_chan, user, text, msg) => {
    const ev = toEvent(user, text, msg.userInfo);
    if (ev) await bus.publish("chat.message", ev);
  });

  client.connect();
  onShutdown(() => { client.quit(); bus.stop(); });
}
