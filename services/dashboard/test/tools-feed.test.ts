import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { WebSocket } from "ws";
import { FakeBus, recordingLog, testConfig, waitFor } from "@cohost/testing";
import { runService } from "@cohost/shared";
import type { BusEvent } from "@cohost/bus";
import type { StackService, StackOps } from "../src/stack.js";
import { dashboardService } from "../src/service.js";

// Tool text stays off the LAN: the arguments of a tool.request and tool.confirm and the content of a tool.result are what a
// recalled viewer memory or the owner's private lookup ends up in. A socket that arrived on the LAN listener, or on the
// full-surface listener while it is bound beyond loopback, gets them emptied, live and in the connect replay; a socket on
// the loopback full surface gets every tool event whole (DASH-FEED-011, DASH-FEED-012). These tests run the whole service
// with real sockets, so they hold whichever way the feed learns which listener a socket arrived on.

type Tail = (ev: BusEvent) => void;

class FeedBus extends FakeBus {
  stopped = 0;
  replay: BusEvent[] = [];
  /** Resolves the connect replay's read; default at once. */
  gate: Promise<void> = Promise.resolve();
  tails: Tail[] = [];
  stop(): void { this.stopped++; }
  async recent(): Promise<BusEvent[]> { await this.gate; return this.replay; }
  async tail(cb: Tail): Promise<void> { this.tails.push(cb); }
  async tailHealth(): Promise<void> {}
  emit(ev: BusEvent): void { for (const t of this.tails) t(ev); }
}

const idleStack = (s: StackService): void => {
  const ok = async () => ({ ok: true }) as never;
  const ops: StackOps = { status: async () => ({ docker: { ok: true }, services: [] }), launch: ok, rebuild: ok, stopAll: ok, restartAll: ok, consolidate: ok };
  s.attach(ops);
};

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const CTRL_OFF: NodeJS.ProcessEnv = {};
/** The full surface bound to every interface: it needs control mode (DASH-HOST-007). */
const NON_LOOPBACK: NodeJS.ProcessEnv = { CONTROL_ENABLED: "1", CONTROL_TOKEN: "tok", DASHBOARD_HOST: "0.0.0.0" };

async function rig(env: NodeJS.ProcessEnv, replay: BusEvent[] = []) {
  const dashboard = { port: await freePort(), lan_port: await freePort() };
  const bus = new FeedBus();
  bus.replay = replay;
  const rec = recordingLog();
  let shutdown: (() => void | Promise<void>) | undefined;
  const svc = dashboardService({ env, exit: () => {}, lanHost: "127.0.0.1", attachStack: idleStack });
  await runService({
    service: "dashboard", health: svc.health, main: svc.main,
    loadConfig: () => testConfig({ dashboard }), createBus: () => bus as never, log: rec.log,
    onShutdown: (fn) => { shutdown = fn; }, exit: () => {},
  });
  await waitFor(() => bus.tails.length > 0, "the live tail");
  const sockets: WebSocket[] = [];
  /** Opens `/ws` on a port and collects every frame; resolves once open. */
  const connect = async (port: number) => {
    const frames: Record<string, unknown>[] = [];
    const raw: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("message", (d) => { const t = d.toString(); raw.push(t); frames.push(JSON.parse(t) as Record<string, unknown>); });
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.on("open", () => resolve()); ws.on("error", reject); });
    const events = () => frames.filter((f) => typeof f.type === "string" && f.type.startsWith("tool."));
    return { ws, frames, raw, events };
  };
  const stop = async () => { for (const s of sockets) s.terminate(); await shutdown?.(); };
  return { bus, dashboard, connect, stop, full: dashboard.port, lan: dashboard.lan_port };
}

const SECRET = "SECRET-RECALLED-MEMORY";
let seq = 0;
const ev = (type: string, data: Record<string, unknown>): BusEvent => ({ id: `${Date.now()}-${++seq}`, type, ts: 1_700_000_000_000 + seq, source: "tools", data }) as unknown as BusEvent;

const request = () => ev("tool.request", { id: "c1", tool: "recall", arguments: { query: SECRET, nested: { a: SECRET } }, origin: "speech", round: 1, listed: true, injected: true });
const confirm = () => ev("tool.confirm", { id: "c2", tool: "weather__post", arguments: { text: SECRET }, origin: "dashboard", expiresAt: 1_700_000_020_000 });
const result = () => ev("tool.result", { id: "c1", tool: "recall", status: "ok", content: `you said ${SECRET}`, durationMs: 42, truncated: true, mock: true });
const refused = () => ev("tool.result", { id: "c3", tool: "weather__post", status: "refused", reason: "denied", content: "", durationMs: 0 });
const catalog = () => ev("tool.catalog", { intervalMs: 30000, mode: "live", servers: [], tools: [{ name: "recall", description: `describes ${SECRET}`, parameters: {}, label: "read", effect: "read", enabled: true, acts: false, chat: false, confirm: true, offered: true }] });
const timer = () => ev("tool.timer", { id: "t1", note: `remind ${SECRET}`, setAt: 1, dueAt: 2 });
const all = () => [request(), confirm(), result(), refused(), catalog(), timer()];

const data = (f: Record<string, unknown>) => f.data as Record<string, unknown>;
const byId = (frames: Record<string, unknown>[], type: string, id: string) => frames.find((f) => f.type === type && data(f).id === id)!;

/** What a redacted socket must see for the tool events of `all()`: nothing of SECRET in the three, everything else whole. */
function assertRedacted(c: { events(): Record<string, unknown>[]; raw: string[] }, label: string): void {
  const req = byId(c.events(), "tool.request", "c1");
  assert.deepEqual(data(req).arguments, {}, `${label}: request arguments`);
  assert.deepEqual({ ...data(req), arguments: undefined }, { id: "c1", tool: "recall", origin: "speech", round: 1, listed: true, injected: true, redacted: true, arguments: undefined }, `${label}: every other request member is unchanged, and the emptied one says so`);
  const conf = byId(c.events(), "tool.confirm", "c2");
  assert.deepEqual(data(conf).arguments, {}, `${label}: confirm arguments`);
  assert.deepEqual({ ...data(conf), arguments: undefined }, { id: "c2", tool: "weather__post", origin: "dashboard", expiresAt: 1_700_000_020_000, redacted: true, arguments: undefined }, `${label}: every other confirm member is unchanged, and the emptied one says so`);
  const res = byId(c.events(), "tool.result", "c1");
  assert.equal(data(res).content, "", `${label}: result content`);
  assert.equal("truncated" in data(res), false, `${label}: no truncated`);
  assert.deepEqual(data(res), { id: "c1", tool: "recall", status: "ok", content: "", durationMs: 42, mock: true, redacted: true }, `${label}: status, duration and mock stay, and the emptied content says so`);
  const ref = byId(c.events(), "tool.result", "c3");
  assert.deepEqual(data(ref), { id: "c3", tool: "weather__post", status: "refused", reason: "denied", content: "", durationMs: 0 }, `${label}: a refusal keeps its reason`);
  assert.equal(c.raw.some((r) => r.includes(SECRET) && /"type":"tool\.(request|confirm|result)"/.test(r)), false, `${label}: the text of the three is on no frame`);
  // the timer's note is emptied too (DASH-FEED-011); the catalog is not touched
  assert.equal(data(byId(c.events(), "tool.timer", "t1")).note, "", `${label}: tool.timer note is emptied`);
  assert.equal("redacted" in data(byId(c.events(), "tool.timer", "t1")), false, `${label}: a timer carries no redacted member`);
  assert.ok(JSON.stringify(c.events().find((f) => f.type === "tool.catalog")).includes(`describes ${SECRET}`), `${label}: tool.catalog is unchanged`);
}

function assertWhole(c: { events(): Record<string, unknown>[] }, sent: BusEvent[], label: string): void {
  for (const e of sent) {
    const got = c.events().find((f) => f.id === e.id)!;
    assert.ok(got, `${label}: ${e.type} arrived`);
    assert.deepEqual(got.data, e.data, `${label}: ${e.type} is unchanged`);
  }
}

// @spec DASH-FEED-012, DASH-FEED-002
test("a socket on the loopback full surface gets every tool event unchanged, live and in the replay", async (t) => {
  const history = all();
  const r = await rig(CTRL_OFF, history);
  t.after(r.stop);
  const replayed = await r.connect(r.full);
  await waitFor(() => replayed.events().length >= 6, "the replay");
  assertWhole(replayed, history, "replay");
  assert.ok(replayed.events().every((f) => f.replay === true));
  const live = all();
  r.bus.emit(live[0]!); r.bus.emit(live[1]!); r.bus.emit(live[2]!);
  await waitFor(() => replayed.events().length >= 9, "the live events");
  for (const e of live.slice(0, 3)) assert.deepEqual(replayed.frames.find((f) => f.id === e.id)!.data, e.data);
});

// @spec DASH-FEED-011, DASH-HOST-001
test("a socket on the LAN listener gets the arguments of tool.request and tool.confirm as {} and tool.result's content empty with no truncated, live", async (t) => {
  const r = await rig(CTRL_OFF);
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  const full = await r.connect(r.full);
  const sent = all();
  for (const e of sent) r.bus.emit(e);
  await waitFor(() => lan.events().length >= 6 && full.events().length >= 6, "the live events");
  assertRedacted(lan, "LAN live");
  assertWhole(full, sent, "loopback live beside it");
});

// @spec DASH-FEED-011, DASH-HOST-001
test("the same on a LAN socket's connect replay: replayed tool events are redacted and keep replay: true", async (t) => {
  const r = await rig(CTRL_OFF, all());
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  await waitFor(() => lan.events().length >= 6, "the replay");
  assert.ok(lan.events().every((f) => f.replay === true));
  assertRedacted(lan, "LAN replay");
});

// @spec DASH-FEED-011
test("the full-surface listener bound to a non-loopback address redacts for its sockets too, even for a peer that is on loopback, live and in the replay", async (t) => {
  const r = await rig(NON_LOOPBACK, all());
  t.after(r.stop);
  const replayed = await r.connect(r.full);
  await waitFor(() => replayed.events().length >= 6, "the replay");
  assertRedacted(replayed, "bound-beyond-loopback replay");
  const live = await r.connect(r.full);
  await waitFor(() => live.events().length >= 6, "the second replay");
  for (const e of all()) r.bus.emit(e);
  await waitFor(() => live.events().length >= 12, "the live events");
  assertRedacted(live, "bound-beyond-loopback live");
});

// @spec DASH-FEED-011
test("a live tool event that lands while a LAN socket's replay is still being read is held and sent redacted, not whole", async (t) => {
  const r = await rig(CTRL_OFF);
  t.after(r.stop);
  let release!: () => void;
  r.bus.gate = new Promise<void>((res) => { release = res; });
  const lan = await r.connect(r.lan);
  for (const e of all()) r.bus.emit(e);
  assert.equal(lan.events().length, 0, "held behind the replay");
  release();
  await waitFor(() => lan.events().length >= 6, "the held events");
  assertRedacted(lan, "held during replay");
});

// @spec DASH-FEED-011
test("a LAN client and a loopback client on one feed each get their own form of the same event: redacting for one never changes what the other is sent", async (t) => {
  const r = await rig(CTRL_OFF);
  t.after(r.stop);
  const [a, b, c] = [await r.connect(r.lan), await r.connect(r.full), await r.connect(r.lan)];
  const e = request();
  r.bus.emit(e);
  await waitFor(() => [a, b, c].every((x) => x.events().length >= 1), "the event");
  assert.deepEqual(data(a.events()[0]!).arguments, {});
  assert.deepEqual(data(c.events()[0]!).arguments, {});
  assert.deepEqual(data(b.events()[0]!).arguments, e.data.arguments);
});

// @spec DASH-FEED-011
test("the text of an inject.request for the tools unit and the note of a tool.timer are emptied for a LAN socket in its replay; a call with no arguments is not marked redacted", async (t) => {
  const inj = ev("inject.request", { id: "i1", target: "tools", kind: "text", text: `{"tool":"x","arguments":{"q":"${SECRET}"}}`, remember: false });
  const timer = ev("tool.timer", { id: "t9", note: `remind ${SECRET}`, setAt: 1, dueAt: 2 });
  const none = ev("tool.request", { id: "c9", tool: "stream_info", arguments: {}, origin: "speech", round: 1, listed: true });
  const r = await rig(CTRL_OFF, [inj, timer, none]);
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  await waitFor(() => lan.frames.some((f) => f.type === "inject.request") && lan.frames.some((f) => f.type === "tool.timer") && lan.events().length >= 1, "the replay");
  assert.equal(data(lan.frames.find((f) => f.type === "inject.request")!).text, "", "the tools text is emptied");
  assert.equal(data(lan.frames.find((f) => f.type === "tool.timer")!).note, "", "the timer note is emptied");
  assert.equal(lan.raw.some((x) => x.includes(SECRET) && x.includes('"target":"tools"')), false, "the text is on no frame");
  assert.equal("redacted" in data(lan.events().find((f) => data(f).id === "c9")!), false, "nothing was held, so nothing is marked");
});

// @spec DASH-FEED-011
test("memory recall events are redacted for a LAN socket, live and in its replay: the query and each memory's text are emptied and marked; the loopback socket gets them whole", async (t) => {
  const request = ev("memory.recall.request", { id: "m1", query: `who is ${SECRET}`, k: 3 });
  const reply = ev("memory.recall.reply", { id: "m1", memories: [{ ts: 1, kind: "note", who: "bob", text: `note ${SECRET}` }] });
  const r = await rig(CTRL_OFF, [request, reply]);
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  const full = await r.connect(r.full);
  await waitFor(() => lan.frames.some((f) => f.type === "memory.recall.reply") && full.frames.some((f) => f.type === "memory.recall.reply"), "the replay");
  const lanReq = lan.frames.find((f) => f.type === "memory.recall.request")!;
  const lanRep = lan.frames.find((f) => f.type === "memory.recall.reply")!;
  assert.equal(data(lanReq).query, "", "replay: the query is emptied");
  assert.equal(data(lanReq).redacted, true, "replay: the query is marked");
  assert.equal((data(lanRep).memories as { text: string }[])[0]!.text, "", "replay: each memory's text is emptied");
  assert.equal(data(lanRep).redacted, true, "replay: the reply is marked");
  assert.equal(lan.raw.some((x) => x.includes(SECRET) && x.includes('"type":"memory.recall')), false, "replay: the text is on no frame");
  const fullReq = full.frames.find((f) => f.type === "memory.recall.request")!;
  assert.equal(data(fullReq).query, `who is ${SECRET}`, "loopback replay: the query is whole");
  assert.equal("redacted" in data(fullReq), false, "loopback replay: nothing marked");
  // live: a reply that lands after the connect
  r.bus.emit(ev("memory.recall.reply", { id: "m2", memories: [{ ts: 2, kind: "chat", who: "a", text: `live ${SECRET}` }] }));
  await waitFor(() => lan.frames.filter((f) => f.type === "memory.recall.reply").length >= 2, "the live reply");
  const liveRep = lan.frames.filter((f) => f.type === "memory.recall.reply")[1]!;
  assert.equal((data(liveRep).memories as { text: string }[])[0]!.text, "", "live: the text is emptied");
  assert.equal(data(liveRep).redacted, true, "live: marked");
  assert.equal(lan.raw.some((x) => x.includes(SECRET) && x.includes('"type":"memory.recall')), false, "live: the text is on no frame");
});

// @spec DASH-FEED-011
test("a tool.request whose arguments are not an empty plain object is marked redacted, whatever its type: the redaction fails closed", async (t) => {
  const r = await rig(CTRL_OFF);
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  r.bus.emit(ev("tool.request", { id: "c7", tool: "stream_info", arguments: "not-an-object", origin: "speech", round: 1, listed: true }));
  r.bus.emit(ev("tool.request", { id: "c8", tool: "stream_info", arguments: null, origin: "speech", round: 1, listed: true }));
  await waitFor(() => lan.events().length >= 2, "the two requests");
  for (const id of ["c7", "c8"]) {
    const f = lan.events().find((x) => data(x).id === id)!;
    assert.deepEqual(data(f).arguments, {}, `${id}: arguments emptied`);
    assert.equal(data(f).redacted, true, `${id}: marked`);
  }
});

// @spec DASH-FEED-011
test("an inject.request for the tools unit carries no redacted member: its text is emptied and nothing more is marked", async (t) => {
  const r = await rig(CTRL_OFF);
  t.after(r.stop);
  const lan = await r.connect(r.lan);
  r.bus.emit(ev("inject.request", { id: "i2", target: "tools", kind: "text", text: `{"tool":"x"}`, remember: false }));
  await waitFor(() => lan.frames.some((f) => f.type === "inject.request"), "the inject");
  const f = lan.frames.find((x) => x.type === "inject.request")!;
  assert.equal(data(f).text, "");
  assert.equal("redacted" in data(f), false);
});
