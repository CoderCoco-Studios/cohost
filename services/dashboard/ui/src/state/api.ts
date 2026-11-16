import type { Access } from "./access";
import type { ControlInfo, ServiceHealth, StackActionKind, StackSnapshot, TokenKind, UnitDescriptor } from "./types";

/**
 * The result of every request, whatever the route answers. Failures carry the HTTP status (0 for a network error) and the
 * server's `detail`, taken from a JSON `{detail}` body or the plain-text body, so a screen shows one shape (DASH-UI-015).
 */
export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; detail: string; /** The parsed JSON body when the server sent one (`issues`, `sensitive`, ...). */ data?: unknown; /** The operator cancelled the Access dialog. */ locked?: boolean; network?: boolean };

export interface RequestOptions {
  /** Which token the route takes: `control` for every gated route, `viewers` for `/viewers`. A read sends none. */
  auth?: TokenKind;
  /** What is waiting, named in the Access dialog when the request needs a token ("Restart voice"). */
  action?: string;
  /** Ask for the token before sending when none is held (the secret write always needs one). */
  requireToken?: boolean;
  /**
   * Send exactly this bearer token, never prompting and never touching the stored one: the Access dialog uses it to check
   * a token the operator typed before it is stored (DASH-ACC-004). Without `auth` a 401 is returned as it is.
   */
  token?: string;
  /** Content type of a raw body (an uploaded image or audio file); a JSON or text body sets its own. */
  contentType?: string;
  signal?: AbortSignal;
}

export interface Api {
  request<T = unknown>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<ApiResult<T>>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<ApiResult<T>>;
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<ApiResult<T>>;
  // Typed wrappers for the routes the shell and several screens share. Anything else goes through get/post/put.
  services(): Promise<ApiResult<{ services: ServiceHealth[] }>>;
  controlInfo(): Promise<ApiResult<ControlInfo>>;
  manifest(): Promise<ApiResult<{ units: UnitDescriptor[] }>>;
  stack(): Promise<ApiResult<StackSnapshot>>;
  /** `POST /control`: mute, unmute, say, forget_context, pause, resume, reload_personality, set_routing. */
  control(body: { cmd: string; text?: string; target?: string; route?: string[] }, action: string): Promise<ApiResult<undefined>>;
  /** `POST /services/:id/(start|stop|restart)`. */
  lifecycle(id: string, op: "start" | "stop" | "restart", body: { mode?: "resume" | "fresh"; isolated?: boolean } | undefined, action: string): Promise<ApiResult<{ ok: boolean; detail?: string }>>;
  /** `POST /stack/(launch|stop|restart|consolidate|rebuild)`. */
  stackAction(kind: StackActionKind, action: string): Promise<ApiResult<{ ok: true; action: StackActionKind }>>;
  /** `POST /sink`, the audio sink's playing/done report (no token). */
  sink(event: "playing" | "done", id: string): Promise<ApiResult<undefined>>;
}

export interface ApiDeps {
  fetch?: typeof fetch;
  access: Pick<Access, "getToken" | "lock" | "ask">;
}

const LOCKED = (status: number): ApiResult<never> => ({ ok: false, status, detail: "not done: locked", locked: true });

async function parse(res: Response): Promise<{ data?: unknown; detail?: string }> {
  if (res.status === 204 || res.status === 205) return {};
  const text = await res.text().catch(() => "");
  if ((res.headers.get("content-type") ?? "").includes("json") && text !== "") {
    try {
      const data = JSON.parse(text) as unknown;
      const detail = data && typeof data === "object" && typeof (data as { detail?: unknown }).detail === "string" ? (data as { detail: string }).detail : undefined;
      return { data, detail };
    } catch { /* fall through: treat as text */ }
  }
  return { data: text === "" ? undefined : text, detail: text };
}

/**
 * The one module every HTTP request goes through. It normalises the dashboard's mixed JSON and plain-text answers,
 * attaches the bearer token (header only), and turns a missing or rejected token into the shared "open the Access
 * dialog, then retry once" flow (DASH-UI-006, DASH-ACC-006, DASH-ACC-012). Never throws: a network error is a result.
 */
// @spec DASH-UI-006, DASH-UI-015, DASH-ACC-006, DASH-ACC-012
export function createApi(deps: ApiDeps): Api {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function once<T>(method: string, path: string, body: unknown, opts: RequestOptions, token: string | undefined): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      if (typeof body === "string") { payload = body; headers["content-type"] = opts.contentType ?? "text/plain; charset=utf-8"; }
      else if (body instanceof Uint8Array || body instanceof Blob || body instanceof ArrayBuffer) { payload = body as BodyInit; if (opts.contentType) headers["content-type"] = opts.contentType; }
      else { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    }
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try { res = await doFetch(path, { method, headers, body: payload, signal: opts.signal }); }
    catch (err) { return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err), network: true }; }
    const { data, detail } = await parse(res);
    if (res.ok) return { ok: true, status: res.status, data: data as T };
    return { ok: false, status: res.status, detail: detail || res.statusText || `HTTP ${res.status}`, ...(data !== undefined && typeof data === "object" ? { data } : {}) };
  }

  async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<ApiResult<T>> {
    if (opts.token !== undefined) return once<T>(method, path, body, opts, opts.token);
    const kind = opts.auth;
    const action = opts.action ?? `${method} ${path}`;
    let token = kind ? deps.access.getToken(kind) : undefined;
    if (kind && !token && opts.requireToken) {
      if (!(await deps.access.ask(kind, action))) return LOCKED(401);
      token = deps.access.getToken(kind);
    }
    const first = await once<T>(method, path, body, opts, token);
    if (first.ok || first.status !== 401 || !kind) return first;
    // A 401: the token was missing or wrong. A stored token the server rejects is cleared (the button shows Locked).
    const rejected = token !== undefined;
    if (rejected) deps.access.lock(kind);
    if (!(await deps.access.ask(kind, action, { rejected }))) return LOCKED(401);
    return once<T>(method, path, body, opts, deps.access.getToken(kind));
  }

  const api: Api = {
    request,
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
    put: (path, body, opts) => request("PUT", path, body, opts),
    services: () => request("GET", "/services"),
    controlInfo: () => request("GET", "/services/control"),
    manifest: () => request("GET", "/services/manifest"),
    stack: () => request("GET", "/stack"),
    control: (body, action) => request("POST", "/control", body, { auth: "control", action }),
    lifecycle: (id, op, body, action) => request("POST", `/services/${encodeURIComponent(id)}/${op}`, body, { auth: "control", action }),
    stackAction: (kind, action) => request("POST", `/stack/${kind}`, undefined, { auth: "control", action }),
    sink: (event, id) => request("POST", "/sink", { event, id }),
  };
  return api;
}
