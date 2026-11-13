import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { FakeBus, event, waitFor } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { boot, connectorOffer, fakeStt, frame, resetSeq, sleep, SPEECH } from "./rig.js";

// The echo gate (EARS-ECHO-*): a source named in ears.echo_suppress_sources is deaf while the co-host's own line plays (plus a tail).
// Real ears service on a fake bus; voice.playing / voice.done are delivered to the handler the service subscribed. The gate is read
// on ears' own clock, `Date.now`, which these tests step with an offset (a gate that only ran on timers would not see it).

type Sub = { opts: { group: string; types: readonly string[]; start?: string }; handler: (ev: never) => Promise<void> };
const tags = (...names: string[]) => (b: Parameters<NonNullable<Parameters<typeof boot>[1]>["setup"] & {}>[0]) => { for (const n of names) b.register(n, connectorOffer.map((c) => ({ ...c, tag: n }))); };
const cfg = (over: Record<string, unknown> = {}) => ({
  sources: ["desktop"], echo_suppress_sources: ["desktop"], echo_tail_ms: 300, stt_engine: "speaches", partials: "off", stt_gpu: true,
  silence_ms: 120, min_speech_ms: 100, vad: { engine: "gap" }, ...over,
});
const playing = (id: string, sink = "discord") => event("voice.playing", { id, sink });
const done = (id: string, extra: Record<string, unknown> = {}) => event("voice.done", { id, sink: "discord", ...extra } as never);

async function run<T>(ears: Record<string, unknown>, body: (t: ReturnType<typeof tools>) => Promise<T>, setup = tags("desktop")): Promise<T> {
  resetSeq();
  const real = Date.now.bind(Date);
  let offset = 0;
  const clock = mock.method(Date, "now", () => real() + offset);
  const subs: Sub[] = [];
  const stt = fakeStt(() => "hello there");
  const r = await boot(ears, { setup: (bus) => { setup(bus); (bus as unknown as { subscribe: unknown }).subscribe = (opts: Sub["opts"], handler: Sub["handler"]) => { subs.push({ opts, handler }); return new Promise<void>(() => {}); }; } });
  try { await sleep(60); return await body(tools(r, subs, stt, (ms) => { offset += ms; })); } finally { await r.stop(); stt.restore(); clock.mock.restore(); }
}
const tools = (r: Awaited<ReturnType<typeof boot>>, subs: Sub[], stt: ReturnType<typeof fakeStt>, jump: (ms: number) => void) => ({
  r, subs, stt, jump,
  deliver: async (ev: unknown) => { for (const s of subs) if (s.opts.types.includes((ev as { type: string }).type)) await s.handler(ev as never); },
  /** 200 ms of speech from one speaker of `tag`, then silence_ms closes it. */
  say: async (tag = "desktop", spk = "u1") => { for (let i = 0; i < 10; i++) { r.bus.feed("in", tag, frame(spk, SPEECH)); await sleep(12); } },
});
const settle = (ms = 400) => sleep(ms);

// @spec EARS-ECHO-001, EARS-ECHO-009
test("the ears group also reads voice.playing and voice.done where an enabled source is gated; otherwise inject.request only", async () => {
  await run(cfg(), async (t) => {
    assert.equal(t.subs.length, 1, "one loop");
    assert.equal(t.subs[0]!.opts.group, "ears");
    assert.equal(t.subs[0]!.opts.start, "latest");
    assert.deepEqual([...t.subs[0]!.opts.types].sort(), ["inject.request", "voice.done", "voice.playing"]);
  });
  await run(cfg({ sources: ["discord"] }), async (t) => { // desktop is named but not enabled
    assert.deepEqual(t.subs.map((s) => [...s.opts.types]), [["inject.request"]]);
  }, tags("discord"));
  await run(cfg({ echo_suppress_sources: [] }), async (t) => { // ECHO-009: nothing gated, no voice.* event
    assert.deepEqual(t.subs.map((s) => [...s.opts.types]), [["inject.request"]]);
  });
});

// @spec EARS-ECHO-002, EARS-ECHO-004
test("while a non-virtual line is playing a gated source's utterance is dropped before any STT request and publishes nothing", async () => {
  await run(cfg(), async (t) => {
    await t.deliver(playing("u1"));
    await t.say();
    await settle();
    assert.equal(t.stt.calls.length, 0, "no speech-to-text request");
    assert.equal(t.r.heard().length, 0);
  });
});

// @spec EARS-ECHO-002
test("a virtual voice.playing opens no gate", async () => {
  await run(cfg(), async (t) => {
    await t.deliver(playing("u1", "virtual"));
    await t.say();
    await waitFor(() => t.r.heard().length === 1, "heard");
  });
});

// @spec EARS-ECHO-002, EARS-ECHO-004
test("a voice.done removes the line (interrupted or not, from any sink); the gate then stays open for echo_tail_ms and closes after", async () => {
  for (const extra of [{}, { interrupted: true }]) {
    await run(cfg(), async (t) => {
      await t.deliver(playing("u1"));
      await t.deliver(done("u1", { sink: "dryrun", ...extra }));
      await t.say(); // inside the 300 ms tail
      await settle(300);
      assert.equal(t.r.heard().length, 0, `tail: ${JSON.stringify(extra)}`);
      t.jump(1000); // the tail is over on ears' clock
      await t.say();
      await waitFor(() => t.r.heard().length === 1, "heard after the tail");
    });
  }
});

// @spec EARS-ECHO-004
test("an utterance whose audio ended before the window opened is kept although it closes inside it", async () => {
  await run(cfg(), async (t) => {
    await t.say();
    await t.deliver(playing("u1")); // opened after the last frame, before silence_ms closed the utterance
    await waitFor(() => t.r.heard().length === 1, "heard: its audio ended before the gate opened");
  });
});

// @spec EARS-ECHO-004
test("an utterance whose audio ended inside the window is dropped although the gate closed before it was transcribed", async () => {
  await run(cfg({ echo_tail_ms: 0 }), async (t) => {
    await t.deliver(playing("u1"));
    await t.say();
    await t.deliver(done("u1")); // closed again before silence_ms ended the utterance
    await settle();
    assert.equal(t.r.heard().length, 0);
    assert.equal(t.stt.calls.length, 0);
  });
});

// @spec EARS-ECHO-003
test("a line with no voice.done 60000 ms after its voice.playing is removed as if its done had been read", async () => {
  await run(cfg({ echo_tail_ms: 0 }), async (t) => {
    await t.deliver(playing("u1"));
    t.jump(59_000);
    await t.say();
    await settle();
    assert.equal(t.r.heard().length, 0, "still playing at 59 s");
    t.jump(2_000);
    await t.say();
    await waitFor(() => t.r.heard().length === 1, "heard once the 60 s ceiling passed");
  });
});

// @spec EARS-ECHO-005
test("while the gate is open a gated source publishes no speech.partial", async () => {
  await run(cfg({ partials: "on", partial_step_ms: 30 }), async (t) => {
    await t.deliver(playing("u1"));
    await t.say();
    await settle();
    assert.equal(t.r.partials().length, 0);
    assert.equal(t.stt.calls.length, 0);
  });
});

// @spec EARS-ECHO-006
test("a voice.playing read during the tail keeps the gate open from then on: a tail overlapping the next line extends the window", async () => {
  await run(cfg(), async (t) => {
    await t.deliver(playing("a"));
    await t.deliver(done("a"));
    t.jump(250); // inside the tail
    await t.deliver(playing("b"));
    t.jump(5_000); // far past the first tail; b is still playing
    await t.say();
    await settle();
    assert.equal(t.r.heard().length, 0, "b's playing holds the gate");
    await t.deliver(done("b"));
    t.jump(1_000);
    await t.say();
    await waitFor(() => t.r.heard().length === 1, "heard after b's tail");
  });
});

// @spec EARS-ECHO-007
test("a freshly started ears has the gate closed", async () => {
  await run(cfg(), async (t) => {
    await t.say();
    await waitFor(() => t.r.heard().length === 1, "heard with no voice event read");
  });
});

// @spec EARS-ECHO-008
test("only gated sources are gated: another source and an injected clip are heard while a line plays", async () => {
  await run(cfg({ sources: ["desktop", "discord"] }), async (t) => {
    (t.r.bus as unknown as FakeBus).takeUpload = async () => wavWrap(Buffer.alloc(32000, 1), 16000, 1);
    await t.deliver(playing("u1"));
    await t.say("discord", "d1");
    await waitFor(() => t.r.heard().length === 1, "discord heard");
    assert.equal(t.r.heard()[0]!.source, "discord");
    await t.deliver(event("inject.request", { id: "i1", target: "ears", kind: "audio", uploadId: "0123456789abcdef0123456789abcdef", contentType: "audio/wav", remember: false }));
    await waitFor(() => t.r.heard().length === 2, "injected heard");
    await t.say("desktop");
    await settle();
    assert.equal(t.r.heard().length, 2, "desktop stays gated");
  }, tags("desktop", "discord"));
});

// @spec EARS-ECHO-009
test("echo_tail_ms 0 closes the gate at the moment the last line is removed", async () => {
  await run(cfg({ echo_tail_ms: 0 }), async (t) => {
    await t.deliver(playing("u1"));
    await t.deliver(done("u1"));
    await t.say();
    await waitFor(() => t.r.heard().length === 1, "heard at once");
  });
});
