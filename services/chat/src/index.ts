/**
 * chat — ingests Twitch chat and publishes `chat.message` events.
 *
 * Works read-only with just TWITCH_CHANNEL set (anonymous IRC). Add client id /
 * secret / tokens in .env to connect as the bot account (needed later if you
 * want the co-host to also *type* in chat).
 */
import { ChatClient } from "@twurple/chat";
import { RefreshingAuthProvider, type AuthProvider } from "@twurple/auth";
import { Bus, onShutdown } from "@cohost/bus";
import { createLogger, loadConfig } from "@cohost/config";

const log = createLogger("chat");
const cfg = loadConfig();
const bus = new Bus("chat", log);

const channel = cfg.chat.twitch.channel.replace(/^#/, "").toLowerCase();
if (!channel) {
  log.error("TWITCH_CHANNEL is not set; nothing to listen to");
  process.exit(1);
}

const cohostName = cfg.cohost.name.toLowerCase();
const ignoreUsers = new Set(cfg.chat.ignore_users.map((u) => u.toLowerCase()));

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

client.onConnect(() => log.info({ channel, authenticated: !!authProvider }, "connected to twitch chat"));
client.onDisconnect((manually, reason) => log.warn({ manually, reason }, "twitch chat disconnected"));

client.onMessage(async (_chan, user, text, msg) => {
  const lower = user.toLowerCase();
  if (ignoreUsers.has(lower)) return;
  if (cfg.chat.ignore_prefixes.some((p) => text.startsWith(p))) return;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return;
  await bus.publish("chat.message", {
    platform: "twitch",
    user: msg.userInfo.displayName || user,
    userId: msg.userInfo.userId,
    text: clean,
    isMod: msg.userInfo.isMod || msg.userInfo.isBroadcaster,
    isSub: msg.userInfo.isSubscriber,
    mentionsCohost: clean.toLowerCase().includes(cohostName),
  });
});

client.connect();
onShutdown(() => { client.quit(); bus.stop(); });
