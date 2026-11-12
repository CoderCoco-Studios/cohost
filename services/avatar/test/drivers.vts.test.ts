import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { VTubeStudioDriver } from "../src/drivers/vtube-studio.js";
import type { DriverContext } from "../src/types.js";

type Req = { requestID: string; messageType: string; data: Record<string, unknown> };

const logs = { warn: [] as unknown[], error: [] as unknown[] };
const log = { warn: (o: unknown) => logs.warn.push(o), error: (o: unknown) => logs.error.push(o), info() {}, debug() {} } as never;
const ctx = (over: Partial<DriverContext> = {}): DriverContext => ({
  log, stateDir: mkdtempSync(join(tmpdir(), "cohost-avatar-vts-")),
  expressions: { happy: "Smile", confused: "NoSuchHotkey" }, gestures: {}, ...over,
});
async function waitFor(cond: () => boolean, what: string, ms = 3000) {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A VTube Studio stand-in. `silentOn` names a request type it never answers; `connections` counts accepted sockets. */
async function vtsServer(opts: { silentOn?: string } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const reqs: Req[] = [];
  let connections = 0;
  wss.on("connection", (ws: WebSocket) => {
    connections++;
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Req;
      reqs.push(m);
      if (m.messageType === opts.silentOn) return;
      const reply = (messageType: string, data: unknown) =>
        ws.send(JSON.stringify({ apiName: "VTubeStudioPublicAPI", requestID: m.requestID, messageType, data }));
      switch (m.messageType) {
        case "AuthenticationTokenRequest": return reply("AuthenticationTokenResponse", { authenticationToken: "tok" });
        case "AuthenticationRequest": return reply("AuthenticationResponse", { authenticated: true });
        case "HotkeysInCurrentModelRequest":
          return reply("HotkeysInCurrentModelResponse", { availableHotkeys: [{ name: "Smile", type: "ToggleExpression", hotkeyID: "hk-smile" }] });
        default: return reply(`${m.messageType.replace(/Request$/, "")}Response`, {});
      }
    });
  });
  await new Promise<void>((r) => wss.once("listening", r));
  after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  return { wss, reqs, port: (wss.address() as { port: number }).port, connections: () => connections };
}
const vts = (port: number, extra: Record<string, unknown> = {}) =>
  new VTubeStudioDriver({ host: "127.0.0.1", port, pluginName: "cohost", pluginDeveloper: "dev", ...extra } as never);

test("vts: a request with no reply within its timeout rejects with a timed out error", async () => { // @spec AVATAR-VTS-006
  const s = await vtsServer({ silentOn: "AuthenticationRequest" });
  logs.error.length = 0;
  const d = vts(s.port, { requestTimeoutMs: 100 });
  const t0 = performance.now();
  await d.connect(ctx());
  assert.equal(d.connected(), false);
  assert.ok(performance.now() - t0 < 2000, "gave up after the request timeout, not the default");
  const err = (logs.error[0] as { err: Error }).err;
  assert.match(err.message, /AuthenticationRequest timed out/);
  await d.disconnect();
});

test("vts: after the socket drops it reconnects until connected; disconnect cancels a pending reconnect", async () => { // @spec AVATAR-VTS-007
  const s = await vtsServer();
  const d = vts(s.port, { reconnectMs: 50 });
  await d.connect(ctx());
  assert.equal(d.connected(), true);
  assert.equal(s.connections(), 1);

  for (const c of s.wss.clients) c.terminate(); // the app went away
  await waitFor(() => !d.connected(), "marked disconnected");
  await waitFor(() => s.connections() === 2 && d.connected(), "reconnected");

  for (const c of s.wss.clients) c.terminate();
  await waitFor(() => !d.connected(), "marked disconnected again");
  await d.disconnect(); // asked to stop while the reconnect is waiting
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.connections(), 2, "no further attempt after disconnect");
  assert.equal(d.connected(), false);
});

test("vts: pending requests are rejected when the socket closes", async () => { // @spec AVATAR-VTS-007
  const s = await vtsServer({ silentOn: "HotkeysInCurrentModelRequest" });
  logs.error.length = 0;
  const d = vts(s.port, { reconnectMs: 10_000 });
  const connecting = d.connect(ctx());
  await waitFor(() => s.reqs.some((r) => r.messageType === "HotkeysInCurrentModelRequest"), "the unanswered request");
  for (const c of s.wss.clients) c.terminate();
  await connecting;
  assert.match((logs.error[0] as { err: Error }).err.message, /socket closed/);
  await d.disconnect();
});

test("vts: an expression name matching no hotkey logs a warning and sends nothing", async () => { // @spec AVATAR-VTS-015
  const s = await vtsServer();
  const d = vts(s.port);
  await d.connect(ctx());
  s.reqs.length = 0;
  logs.warn.length = 0;
  d.setExpression("confused", 1);
  await waitFor(() => logs.warn.length >= 1, "the warning");
  assert.deepEqual(logs.warn[0], { name: "NoSuchHotkey" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.reqs.length, 0, "no request went out");
  await d.disconnect();
});

test("vts: a host that accepts the connection but never answers the handshake is abandoned and retried", async () => { // @spec AVATAR-VTS-016
  let accepted = 0;
  const sockets: net.Socket[] = [];
  const blackhole = net.createServer((sock) => { accepted++; sockets.push(sock); }); // never speaks HTTP
  await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", r));
  after(() => { for (const s of sockets) s.destroy(); blackhole.close(); });
  const port = (blackhole.address() as net.AddressInfo).port;

  const d = vts(port, { handshakeTimeoutMs: 100, reconnectMs: 50 });
  const t0 = performance.now();
  await d.connect(ctx());
  assert.ok(performance.now() - t0 < 2000, "connect settled after the handshake timeout");
  assert.equal(d.connected(), false);
  await waitFor(() => accepted >= 2, "a second attempt");
  await d.disconnect();
});

test("vts: the once-per-5 s request-failure log measures elapsed time, not the wall clock", async () => { // @spec AVATAR-VTS-014
  const s = await vtsServer();
  s.wss.removeAllListeners("connection");
  s.wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Req;
      const reply = (messageType: string, data: unknown) => ws.send(JSON.stringify({ requestID: m.requestID, messageType, data }));
      if (m.messageType === "HotkeyTriggerRequest") return reply("APIError", { errorID: 8, message: "nope" });
      if (m.messageType === "HotkeysInCurrentModelRequest") return reply("HotkeysInCurrentModelResponse", { availableHotkeys: [{ name: "Wave", type: "t", hotkeyID: "hk-wave" }] });
      return reply(`${m.messageType.replace(/Request$/, "")}Response`, m.messageType === "AuthenticationRequest" ? { authenticated: true } : { authenticationToken: "t" });
    });
  });
  const d = vts(s.port);
  await d.connect(ctx({ gestures: { wave: "Wave" } }));
  logs.warn.length = 0;
  const realNow = Date.now.bind(Date);
  let calls = 0;
  const stepped = mock.method(Date, "now", () => realNow() + (calls++ % 2) * 25_000); // a clock flapping by 25 s
  try {
    d.trigger("wave");
    d.trigger("wave");
    await waitFor(() => s.wss.clients.size > 0 && logs.warn.length >= 1, "a failure logged");
    await new Promise((r) => setTimeout(r, 100));
  } finally { stepped.mock.restore(); }
  assert.equal(logs.warn.length, 1, "the second failure inside 5 s is not logged");
  await d.disconnect();
});
