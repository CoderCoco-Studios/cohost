import { test } from "node:test";
import assert from "node:assert/strict";
import { controlFor } from "@cohost/shared";
import { event, recordingLog } from "@cohost/testing";
import { Routing, setRoutingHandler } from "../src/routing.js";
import { createMouthHandler, type MouthOutput } from "../src/session.js";

const running = () => new Routing({ discord: { gain_db: 0 }, dryrun: {} });

const setRouting = (routing: unknown, target: string | undefined = "mouth") =>
  event("control", { cmd: "set_routing", ...(target ? { target } : {}), routing } as never);

// @spec MOUTH-LIVE-002
test("a routing patch sets the live enabled flag and the discord gain; outputs not named keep their state", () => {
  const r = running();
  assert.equal(r.isEnabled("discord"), true);
  assert.equal(r.gainDb("discord"), 0);
  assert.deepEqual(r.apply({ discord: { enabled: false, gain_db: -6 } }), { ok: true });
  assert.equal(r.isEnabled("discord"), false);
  assert.equal(r.gainDb("discord"), -6);
  assert.equal(r.isEnabled("dryrun"), true, "not named: unchanged");
  assert.deepEqual(r.apply({ discord: { enabled: true } }), { ok: true });
  assert.equal(r.isEnabled("discord"), true);
  assert.equal(r.gainDb("discord"), -6, "an entry without gain_db leaves the gain");
});

// @spec MOUTH-LIVE-002
test("the live gain starts at the configured gain and an output that was not started has no live state", () => {
  const r = new Routing({ discord: { gain_db: 3 } });
  assert.equal(r.gainDb("discord"), 3);
  assert.equal(r.isEnabled("dryrun"), false, "not running: never enabled");
});

// @spec MOUTH-LIVE-003
test("a patch is rejected, changing nothing, for each of: no entries, unknown id, not running, gain on an output without one, gain out of range", () => {
  const cases: [unknown, RegExp][] = [
    [undefined, /no routing entries/],
    [{}, /no routing entries/],
    [{ discrod: { enabled: false } }, /unknown output id "discrod"/],
    [{ file: { enabled: true } }, /output "file" is not running/],
    [{ dryrun: { gain_db: 3 } }, /output "dryrun" has no gain_db/],
    [{ discord: { gain_db: 13 } }, /gain_db out of range/],
    [{ discord: { gain_db: -41 } }, /gain_db out of range/],
    [{ discord: { gain_db: Number.NaN } }, /gain_db out of range/],
  ];
  for (const [patch, why] of cases) {
    const r = running();
    // A valid entry beside the bad one must not be applied either: the event is all or nothing.
    const withValid = patch && typeof patch === "object" && Object.keys(patch).length > 0 ? { dryrun: { enabled: false }, ...patch } : patch;
    const res = r.apply(withValid);
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.match((res as { reason: string }).reason, why);
    assert.equal(r.isEnabled("dryrun"), true, `unchanged after ${JSON.stringify(patch)}`);
    assert.equal(r.gainDb("discord"), 0);
  }
});

// @spec MOUTH-LIVE-006
test("the detail is `routing` plus config-shaped JSON in the order discord, dryrun, file, http; a rejection prefixes its reason", () => {
  const r = new Routing({ http: {}, dryrun: {}, discord: { gain_db: 0 } });
  assert.equal(r.detail(), 'routing {"discord":{"enabled":true,"gain_db":0},"dryrun":{"enabled":true},"http":{"enabled":true}}');
  r.apply({ dryrun: { enabled: false }, discord: { gain_db: -3.5 } });
  assert.equal(r.detail(), 'routing {"discord":{"enabled":true,"gain_db":-3.5},"dryrun":{"enabled":false},"http":{"enabled":true}}');
  assert.equal(r.detail("unknown output id \"x\""), 'set_routing rejected: unknown output id "x"; routing {"discord":{"enabled":true,"gain_db":-3.5},"dryrun":{"enabled":false},"http":{"enabled":true}}');
});

// @spec MOUTH-LIVE-001, MOUTH-LIVE-006
test("the control reader hands set_routing to the handler, which applies it and reports the outcome as the heartbeat detail", async () => {
  const r = running();
  const details: (string | undefined)[] = [];
  const rec = recordingLog();
  const reader = controlFor("mouth", { set_routing: setRoutingHandler(r, { heartbeat: { setDetail: (d) => { details.push(d); } }, log: rec.log }) });
  await reader.handleAsync(setRouting({ dryrun: { enabled: false } }));
  assert.equal(r.isEnabled("dryrun"), false);
  assert.deepEqual(details, ['routing {"discord":{"enabled":true,"gain_db":0},"dryrun":{"enabled":false}}']);
  await reader.handleAsync(setRouting({ file: { enabled: true } }, undefined)); // no target: addressed to every service
  assert.match(details.at(-1)!, /^set_routing rejected: output "file" is not running; routing /);
  assert.ok(rec.msgs("warn").includes("set_routing rejected"));
  await reader.handleAsync(setRouting({ dryrun: { enabled: true } }, "cortex")); // another service's
  assert.equal(r.isEnabled("dryrun"), false, "addressed to cortex: not applied");
  assert.equal(details.length, 2);
});

// @spec MOUTH-LIVE-001
test("mute and pause change nothing in mouth: it still queues every utterance", async () => {
  const r = running();
  const queued: string[] = [];
  const out: MouthOutput = { name: "discord", isReady: () => true, playback: { enqueue: async (id) => { queued.push(id); } } };
  const reader = controlFor("mouth", { set_routing: setRoutingHandler(r, { heartbeat: { setDetail() {} }, log: recordingLog().log }) });
  const h = createMouthHandler({ outputs: [out], log: recordingLog().log, enabled: (n) => r.isEnabled(n), control: reader });
  await h(event("control", { cmd: "mute" }));
  await h(event("control", { cmd: "pause" }));
  await h(event("voice.utterance", { id: "u1", text: "hi", emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: "http://voice/u1.wav", sampleRate: 24000 }));
  assert.deepEqual(queued, ["u1"]);
});

// @spec MOUTH-LIVE-002
test("an output switched off live skips later utterances without queueing, claiming or failing; switched on it queues again", async () => {
  const r = running();
  const queued: string[] = [];
  const mk = (name: string): MouthOutput => ({ name, isReady: () => true, playback: { enqueue: async (id) => { queued.push(`${name}:${id}`); } } });
  const reader = controlFor("mouth", { set_routing: setRoutingHandler(r, { heartbeat: { setDetail() {} }, log: recordingLog().log }) });
  const h = createMouthHandler({ outputs: [mk("discord"), mk("dryrun")], log: recordingLog().log, enabled: (n) => r.isEnabled(n), control: reader });
  const utt = (id: string) => event("voice.utterance", { id, text: "hi", emotion: "neutral", durationMs: 100, envelopeHz: 50, envelope: [0], audioUrl: `http://voice/${id}.wav`, sampleRate: 24000 });
  await h(utt("a"));
  await h(setRouting({ discord: { enabled: false } }));
  await h(utt("b"));
  await h(setRouting({ discord: { enabled: true } }));
  await h(utt("c"));
  assert.deepEqual(queued, ["discord:a", "dryrun:a", "dryrun:b", "discord:c", "dryrun:c"]);
});

// @spec MOUTH-LIVE-005
test("the live routing is memory only: a new Routing from the same running set starts at the configured state", () => {
  const first = running();
  first.apply({ discord: { enabled: false, gain_db: -9 } });
  const afterRestart = running();
  assert.equal(afterRestart.isEnabled("discord"), true);
  assert.equal(afterRestart.gainDb("discord"), 0);
});
