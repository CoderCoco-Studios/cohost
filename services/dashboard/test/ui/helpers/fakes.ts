// Fakes for the browser APIs the UI talks to: fetch, WebSocket, Storage, Audio and timers. Pure TypeScript, no DOM
// needed, so a store test can use them without rendering anything.

export interface Call { method: string; path: string; headers: Record<string, string>; body?: string; raw?: unknown }
type Reply = { status?: number; json?: unknown; text?: string } | ((call: Call) => { status?: number; json?: unknown; text?: string } | Promise<{ status?: number; json?: unknown; text?: string }>);

/**
 * A fetch stand-in with a route table: `fake.on("GET /stack", { json: {...} })`. An unmatched request answers 404
 * `not found` (what the dashboard does). Records every call in `calls`. `on` replaces an earlier answer for the same key.
 */
export class FakeFetch {
  calls: Call[] = [];
  private routes = new Map<string, Reply>();
  /** Makes the next matching request fail like a network error. */
  private failures = new Set<string>();

  on(key: string, reply: Reply): this { this.routes.set(key, reply); return this; }
  fail(key: string): this { this.failures.add(key); return this; }
  callsTo(key: string): Call[] { return this.calls.filter((c) => `${c.method} ${c.path}` === key); }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const call: Call = { method, path, headers, body: typeof init.body === "string" ? init.body : undefined, raw: init.body };
    this.calls.push(call);
    const key = `${method} ${path}`;
    if (this.failures.delete(key)) throw new TypeError("network error");
    const reply = this.routes.get(key) ?? this.routes.get(`${method} ${path.split("?")[0]}`);
    if (!reply) return new Response("not found", { status: 404 });
    const r = typeof reply === "function" ? await reply(call) : reply;
    const status = r.status ?? 200;
    if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status, headers: { "content-type": "application/json" } });
    return new Response(status === 204 || status === 304 ? null : (r.text ?? ""), { status, headers: { "content-type": "text/plain" } });
  };
}

/** A WebSocket stand-in the test drives: `open()`, `message(obj)`, `serverClose()`. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  static reset(): void { FakeSocket.instances = []; }
  static last(): FakeSocket { return FakeSocket.instances[FakeSocket.instances.length - 1]!; }
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(payload: unknown): void { this.onmessage?.({ data: typeof payload === "string" ? payload : JSON.stringify(payload) }); }
  serverClose(): void { this.close(); }
}

/** An in-memory `Storage`; `throwing()` makes every access throw, as a private window can. */
export class FakeStorage implements Storage {
  private m = new Map<string, string>();
  constructor(private broken = false) {}
  static throwing(): FakeStorage { return new FakeStorage(true); }
  private check(): void { if (this.broken) throw new DOMException("denied", "SecurityError"); }
  get length(): number { this.check(); return this.m.size; }
  clear(): void { this.check(); this.m.clear(); }
  getItem(k: string): string | null { this.check(); return this.m.get(k) ?? null; }
  key(i: number): string | null { this.check(); return [...this.m.keys()][i] ?? null; }
  removeItem(k: string): void { this.check(); this.m.delete(k); }
  setItem(k: string, v: string): void { this.check(); this.m.set(k, String(v)); }
}

/** An `Audio` stand-in: `play()` resolves (or rejects when `refuse` is set); `end()` and `fail()` fire the events. */
export class FakeAudio {
  static instances: FakeAudio[] = [];
  static refuse = false;
  static reset(): void { FakeAudio.instances = []; FakeAudio.refuse = false; }
  onplay: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played = false;
  /** Set by `pause()`: the page stopped the clip. */
  paused = false;
  /** Playback position and length in seconds, for the estimate of a stopped clip's spoken part. */
  currentTime = 0;
  duration = 10;
  constructor(public src: string) { FakeAudio.instances.push(this); }
  play(): Promise<void> { if (FakeAudio.refuse) return Promise.reject(new DOMException("blocked", "NotAllowedError")); this.played = true; this.onplay?.(); return Promise.resolve(); }
  pause(): void { this.paused = true; }
  end(): void { this.onended?.(); }
  fail(): void { this.onerror?.(); }
}

/** Timers the test advances by hand: `after(ms, fn)` returns a cancel function; `tick(ms)` runs what is due. */
export class FakeClock {
  now = 1_700_000_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  setTimeout = (fn: () => void, ms: number): number => { const id = this.next++; this.timers.push({ at: this.now + ms, fn, id }); return id; };
  clearTimeout = (id: number | undefined): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  tick(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = end;
  }
  get pending(): number { return this.timers.length; }
}
