import { createAccess, type Access } from "./access";
import { createApi, type Api } from "./api";
import { createAudio, type Audio } from "./audio";
import { createFeed, feedUrl, type Feed } from "./feed";
import { createTheme, type Theme } from "./theme";

/** Everything the UI's stores need from the browser, injectable so a test can supply fakes. Every field has a browser default. */
export interface RuntimeDeps {
  fetch?: typeof fetch;
  local?: Storage;
  session?: Storage;
  events?: EventTarget;
  themeRoot?: HTMLElement;
  createSocket?: (url: string) => WebSocket;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
  now?: () => number;
  wsUrl?: string;
  createAudio?: (src: string) => HTMLAudioElement;
  /** The sink page (`?sink`): audio starts on without a click (DASH-UI-011). */
  sink?: boolean;
}

/** The app's stores, built once at start and shared through `AppProviders`; screens read them with the hooks in `state/hooks`. */
export interface Runtime {
  access: Access;
  api: Api;
  feed: Feed;
  theme: Theme;
  audio: Audio;
  /** The page clock, for "last seen" ages and elapsed times. */
  now: () => number;
}

const safe = <T,>(get: () => T): T | undefined => { try { return get(); } catch { return undefined; } };

export function createRuntime(deps: RuntimeDeps = {}): Runtime {
  const local = deps.local ?? safe(() => window.localStorage);
  const session = deps.session ?? safe(() => window.sessionStorage);
  const access = createAccess({ local, session, events: deps.events ?? window });
  const api = createApi({ fetch: deps.fetch, access });
  const now = deps.now ?? Date.now;
  const feed = createFeed({ url: deps.wsUrl ?? feedUrl(), createSocket: deps.createSocket, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, now });
  const theme = createTheme({ storage: local, root: deps.themeRoot });
  const audio = createAudio({ feed, sink: (report, opts) => api.sink(report, opts), createAudio: deps.createAudio, enabled: deps.sink, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout });
  return { access, api, feed, theme, audio, now };
}
