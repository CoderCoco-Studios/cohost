/**
 * Harness of the built-in tool tests (#207). Not a test file.
 *
 * These tests fix one seam the implementation must offer: `ToolsEnv.builtin`, passed through `startTools(..., env)`:
 *
 * - `fetch`: the `fetch` the built-in tools use for every platform call (Twitch, YouTube). No test touches the network.
 * - `now`: `() => epoch ms`, the clock of `clock`, `stream_info` (uptime, cache, token expiry) and `timer` (setAt, dueAt).
 * - `schedule`: `(fn, ms) => cancel`, the one scheduler of every wait a built-in tool starts: a timer's due time, the
 *   deadline of a platform call, the deadline of a memory lookup. Calling `cancel` must make `fn` never run.
 *
 * A wait a built-in tool bounds by the call limit (a platform call, a memory lookup) is scheduled for at most
 * `tools.timeout_ms`, so it ends before the pipeline's own `timeout` and the tool answers with its own reason.
 */
import { ToolsFakeBus, startTools, waitFor, type Started } from "./helpers.js";

export { waitFor };

/** 2026-11-23 14:05:09 UTC: Monday in UTC, Tuesday 2026-11-24 03:05:09 in Pacific/Auckland (NZDT, +13). */
export const NOW = Date.UTC(2026, 10, 23, 14, 5, 9);
export const ZONE = "Pacific/Auckland";
export const MIN = 60_000;

export interface Scheduled { fn: () => void; ms: number; cancelled: boolean; ran: boolean }

/** A scheduler and a clock the test drives by hand: nothing waits in real time. */
export class Clock {
  t = NOW;
  items: Scheduled[] = [];
  now = (): number => this.t;
  schedule = (fn: () => void, ms: number): (() => void) => {
    const it: Scheduled = { fn, ms, cancelled: false, ran: false };
    this.items.push(it);
    return () => { it.cancelled = true; };
  };
  /** Waits that are neither cancelled nor run. */
  active = (): Scheduled[] => this.items.filter((i) => !i.cancelled && !i.ran);
  /** The active waits no longer than `ms`: what a bounded call (not a timer) schedules. */
  bounded = (ms: number): Scheduled[] => this.active().filter((i) => i.ms <= ms);
  /** The active waits longer than `ms`: timers. */
  longer = (ms: number): Scheduled[] => this.active().filter((i) => i.ms > ms);
  run(it: Scheduled, advance = it.ms): void {
    this.t += advance;
    if (it.cancelled || it.ran) return;
    it.ran = true;
    it.fn();
  }
  env(fetch?: typeof globalThis.fetch): Record<string, unknown> {
    return { builtin: { now: this.now, schedule: this.schedule, ...(fetch ? { fetch } : {}) } };
  }
}

/** A bus that also records the order of publishes among the timer-hash calls. */
export class OrderedBus extends ToolsFakeBus {
  override async publish(type: never, data: never): Promise<string> {
    const id = await super.publish(type, data);
    this.calls.push(`publish:${type as string}`);
    return id;
  }
}

export interface Seen { url: string; method: string; headers: Record<string, string>; body: string; init: RequestInit }

/** A scripted `fetch`: every request is recorded; `route` answers it. */
export function scriptedFetch(route: (r: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const r: Seen = { url: String(input), method: (init.method ?? "GET").toUpperCase(), headers, body: init.body === undefined ? "" : String(init.body), init };
    seen.push(r);
    return route(r);
  }) as typeof globalThis.fetch;
  return { fn, seen };
}
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const SECRETS = { twitchSecret: "sekrit-twitch-secret-77", ytKey: "sekrit-yt-key-88", userToken: "user-token-99" };
export const VIDEO = "dQw4w9WgXcQ";

/** The `chat` section with both platforms configured. */
export const chat = (over: { twitch?: Record<string, unknown>; youtube?: Record<string, unknown> } = {}) => ({
  chat: {
    twitch: { channel: "chan", client_id: "cid-1", client_secret: SECRETS.twitchSecret, ...over.twitch },
    youtube: { video: VIDEO, api_key: SECRETS.ytKey, ...over.youtube },
  },
});
export const cohost = { cohost: { name: "Coco", streamer: "Chris", timezone: ZONE } };

export const isTwitchToken = (r: Seen): boolean => r.url.startsWith("https://id.twitch.tv/oauth2/token");
export const isTwitchStreams = (r: Seen): boolean => r.url.startsWith("https://api.twitch.tv/helix/streams");
export const isYoutube = (r: Seen): boolean => r.url.startsWith("https://www.googleapis.com/youtube/v3/videos");

export function twitchOk(over: Record<string, unknown> = {}, clock?: Clock) {
  return (r: Seen): Response => {
    if (isTwitchToken(r)) return json({ access_token: "app-token-1", expires_in: 3600, token_type: "bearer" });
    if (isTwitchStreams(r)) {
      return json({ data: [{ type: "live", title: "Speedrun night", viewer_count: 321, game_name: "Just Chatting", started_at: new Date((clock?.t ?? NOW) - 90 * MIN).toISOString(), ...over }] });
    }
    return json({}, 404);
  };
}
export function youtubeOk(over: Record<string, unknown> = {}, clock?: Clock) {
  return (): Response => json({
    items: [{
      snippet: { title: "Stream of cats", liveBroadcastContent: "live" },
      liveStreamingDetails: { actualStartTime: new Date((clock?.t ?? NOW) - 90 * MIN).toISOString(), concurrentViewers: "77" },
      ...over,
    }],
  });
}
/** Routes Twitch and YouTube requests to their own handlers. */
export const both = (tw: (r: Seen) => Response | Promise<Response>, yt: (r: Seen) => Response | Promise<Response>) =>
  (r: Seen): Response | Promise<Response> => (isYoutube(r) ? yt(r) : tw(r));

export interface Opts {
  tools?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  bus?: ToolsFakeBus;
  fetch?: typeof globalThis.fetch;
  clock?: Clock;
}
/** Starts the service with the built-ins in `allow` as given (live mode, no hash: built-ins carry none) and the fake clock. */
export async function startBuiltin(allow: Record<string, unknown>, o: Opts = {}): Promise<Started & { clock: Clock }> {
  const clock = o.clock ?? new Clock();
  const s = await startTools({ allow, ...o.tools }, [], { ...cohost, ...o.extra }, o.bus ?? new ToolsFakeBus(), undefined, clock.env(o.fetch));
  return Object.assign(s, { clock });
}
export const mockTools = (allow: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ mode: "mock", ...over, allow });

/** Calls a built-in tool and waits for its result. */
export async function callTool(s: Started, tool: string, args: Record<string, unknown> = {}, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const id = await s.request({ tool, arguments: args, ...over });
  await waitFor(() => s.results().some((r) => r.id === id), `result of ${tool}`);
  return s.results().find((r) => r.id === id)!;
}
/** The text of everything the service published or logged, to prove a secret never left. */
export function everything(s: Started): string {
  return JSON.stringify([s.bus.published, s.bus.health, s.log.lines]);
}
