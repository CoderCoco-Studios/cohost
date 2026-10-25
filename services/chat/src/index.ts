/**
 * chat — ingests Twitch chat and publishes `chat.message` events.
 *
 * Works read-only with just TWITCH_CHANNEL set (anonymous IRC). Add client id /
 * secret / tokens in .env to connect as the bot account (needed later if you
 * want the co-host to also *type* in chat).
 */
import { ChatClient } from "@twurple/chat";
import { RefreshingAuthProvider, type AuthProvider } from "@twurple/auth";
import { Bus, onShutdown, startHeartbeat } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";
import { channelName, createChatFilter } from "./filter.js";
import { chatHealth } from "./health.js";

const log = createLogger("chat");
const cfg = loadConfig();
const bus = new Bus("chat", log);

const channel = channelName(cfg.chat);
let connected = false;
const heartbeat = startHeartbeat(bus, { ...chatHealth(channel, () => connected), log });
if (!channel) {
  log.error("TWITCH_CHANNEL is not set; nothing to listen to");
  heartbeat.degraded("TWITCH_CHANNEL is not set");
  await heartbeat.stop();
  process.exit(1);
}

const toEvent = createChatFilter(cfg);

function buildAuth(): AuthProvider | undefined {
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

const authProvider = buildAuth();
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
