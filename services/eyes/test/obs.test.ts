import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { recordingLog, runHeartbeat, waitFor } from "@cohost/testing";
import { EyesHealth } from "../src/health.js";
import { createObsLink, stopEyes, type ObsLike } from "../src/obs.js";
import { subscribeInject } from "@cohost/shared";

/** An obs-websocket stand-in: `connect` fails the first `failures` times, then identifies. */
class FakeObs extends EventEmitter implements ObsLike {
  identified = false;
  connects = 0;
  disconnects = 0;
  constructor(public failures = 0) { super(); }
  async connect(): Promise<{ obsWebSocketVersion: string }> {
    this.connects++;
    if (this.connects <= this.failures) {
      this.emit("ConnectionClosed", new Error("refused")); // obs-websocket-js emits this on a failed connect too
      throw new Error("refused");
    }
    this.identified = true;
    return { obsWebSocketVersion: "5.1.0" };
  }
  async disconnect(): Promise<void> { this.disconnects++; this.identified = false; this.emit("ConnectionClosed", new Error("bye")); }
  drop(): void { this.identified = false; this.emit("ConnectionClosed", new Error("closed")); }
}
const hbSpy = () => {
  const calls: string[] = [];
  return { calls, ready: () => calls.push("ready"), degraded: (d?: string) => calls.push(`degraded:${d}`) };
};
const link = (obs: FakeObs, hb = hbSpy(), sleeps: number[] = []) =>
  createObsLink({ obs, url: "ws://h:1", log: recordingLog().log, heartbeat: hb, sleep: async (ms) => { sleeps.push(ms); } });

// @spec EYES-OBS-002, EYES-OBS-003
test("connect retries with a delay that starts at 10 s and doubles until OBS answers, then signals ready", async () => {
  const obs = new FakeObs(2);
  const hb = hbSpy();
  const sleeps: number[] = [];
  await link(obs, hb, sleeps).connect();
  assert.equal(obs.connects, 3);
  assert.deepEqual(sleeps, [10_000, 20_000]);
  assert.equal(hb.calls.at(-1), "ready");
});

// @spec EYES-HEALTH-006
test("while OBS has not been reachable the heartbeat is degraded with obs down, then ready on connect", async () => {
  const obs = new FakeObs(1);
  const health = new EyesHealth(true, () => obs.identified);
  const hbs = await runHeartbeat(health.spec, async (hb) => {
    await createObsLink({
      obs, url: "ws://h:1", log: recordingLog().log, heartbeat: hb,
      sleep: () => new Promise((r) => setTimeout(r, 30)),
    }).connect();
  });
  const states = hbs.map((h) => h.state);
  const d = hbs.find((h) => h.state === "degraded")!;
  assert.deepEqual(d.deps, { obs: "down", ollama: "ok" });
  assert.match(d.detail ?? "", /OBS/);
  assert.ok(states.indexOf("degraded") < states.indexOf("ready"), `degraded before ready: ${states}`);
});

// @spec EYES-OBS-004
test("a close after connecting, clean or not, reconnects and signals ready again", async () => {
  const obs = new FakeObs();
  const hb = hbSpy();
  await link(obs, hb).connect();
  obs.drop();
  await waitFor(() => obs.connects === 2, "reconnect");
  await waitFor(() => hb.calls.filter((c) => c === "ready").length === 2, "ready again");
  assert.equal(obs.identified, true);
});

// @spec EYES-OBS-004
test("closes emitted by a connect attempt do not start a second connect loop", async () => {
  const obs = new FakeObs(3);
  const l = link(obs);
  await Promise.all([l.connect(), l.connect()]);
  assert.equal(obs.connects, 4, "one loop: 3 failures then success");
});

// @spec EYES-OBS-008
test("stop disconnects and the resulting close does not reconnect", async () => {
  const obs = new FakeObs();
  const l = link(obs);
  await l.connect();
  await l.stop();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(obs.disconnects, 1);
  assert.equal(obs.connects, 1);
});

// @spec EYES-ENAB-005, EYES-OBS-008
test("one shutdown sequence: idle timer, OBS, then the bus", async () => {
  const order: string[] = [];
  await stopEyes({
    idleTimer: setInterval(() => {}, 1000),
    clear: (t) => { order.push("timer"); clearInterval(t); },
    link: { stop: async () => { order.push("obs"); } },
    bus: { stop: () => { order.push("bus"); } },
  });
  assert.deepEqual(order, ["timer", "obs", "bus"]);
  order.length = 0;
  await stopEyes({ link: { stop: async () => { order.push("obs"); } }, bus: { stop: () => { order.push("bus"); } } });
  assert.deepEqual(order, ["obs", "bus"], "no idle timer when vision is enabled");
});

// @spec EYES-INJ-014
test("the inject subscription is created first, then subscribed with start mode latest", async () => {
  const calls: string[] = [];
  let opts: unknown;
  const bus = {
    resetGroup: async (g: string) => { calls.push(`reset:${g}`); },
    subscribe: async (o: unknown) => { calls.push("subscribe"); opts = o; },
  };
  await subscribeInject({ bus: bus as never, group: "eyes", handler: async () => {}, log: recordingLog().log });
  assert.deepEqual(calls, ["reset:eyes", "subscribe"]);
  assert.deepEqual(opts, { group: "eyes", types: ["inject.request"], start: "latest" });
});
