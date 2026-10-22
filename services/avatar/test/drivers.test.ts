import { test, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { createDriver } from "../src/drivers/index.js";
import { NullDriver } from "../src/drivers/null.js";
import { VmcDriver } from "../src/drivers/vmc.js";
import { VTubeStudioDriver } from "../src/drivers/vtube-studio.js";
import { NEUTRAL, type DriverContext } from "../src/types.js";

const warnings: unknown[] = [];
const log = { warn: (o: unknown) => warnings.push(o), info() {}, error() {}, debug() {} } as never;
const ctx = (over: Partial<DriverContext> = {}): DriverContext => ({
  log, stateDir: mkdtempSync(join(tmpdir(), "cohost-avatar-")),
  expressions: { happy: "Smile", sad: "Sad", smug: "smug.exp3.json" },
  gestures: { wave: "WAVE" },
  ...over,
});
async function waitFor(cond: () => boolean, what: string, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("createDriver picks the driver named in config", () => {
  const cfg = (driver: string) => ({ driver, vtube_studio: { host: "h", port: 1, plugin_name: "p", plugin_developer: "d" }, vmc: { host: "h", port: 2 } }) as never;
  assert.ok(createDriver(cfg("vtube-studio")) instanceof VTubeStudioDriver);
  assert.ok(createDriver(cfg("vmc")) instanceof VmcDriver);
  assert.ok(createDriver(cfg("null")) instanceof NullDriver);
});

test("null driver: always connected, accepts everything", async () => {
  const d = new NullDriver();
  await d.connect(ctx());
  assert.equal(d.connected(), true);
  d.setParams(NEUTRAL); d.setExpression("happy", 1); d.trigger("wave");
  assert.deepEqual([...d.capabilities()].sort(), ["expressions", "gestures", "lipsync", "params"]);
});

// ---- VMC (OSC over UDP)

/** Decode one OSC message: address, type tags, and args (s / i / f). */
function decodeOsc(b: Buffer): { address: string; args: (string | number)[] } {
  let off = 0;
  const str = () => { const end = b.indexOf(0, off); const s = b.toString("utf8", off, end); off = (end + 4) & ~3; return s; };
  const address = str();
  const tags = str().slice(1);
  const args: (string | number)[] = [];
  for (const t of tags) {
    if (t === "s") args.push(str());
    else if (t === "i") { args.push(b.readInt32BE(off)); off += 4; }
    else { args.push(Math.round(b.readFloatBE(off) * 1e4) / 1e4); off += 4; }
  }
  assert.equal(off, b.length, "message is 4-byte aligned with nothing left over");
  return { address, args };
}

test("vmc: each frame sends head pose, mouth/blink for VRM 0.x and 1.0, then Apply + OK", async () => {
  const sock = dgram.createSocket("udp4");
  const got: { address: string; args: (string | number)[] }[] = [];
  sock.on("message", (m) => got.push(decodeOsc(m)));
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  after(() => sock.close());

  const d = new VmcDriver({ host: "127.0.0.1", port: sock.address().port });
  assert.equal(d.connected(), false);
  d.setParams(NEUTRAL); // not connected: no-op
  await d.connect(ctx());
  assert.equal(d.connected(), true);

  d.setParams({ ...NEUTRAL, mouthOpen: 0.5, blink: 1, headX: 90 });
  await waitFor(() => got.length >= 7, "7 OSC messages");
  assert.deepEqual(got.map((m) => m.address), [
    "/VMC/Ext/Bone/Pos", "/VMC/Ext/Blend/Val", "/VMC/Ext/Blend/Val", "/VMC/Ext/Blend/Val", "/VMC/Ext/Blend/Val", "/VMC/Ext/Blend/Apply", "/VMC/Ext/OK",
  ]);
  // yaw 90° → quaternion (0, sin 45°, 0, cos 45°)
  assert.deepEqual(got[0]!.args, ["Head", 0, 0, 0, 0, 0.7071, 0, 0.7071]);
  assert.deepEqual(got.slice(1, 5).map((m) => m.args), [["A", 0.5], ["aa", 0.5], ["Blink", 1], ["blink", 1]]);
  assert.deepEqual(got[6]!.args, [1]); // OK is the one int32

  // An expression rides along on every frame; switching zeroes the old blendshape first.
  got.length = 0;
  d.setExpression("happy", 2);
  d.setParams(NEUTRAL);
  await waitFor(() => got.length >= 8, "frame with expression");
  assert.deepEqual(got.find((m) => m.args[0] === "Smile")?.args, ["Smile", 1]); // intensity clamped
  got.length = 0;
  d.setExpression("sad", 0.5);
  await waitFor(() => got.length >= 1, "reset of old expression");
  assert.deepEqual(got[0]!.args, ["Smile", 0]);
  await d.disconnect();
  assert.equal(d.connected(), false);
});

// ---- VTube Studio (WebSocket API)

type Req = { requestID: string; messageType: string; data: Record<string, unknown> };
async function vtsServer(opts: { authenticated?: boolean; apiErrorOn?: string } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const reqs: Req[] = [];
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Req;
      reqs.push(m);
      const reply = (messageType: string, data: unknown) =>
        ws.send(JSON.stringify({ apiName: "VTubeStudioPublicAPI", requestID: m.requestID, messageType, data }));
      if (m.messageType === opts.apiErrorOn) return reply("APIError", { errorID: 8, message: "nope" });
      switch (m.messageType) {
        case "AuthenticationTokenRequest": return reply("AuthenticationTokenResponse", { authenticationToken: "fresh-token" });
        case "AuthenticationRequest": return reply("AuthenticationResponse", { authenticated: opts.authenticated ?? true, reason: "revoked" });
        case "HotkeysInCurrentModelRequest":
          return reply("HotkeysInCurrentModelResponse", { availableHotkeys: [
            { name: "Smile", type: "ToggleExpression", hotkeyID: "hk-smile" },
            { name: "Sad", type: "ToggleExpression", hotkeyID: "hk-sad" },
            { name: "Wave", type: "TriggerAnimation", hotkeyID: "hk-wave" },
          ] });
        default: return reply(`${m.messageType.replace(/Request$/, "")}Response`, {});
      }
    });
  });
  await new Promise<void>((r) => wss.once("listening", r));
  after(() => { for (const c of wss.clients) c.terminate(); wss.close(); });
  const port = (wss.address() as { port: number }).port;
  return { wss, reqs, port, types: () => reqs.map((r) => r.messageType) };
}
const vts = (port: number) => new VTubeStudioDriver({ host: "127.0.0.1", port, pluginName: "cohost", pluginDeveloper: "dev" });

test("vts: first connect asks for a plugin token and saves it; the next connect reuses it", async () => {
  const s = await vtsServer();
  const c = ctx();
  const d = vts(s.port);
  await d.connect(c);
  assert.equal(d.connected(), true);
  assert.deepEqual(s.types(), ["AuthenticationTokenRequest", "AuthenticationRequest", "HotkeysInCurrentModelRequest"]);
  assert.deepEqual(s.reqs[0]!.data, { pluginName: "cohost", pluginDeveloper: "dev" });
  assert.equal(s.reqs[1]!.data.authenticationToken, "fresh-token");
  assert.equal(readFileSync(join(c.stateDir, ".vts-token"), "utf8"), "fresh-token");
  await d.disconnect();
  assert.equal(d.connected(), false);

  s.reqs.length = 0;
  const again = vts(s.port);
  await again.connect(c);
  assert.deepEqual(s.types(), ["AuthenticationRequest", "HotkeysInCurrentModelRequest"]);
  await again.disconnect();
});

test("vts: a rejected token is wiped so the next run asks again", async () => {
  const s = await vtsServer({ authenticated: false });
  const c = ctx();
  writeFileSync(join(c.stateDir, ".vts-token"), "stale");
  const d = vts(s.port);
  await d.connect(c);
  assert.equal(d.connected(), false);
  assert.equal(readFileSync(join(c.stateDir, ".vts-token"), "utf8"), "");
  await d.disconnect(); // also cancels the scheduled reconnect
});

test("vts: an APIError reply fails the request (and so the auth)", async () => {
  const s = await vtsServer({ apiErrorOn: "HotkeysInCurrentModelRequest" });
  const d = vts(s.port);
  await d.connect(ctx());
  assert.equal(d.connected(), false);
  await d.disconnect();
});

test("vts: an unreachable app doesn't block startup", async () => {
  const d = vts(1);
  await d.connect(ctx());
  assert.equal(d.connected(), false);
  await d.disconnect();
});

test("vts: params are injected every frame, clamped to the VTS ranges", async () => {
  const s = await vtsServer();
  const d = vts(s.port);
  await d.connect(ctx());
  d.setParams({ ...NEUTRAL, mouthOpen: 2, headX: -90, eyeX: 0.5, blink: 1 });
  await waitFor(() => s.types().includes("InjectParameterDataRequest"), "inject");
  const values = Object.fromEntries((s.reqs.at(-1)!.data.parameterValues as { id: string; value: number }[]).map((p) => [p.id, p.value]));
  assert.equal(values.MouthOpen, 1);
  assert.equal(values.FaceAngleX, -30);
  assert.equal(values.EyeLeftX, 0.5);
  assert.equal(values.EyeRightX, 0.5);
  assert.equal(values.EyeOpenLeft, 0);
  assert.equal(s.reqs.at(-1)!.data.faceFound, true);
  await d.disconnect();
});

test("vts: hotkey expressions toggle off the old one and on the new one; .exp3.json files are (de)activated", async () => {
  const s = await vtsServer();
  const d = vts(s.port);
  await d.connect(ctx());
  s.reqs.length = 0;
  const sent = () => s.reqs.map((r) => r.data.hotkeyID ?? `${r.data.expressionFile}:${r.data.active}`);

  d.setExpression("happy", 1);
  d.setExpression("happy", 0.8); // already active: nothing to do
  await waitFor(() => s.reqs.length >= 1, "smile on");
  d.setExpression("sad", 1);
  await waitFor(() => s.reqs.length >= 3, "smile off, sad on");
  d.setExpression("smug", 1);
  await waitFor(() => s.reqs.length >= 5, "sad off, smug on");
  d.setExpression("smug", 0); // ~zero intensity clears it
  await waitFor(() => s.reqs.length >= 6, "smug off");
  assert.deepEqual(sent(), ["hk-smile", "hk-smile", "hk-sad", "hk-sad", "smug.exp3.json:true", "smug.exp3.json:false"]);
  await d.disconnect();
});

test("vts: gestures map through expressions.yaml, case-insensitively; unknown ones warn or no-op", async () => {
  const s = await vtsServer();
  const d = vts(s.port);
  await d.connect(ctx({ gestures: { wave: "WAVE", dance: "Dance" } }));
  s.reqs.length = 0;
  warnings.length = 0;
  d.trigger("wave");
  d.trigger("nod"); // not mapped: silently ignored
  d.trigger("dance"); // mapped, but the model has no such hotkey
  await waitFor(() => s.reqs.length >= 1, "wave");
  assert.deepEqual(s.reqs.map((r) => r.data.hotkeyID), ["hk-wave"]);
  assert.deepEqual(warnings, [{ gesture: "dance", name: "Dance" }]);
  await d.disconnect();
});

test("vts: nothing is sent before authentication completes", () => {
  const d = vts(1);
  d.setParams(NEUTRAL); d.setExpression("happy", 1); d.trigger("wave"); // must not throw
  assert.equal(d.connected(), false);
});
