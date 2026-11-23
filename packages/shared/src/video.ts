const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

const videoId = (candidate: string | null | undefined): string | undefined =>
  candidate && VIDEO_ID.test(candidate) ? candidate : undefined;

// @spec SHARED-VID-001, CHAT-YT-004, CHAT-YT-005, CHAT-YT-006
/**
 * The video id a YouTube video value names, or undefined when it names no video (a channel, a playlist, a phrase).
 * Accepts a bare 11-character id, and watch, short, live, embed and live-chat URLs on the listed hosts.
 */
export function parseVideoValue(value: string): string | undefined {
  const v = value.trim();
  if (VIDEO_ID.test(v)) return v;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") return videoId(url.pathname.slice(1));
  if (!WATCH_HOSTS.has(host)) return undefined;
  if (url.pathname === "/watch" || url.pathname === "/live_chat") return videoId(url.searchParams.get("v"));
  const path = /^\/(?:live|embed)\/([^/]+)$/.exec(url.pathname);
  return path ? videoId(path[1]) : undefined;
}
