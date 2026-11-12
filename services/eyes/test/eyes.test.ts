import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { Eyes, createDescriber, isSame, modelDescriber, startEyes, stripDataUrl, stubDescriber } from "../src/eyes.js";

function setup(replies: string[]) {
  const bus = new FakeBus();
  const previous: string[] = [];
  const eyes = new Eyes({
    bus, log: silentLog,
    screenshot: async () => "BASE64",
    describe: async (b64, prev) => { assert.equal(b64, "BASE64"); previous.push(prev); return replies.shift() ?? ""; },
  });
  return { eyes, bus, previous };
}

// @spec EYES-LOOK-001
test("a new description is published and becomes the 'previous' for the next look", async () => {
  const { eyes, bus, previous } = setup(["The player enters a cave.", "A bat swoops down."]);
  assert.equal(await eyes.look(), true);
  assert.equal(await eyes.look(), true);
  assert.deepEqual(bus.of("vision.summary"), [
    { text: "The player enters a cave.", changed: true },
    { text: "A bat swoops down.", changed: true },
  ]);
  assert.deepEqual(previous, ["", "The player enters a cave."]);
});

// @spec EYES-LOOK-002
test("a clear SAME (any case, trailing punctuation) or an empty reply publishes nothing; a reply that only starts with the word is a description", async () => {
  const { eyes, bus, previous } = setup(["In the menu.", "SAME", "same.", "Same!", " same \n", "", "Same old menu screen.", "Samurai attack!"]);
  for (let i = 0; i < 8; i++) await eyes.look();
  assert.deepEqual(bus.of("vision.summary").map((v) => v.text), ["In the menu.", "Same old menu screen.", "Samurai attack!"]);
  assert.deepEqual(previous.slice(1, 6), ["In the menu.", "In the menu.", "In the menu.", "In the menu.", "In the menu."]);
  assert.deepEqual(["SAME", "Same.", "same!", "", "  "].map(isSame), [true, true, true, true, true]);
  assert.deepEqual(["Same as before", "Same old menu", "Samurai", "The same boss"].map(isSame), [false, false, false, false]);
});

// @spec EYES-LOOK-001, EYES-LOOK-003
test("a look measures its duration on the injected monotonic clock", async () => {
  const bus = new FakeBus();
  const lines: { obj: unknown; msg?: string }[] = [];
  const log = { debug: (obj: unknown, msg?: string) => lines.push({ obj, msg }), info: (obj: unknown, msg?: string) => lines.push({ obj, msg }), warn() {}, error() {} } as never;
  const ticks = [1000, 1250, 5000, 5040];
  const eyes = new Eyes({ bus, log, screenshot: async () => "B", describe: async (_b, prev) => (prev ? "SAME" : "A cave."), now: () => ticks.shift()! });
  await eyes.look();
  await eyes.look();
  assert.deepEqual(lines.map((l) => (l.obj as { ms: number }).ms), [250, 40]);
});

// @spec EYES-OBS-007
test("stripDataUrl removes the data: prefix obs-websocket adds", () => {
  assert.equal(stripDataUrl("data:image/jpg;base64,AAAA"), "AAAA");
  assert.equal(stripDataUrl("data:image/png;base64,BBBB"), "BBBB");
  assert.equal(stripDataUrl("CCCC"), "CCCC");
});

// @spec EYES-DESC-001, EYES-DESC-002, EYES-DESC-003, EYES-DESC-004, EYES-DESC-005
test("the describer asks the llm package's ollama provider with the frame, previous line and vision options, and keeps only the first line", async () => {
  let body: { model: string; stream: boolean; options: { temperature: number; num_predict: number }; messages: { role: string; content: string; images?: string[] }[] } | undefined;
  let status = 200;
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.statusCode = status;
    res.end(JSON.stringify({ message: { content: "  A boss appears.\nIt looks angry.  " } }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => server.close());
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cfg = testConfig({ vision: { model: "llava", temperature: 0.5, num_predict: 30 } });
  const describe = modelDescriber(cfg.vision, cfg.llm);

  assert.equal(await describe("IMG", ""), "A boss appears.");
  assert.equal(body!.model, "llava", "vision.model, not llm.model");
  assert.equal(body!.stream, false);
  assert.equal(body!.options.temperature, 0.5);
  assert.equal(body!.options.num_predict, 30);
  assert.equal(body!.messages[0]!.role, "system");
  assert.equal(body!.messages[0]!.content, cfg.vision.prompt);
  assert.match(body!.messages[0]!.content, /exactly: SAME/);
  assert.deepEqual(body!.messages[1], { role: "user", content: "What is happening now?", images: ["IMG"] });
  await describe("IMG", "In a cave.");
  assert.equal(body!.messages[1]!.content, "Previous description: In a cave.\nWhat is happening now?");
  status = 500;
  await assert.rejects(describe("IMG", ""), /ollama chat 500/);
});

// @spec EYES-DESC-005, EYES-DESC-007
test("a configured vision.prompt replaces the default system message", async () => {
  const seen: { role: string; content: string }[][] = [];
  const cfg = testConfig({ vision: { model: "v", prompt: "Describe it. Reply SAME if unchanged." } });
  const provider = { name: "ollama", model: "v", ping: async () => true, chat: async (m: { role: string; content: string }[]) => { seen.push(m); return "x"; } };
  await modelDescriber(cfg.vision, cfg.llm, provider as never)("IMG", "");
  assert.equal(seen[0]![0]!.content, "Describe it. Reply SAME if unchanged.");
});

// @spec EYES-STUB-001
test("the stub describer makes no request: injected bytes are counted, the look loop gets the text once and SAME after", async () => {
  const describe = stubDescriber();
  const b64 = Buffer.from("12345").toString("base64");
  assert.equal(await describe(b64, ""), "stub vision: 5 bytes");
  assert.equal(await describe(b64, "stub vision: 5 bytes"), "SAME");
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = "http://127.0.0.1:1";
  try {
    const cfg = testConfig({ vision: { model: "v", engine: "stub" } });
    assert.equal(await createDescriber(cfg)(b64, ""), "stub vision: 5 bytes", "engine stub selects the stub, with no connection attempt");
    const bus = new FakeBus();
    const eyes = new Eyes({ bus, log: silentLog, screenshot: async () => b64, describe: createDescriber(cfg) });
    assert.equal(await eyes.look(), true);
    assert.equal(await eyes.look(), false);
    assert.equal(await eyes.look(), false);
    assert.deepEqual(bus.of("vision.summary"), [{ text: "stub vision: 5 bytes", changed: true }]);
  } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
});

// @spec EYES-ENAB-001
test("startEyes does not connect to OBS or loop when vision is disabled (#11)", async () => {
  let connects = 0, loops = 0;
  const started = await startEyes({
    enabled: false,
    connect: async () => { connects++; },
    loop: async () => { loops++; },
  });
  assert.equal(started, false);
  assert.equal(connects, 0);
  assert.equal(loops, 0);
});

// @spec EYES-ENAB-003
test("startEyes connects then loops when vision is enabled", async () => {
  const order: string[] = [];
  const started = await startEyes({
    enabled: true,
    connect: async () => { order.push("connect"); },
    loop: async () => { order.push("loop"); },
  });
  assert.equal(started, true);
  assert.deepEqual(order, ["connect", "loop"]);
});

// @spec EYES-DESC-006
test("the describer aborts a describe call the model has not answered within vision.timeout_ms", async () => {
  const server = http.createServer(() => { /* never answers */ });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => { server.closeAllConnections(); server.close(); });
  process.env.OLLAMA_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cfg = testConfig({ vision: { model: "llava", timeout_ms: 50 } });
  const describe = modelDescriber(cfg.vision, cfg.llm);
  const t0 = performance.now();
  await assert.rejects(describe("IMG", ""), /did not answer within 50 ms/);
  assert.ok(performance.now() - t0 < 2000);
});
