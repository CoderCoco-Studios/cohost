/**
 * The built-in `stream_info` tool (TOOL-STRM-001 to TOOL-STRM-008): whether the channel's stream is live, for Twitch and
 * YouTube, through the platforms' own APIs with the app credentials of the chat sense. Nothing but the channel or video id
 * and the credential leaves the machine; no user token is ever used.
 */
import type { Config } from "@cohost/config";
import { parseVideoValue } from "@cohost/shared";
import type { DepStatus } from "../catalog.js";
import { SourceFailed, type SourceCallResult } from "../source.js";
import { duration, platformText } from "./format.js";
import { quoteUntrusted } from "@cohost/shared/untrusted";
import type { BuiltinSeams, BuiltinTool } from "./types.js";
import { withDeadline, PlatformFailed, type Why, readCapped } from "./platform.js";

type Platform = "twitch" | "youtube";
const PLATFORMS: Platform[] = ["twitch", "youtube"];
const LABEL: Record<Platform, string> = { twitch: "Twitch", youtube: "YouTube" };
const FAILURE: Record<Why, string> = {
  unconfigured: "it is not configured",
  refused: "the platform refused its credential",
  notfound: "the video was not found",
  failed: "the platform did not answer",
};

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_STREAMS_URL = "https://api.twitch.tv/helix/streams";
const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
/** The app token is refreshed this long before the platform says it expires. */
const TOKEN_MARGIN_S = 60;

/** What a platform said about the channel: not live, or live with what the sentence states. */
export type Facts =
  | { live: false }
  | { live: true; title: string; viewers?: number; category?: string; startedAt?: number };

/** The longest a quoted platform title or category is shown, in code points (TOOL-STRM-009). */
const PLATFORM_QUOTE_MAX = 100;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The one sentence a live or offline platform answer reads as (TOOL-STRM-002). */
export function renderFacts(label: string, f: Facts, now: number): string {
  if (!f.live) return `${label}: not live.`;
  // Quoted as untrusted text, so a title cannot close its own quotes (TOOL-STRM-009).
  const bits = [quoteUntrusted(f.title === "" ? "untitled" : f.title, PLATFORM_QUOTE_MAX)];
  if (f.viewers !== undefined) bits.push(`${f.viewers} viewer${f.viewers === 1 ? "" : "s"}`);
  if (f.category !== undefined && f.category !== "") bits.push(`in ${quoteUntrusted(f.category, PLATFORM_QUOTE_MAX)}`);
  if (f.startedAt !== undefined) bits.push(`for ${duration(now - f.startedAt)}`);
  return `${label}: live, ${bits.join(", ")}.`;
}

interface TwitchSettings { channel: string; clientId: string; clientSecret: string }
interface YouTubeSettings { videoId: string; apiKey: string }

/** The `stream_info` tool: a per-platform answer, cached for `tools.stream_info.cache_ms`, with the dependency each platform reports. */
export class StreamInfo {
  private token: { value: string; until: number } | undefined;
  private readonly cache = new Map<Platform, { until: number; facts: Facts }>();
  private readonly outcome = new Map<Platform, "ok" | "down">();

  constructor(
    private readonly cfg: Config,
    private readonly seams: BuiltinSeams,
    private readonly deadlineMs: number,
    private readonly mock: boolean,
  ) {}

  tool(): BuiltinTool {
    return {
      name: "stream_info",
      description: "Tells whether the co-host's stream is live on Twitch or YouTube, with its title, viewer count, how long it has been live and, for Twitch, its category. Optional platform: twitch or youtube.",
      parameters: {
        type: "object",
        properties: { platform: { type: "string", enum: ["twitch", "youtube"], description: "The platform to ask; both when omitted." } },
      },
      label: "read",
      accepts: (args) => args.platform === undefined || args.platform === "twitch" || args.platform === "youtube",
      call: (args, signal) => this.call(args, signal),
    };
  }

  /** The dependencies of each platform while the tool is enabled (TOOL-STRM-007); none otherwise. */
  deps(enabled: boolean): Record<string, DepStatus> {
    if (!enabled) return {};
    const out: Record<string, DepStatus> = {};
    for (const p of PLATFORMS) {
      out[`stream.${p}`] = this.mock || !this.configured(p) ? "n/a" : (this.outcome.get(p) ?? "n/a");
    }
    return out;
  }

  // @spec TOOL-STRM-001, TOOL-STRM-005
  private async call(args: Record<string, unknown>, signal: AbortSignal): Promise<SourceCallResult> {
    if (this.mock) {
      const now = this.seams.now();
      return { content: [{ type: "text", text: renderFacts("Mock stream", { live: true, title: "Mock stream", viewers: 42, startedAt: now - 60 * 60_000 }, now) }] };
    }
    const named = typeof args.platform === "string" ? [args.platform as Platform] : undefined;
    const targets = named ?? PLATFORMS.filter((p) => this.configured(p));
    if (targets.length === 0) throw new SourceFailed("No stream platform is configured for stream_info.");
    const answers = await Promise.all(targets.map((p) => this.answer(p, signal)));
    const text = answers.map((a) => a.text).join(" ");
    if (!answers.some((a) => a.ok)) throw new SourceFailed(text);
    return { content: [{ type: "text", text }] };
  }

  /** One platform's sentence: its answer, or the reason it could not answer (TOOL-STRM-005). */
  private async answer(p: Platform, signal: AbortSignal): Promise<{ ok: boolean; text: string }> {
    const label = LABEL[p];
    if (!this.configured(p)) return { ok: false, text: `${label}: not checked, ${FAILURE.unconfigured}.` };
    try {
      const facts = await this.facts(p, signal);
      this.outcome.set(p, "ok");
      return { ok: true, text: renderFacts(label, facts, this.seams.now()) };
    } catch (err) {
      this.outcome.set(p, "down");
      const why: Why = err instanceof PlatformFailed ? err.why : "failed";
      return { ok: false, text: `${label}: not checked, ${FAILURE[why]}.` };
    }
  }

  /** A platform's facts: from the cache while it is fresh, else asked within the platform deadline (TOOL-STRM-006). */
  private async facts(p: Platform, signal: AbortSignal): Promise<Facts> {
    const hit = this.cache.get(p);
    if (hit !== undefined && this.seams.now() < hit.until) return hit.facts;
    const facts = await withDeadline(this.seams.schedule, this.deadlineMs, signal, (sig) => (p === "twitch" ? this.twitch(sig) : this.youtube(sig)));
    const cacheMs = this.cfg.tools.stream_info.cache_ms;
    if (cacheMs > 0) this.cache.set(p, { until: this.seams.now() + cacheMs, facts });
    return facts;
  }

  private twitchSettings(): TwitchSettings | undefined {
    const t = this.cfg.chat.twitch;
    if (t.channel === "" || t.client_id === "" || t.client_secret === "") return undefined;
    return { channel: t.channel, clientId: t.client_id, clientSecret: t.client_secret };
  }

  private youtubeSettings(): YouTubeSettings | undefined {
    const y = this.cfg.chat.youtube;
    const videoId = parseVideoValue(y.video);
    if (videoId === undefined || y.api_key === "") return undefined;
    return { videoId, apiKey: y.api_key };
  }

  private configured(p: Platform): boolean {
    return p === "twitch" ? this.twitchSettings() !== undefined : this.youtubeSettings() !== undefined;
  }

  /** One request to a platform host: https only, no redirect followed, a 3xx counted as a failure, the body capped. */
  private async request(url: URL, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    const res = await this.seams.fetch(url, { ...init, redirect: "manual", signal });
    if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); throw new PlatformFailed("refused"); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new PlatformFailed("failed"); }
    const text = await readCapped(res);
    try { return JSON.parse(text) as unknown; } catch { throw new PlatformFailed("failed"); }
  }

  /** The Twitch app access token by client credentials, reused until it nears its expiry; never a user token (TOOL-STRM-003). */
  private async appToken(s: TwitchSettings, signal: AbortSignal): Promise<string> {
    const now = this.seams.now();
    if (this.token !== undefined && now < this.token.until) return this.token.value;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: s.clientId, client_secret: s.clientSecret });
    const json = await this.request(new URL(TWITCH_TOKEN_URL), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, signal);
    if (!isObj(json) || typeof json.access_token !== "string" || json.access_token === "" || typeof json.expires_in !== "number" || !(json.expires_in > 0)) {
      throw new PlatformFailed("failed");
    }
    this.token = { value: json.access_token, until: now + Math.max(0, json.expires_in - TOKEN_MARGIN_S) * 1000 };
    return json.access_token;
  }

  // @spec TOOL-STRM-003, TOOL-STRM-008
  private async twitch(signal: AbortSignal): Promise<Facts> {
    const s = this.twitchSettings();
    if (s === undefined) throw new PlatformFailed("unconfigured");
    const token = await this.appToken(s, signal);
    const url = new URL(TWITCH_STREAMS_URL);
    url.searchParams.set("user_login", s.channel);
    let json: unknown;
    try {
      json = await this.request(url, { headers: { "client-id": s.clientId, authorization: `Bearer ${token}` } }, signal);
    } catch (err) {
      if (err instanceof PlatformFailed && err.why === "refused") this.token = undefined;
      throw err;
    }
    if (!isObj(json) || !Array.isArray(json.data)) throw new PlatformFailed("failed");
    if (json.data.length === 0) return { live: false };
    const d = json.data[0] as unknown;
    if (!isObj(d) || typeof d.title !== "string" || !isCount(d.viewer_count) || typeof d.started_at !== "string") throw new PlatformFailed("failed");
    const startedAt = Date.parse(d.started_at);
    if (Number.isNaN(startedAt)) throw new PlatformFailed("failed");
    const category = typeof d.game_name === "string" ? platformText(d.game_name) : undefined;
    return { live: true, title: platformText(d.title), viewers: d.viewer_count, ...(category ? { category } : {}), startedAt };
  }

  // @spec TOOL-STRM-004, TOOL-STRM-008
  private async youtube(signal: AbortSignal): Promise<Facts> {
    const y = this.youtubeSettings();
    if (y === undefined) throw new PlatformFailed("unconfigured");
    const url = new URL(YOUTUBE_VIDEOS_URL);
    url.searchParams.set("part", "snippet,liveStreamingDetails");
    url.searchParams.set("id", y.videoId);
    const json = await this.request(url, { headers: { "x-goog-api-key": y.apiKey } }, signal);
    if (!isObj(json) || !Array.isArray(json.items)) throw new PlatformFailed("failed");
    if (json.items.length === 0) throw new PlatformFailed("notfound");
    const item = json.items[0] as unknown;
    if (!isObj(item) || !isObj(item.snippet) || typeof item.snippet.title !== "string" || typeof item.snippet.liveBroadcastContent !== "string") {
      throw new PlatformFailed("failed");
    }
    if (item.snippet.liveBroadcastContent !== "live") return { live: false };
    const details = isObj(item.liveStreamingDetails) ? item.liveStreamingDetails : {};
    const viewersRaw = details.concurrentViewers;
    if (viewersRaw !== undefined && (typeof viewersRaw !== "string" || !/^\d+$/.test(viewersRaw))) throw new PlatformFailed("failed");
    let startedAt: number | undefined;
    if (details.actualStartTime !== undefined) {
      if (typeof details.actualStartTime !== "string" || Number.isNaN(Date.parse(details.actualStartTime))) throw new PlatformFailed("failed");
      startedAt = Date.parse(details.actualStartTime);
    }
    return {
      live: true,
      title: platformText(item.snippet.title),
      ...(viewersRaw !== undefined ? { viewers: Number(viewersRaw) } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };
  }
}

