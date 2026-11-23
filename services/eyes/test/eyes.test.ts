import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { ImageDataError } from "@cohost/llm";
import { parseConfigText } from "@cohost/config";
import { Eyes, createDescriber, isSame, modelDescriber, startEyes, stripDataUrl, stubDescriber, buildVisionProvider, gapOf } from "../src/eyes.js";
import { JPEG_B64, serveModel } from "./support.js";

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
  assert.deepEqual(bus.of("vision.summary").map(({ timing: _t, ...rest }) => rest), [
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

// @spec EYES-LOOK-001, EYES-LOOK-003, EYES-LOOK-007
test("a look measures its duration and its describe duration on the injected monotonic clock, for a change and for SAME", async () => {
  const bus = new FakeBus();
  const lines: { obj: unknown; msg?: string }[] = [];
  const log = { debug: (obj: unknown, msg?: string) => lines.push({ obj, msg }), info: (obj: unknown, msg?: string) => lines.push({ obj, msg }), warn() {}, error() {} } as never;
  // per look: start, before describe, after describe, end
  const ticks = [1000, 1100, 1200, 1250, 5000, 5010, 5030, 5040, 6000, 6001, 6007, 6008];
  const eyes = new Eyes({ bus, log, screenshot: async () => "B", describe: async (_b, prev) => (prev ? (prev === "A cave." ? "SAME" : "") : "A cave."), now: () => ticks.shift()! });
  await eyes.look();
  await eyes.look();
  eyes["previous"] = "x";
  await eyes.look(); // empty description
  assert.deepEqual(lines.map((l) => l.obj as { ms: number; describeMs: number }).map((o) => [o.ms, o.describeMs]), [[250, 100], [40, 20], [8, 6]]);
});

// @spec EYES-LOOK-006, EYES-INJ-017
test("a published summary carries epoch capturedAt right after the screenshot returns and describedAt right after describe returns", async () => {
  const bus = new FakeBus();
  const order: string[] = [];
  const wall = [1_700_000_000_100, 1_700_000_000_900];
  const eyes = new Eyes({
    bus, log: silentLog,
    screenshot: async () => { order.push("shot"); return "B"; },
    describe: async () => { order.push("describe"); return "A cave."; },
    wallNow: () => { order.push("stamp"); return wall.shift()!; },
  });
  await eyes.look();
  assert.deepEqual(order, ["shot", "stamp", "describe", "stamp"]);
  assert.deepEqual(bus.of("vision.summary"), [{ text: "A cave.", changed: true, timing: { capturedAt: 1_700_000_000_100, describedAt: 1_700_000_000_900 } }]);
});

// @spec EYES-LOOK-006
test("with the default epoch clock the stamps are non-negative integers with capturedAt <= describedAt", async () => {
  const { eyes, bus } = setup(["A cave."]);
  await eyes.look();
  const t = bus.of("vision.summary")[0]!.timing!;
  assert.ok(Number.isInteger(t.capturedAt) && Number.isInteger(t.describedAt) && t.capturedAt! <= t.describedAt!);
  assert.ok(Math.abs(t.capturedAt! - Date.now()) < 5000);
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
    const cfg = testConfig({ vision: { model: "v", provider: "stub" } });
    assert.equal(await createDescriber(cfg)(b64, ""), "stub vision: 5 bytes", "engine stub selects the stub, with no connection attempt");
    const bus = new FakeBus();
    const eyes = new Eyes({ bus, log: silentLog, screenshot: async () => b64, describe: createDescriber(cfg) });
    assert.equal(await eyes.look(), true);
    assert.equal(await eyes.look(), false);
    assert.equal(await eyes.look(), false);
    assert.deepEqual(bus.of("vision.summary").map(({ timing: _t, ...rest }) => rest), [{ text: "stub vision: 5 bytes", changed: true }]);
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

// @spec EYES-PROV-002, EYES-PROV-004, EYES-PROV-005, EYES-DESC-001
test("provider openai: the describer asks llm.openai.base_url with vision.model and the chat credential, non-streamed, with the image and the vision options", async () => {
  const m = await serveModel("  A boss appears.\nIt looks angry.  ");
  const cfg = testConfig({
    llm: { model: "chat-model", openai: { base_url: m.url, api_key: "sk-chat" } },
    vision: { provider: "openai", model: "vision-model", temperature: 0.4, num_predict: 25 },
  });
  const describe = createDescriber(cfg);
  assert.equal(await describe(JPEG_B64, "In a cave."), "A boss appears.");
  const [req] = m.seen;
  assert.equal(req!.method, "POST");
  assert.equal(req!.url, "/chat/completions");
  assert.equal(req!.headers.authorization, "Bearer sk-chat", "the credential stored for the chat model");
  assert.equal(req!.body.model, "vision-model", "vision.model, not llm.model");
  assert.equal(req!.body.stream, false);
  assert.equal(req!.body.temperature, 0.4);
  assert.equal(req!.body.max_tokens, 25);
  assert.deepEqual(req!.body.messages[0], { role: "system", content: cfg.vision.prompt });
  assert.deepEqual(req!.body.messages[1].content, [
    { type: "text", text: "Previous description: In a cave.\nWhat is happening now?" },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } },
  ]);
});

// @spec EYES-PROV-001, EYES-PROV-002, EYES-DESC-001
test("a blank vision.provider is ollama: the request goes to <OLLAMA_URL>/api/chat with the image on the user message, whatever llm.provider is", async () => {
  const m = await serveModel();
  const saved = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = m.url;
  try {
    const cfg = testConfig({ llm: { provider: "openai", openai: { base_url: "http://127.0.0.1:1" } }, vision: { provider: "", model: "llava", temperature: 0.1, num_predict: 12 } });
    assert.equal(cfg.vision.provider, "ollama");
    assert.equal(await createDescriber(cfg)(JPEG_B64, ""), "A boss appears.");
    const [req] = m.seen;
    assert.equal(req!.url, "/api/chat");
    assert.equal(req!.body.model, "llava");
    assert.equal(req!.body.stream, false);
    assert.equal(req!.body.options.num_predict, 12);
    assert.deepEqual(req!.body.messages[1], { role: "user", content: "What is happening now?", images: [JPEG_B64] });
  } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
});

// @spec EYES-PROV-004
test("llm.openai.base_url defaults to the hosted https://api.openai.com/v1, which the openai vision provider then uses", () => {
  assert.equal(testConfig().llm.openai.base_url, "https://api.openai.com/v1");
});

// @spec EYES-PROV-005
test("the vision section defines no credential of its own", () => {
  assert.deepEqual(Object.keys(testConfig().vision).filter((k) => /key|secret|token|credential|password/i.test(k)), []);
});

// @spec EYES-DESC-006
test("vision.timeout_ms aborts a describe call to an OpenAI-compatible server that never answers", async () => {
  const m = await serveModel();
  m.state.hang = true;
  const cfg = testConfig({ llm: { openai: { base_url: m.url } }, vision: { provider: "openai", model: "vision-model", timeout_ms: 50 } });
  const t0 = performance.now();
  await assert.rejects(createDescriber(cfg)(JPEG_B64, ""), /did not answer within 50 ms/);
  assert.ok(performance.now() - t0 < 2000);
});

// @spec EYES-STUB-003
test("an isolation override that sets vision.provider to stub wins over the configured provider: no request, fixed text", async () => {
  const base = testConfig({ vision: { enabled: true, provider: "anthropic", model: "claude-vision" } });
  const parsed = parseConfigText(JSON.stringify(base), {}, { VISION_PROVIDER: "stub" });
  assert.ok(parsed.ok, `the preset loads: ${parsed.ok ? "" : JSON.stringify(parsed.issues)}`);
  assert.equal(parsed.config.vision.provider, "stub");
  assert.equal(await createDescriber(parsed.config)(JPEG_B64, ""), `stub vision: ${Buffer.from(JPEG_B64, "base64").length} bytes`);
});

// @spec EYES-GAP-001, EYES-GAP-004
test("a blank vision.model with a real provider fails each describe at once with `vision.model is not set` and sends nothing", async () => {
  const m = await serveModel();
  for (const provider of ["ollama", "openai"] as const) {
    const cfg = testConfig({ llm: { openai: { base_url: m.url } }, vision: { provider, model: "" } });
    const saved = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = m.url;
    try {
      const t0 = performance.now();
      await assert.rejects(createDescriber(cfg)(JPEG_B64, ""), /vision\.model is not set/, provider);
      assert.ok(performance.now() - t0 < 1000, "at once");
    } finally { if (saved === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = saved; }
  }
  assert.deepEqual(m.seen, []);
});

// @spec EYES-GAP-001
test("a blank vision.model with the stub provider is not a gap: the stub still describes", async () => {
  const cfg = testConfig({ vision: { provider: "stub", model: "" } });
  assert.equal(await createDescriber(cfg)(JPEG_B64, ""), `stub vision: ${Buffer.from(JPEG_B64, "base64").length} bytes`);
});

// @spec EYES-GAP-003
test("anthropic and bedrock without their credentials fail each describe at once with a not-configured error naming the missing key", async () => {
  const cases: [string, Record<string, unknown>, RegExp][] = [
    ["anthropic", {}, /not configured: llm\.claude\.api_key is not set/],
    ["bedrock", {}, /not configured: llm\.bedrock\.region/],
    ["bedrock", { bedrock: { region: "us-east-1" } }, /not configured: llm\.bedrock\.access_key_id, llm\.bedrock\.secret_access_key/],
  ];
  for (const [provider, llm, want] of cases) {
    const cfg = testConfig({ llm, vision: { provider, model: "claude-vision" } });
    const t0 = performance.now();
    await assert.rejects(createDescriber(cfg)(JPEG_B64, ""), want, provider);
    assert.ok(performance.now() - t0 < 1000, "at once");
  }
});

// @spec EYES-PROV-007, EYES-DESC-001
test("a BMP or PDF frame is refused by every hosted provider with a TypeError before any request, so it is a frame fault, not an outage", async () => {
  const m = await serveModel();
  const bmp = Buffer.from("BM\x36\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00", "latin1").toString("base64");
  const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1").toString("base64");
  const keyed = { claude: { api_key: "sk-test" }, bedrock: { region: "us-east-1", access_key_id: "AKIA", secret_access_key: "s" } };
  for (const [provider, llm] of [["openai", { openai: { base_url: m.url } }], ["anthropic", keyed], ["bedrock", keyed]] as const) {
    const describe = createDescriber(testConfig({ llm, vision: { provider, model: "vision-model" } }));
    for (const img of [bmp, pdf]) {
      await assert.rejects(describe(img, ""), (err) => err instanceof ImageDataError, provider);
    }
  }
  assert.deepEqual(m.seen, []);
});

// @spec EYES-DESC-006
test("a provider that ignores the abort signal does not stall the describer: its timer rejects the call at vision.timeout_ms", async () => {
  const chat = { name: "x", model: "v", chat: () => new Promise<string>(() => {}) };
  const cfg = testConfig({ vision: { provider: "openai", model: "v", timeout_ms: 50 } });
  const t0 = performance.now();
  await assert.rejects(modelDescriber(cfg.vision, cfg.llm, chat as never)(JPEG_B64, ""), /did not answer within 50 ms/);
  assert.ok(performance.now() - t0 < 2000);
});

// @spec EYES-GAP-006
test("bedrock with a region and only one of the key pair is a gap: createDescriber does not throw, each describe fails at once with the model layer's message, and nothing is sent", async () => {
  const cfg = testConfig({ llm: { bedrock: { region: "us-east-1", access_key_id: "AKIA" } }, vision: { provider: "bedrock", model: "claude-vision" } });
  const describe = createDescriber(cfg);
  const t0 = performance.now();
  await assert.rejects(describe(JPEG_B64, ""), /must be set together: only one of them is set/);
  assert.ok(performance.now() - t0 < 1000, "at once");
  assert.equal(gapOf(buildVisionProvider(cfg)), "llm.bedrock.access_key_id and llm.bedrock.secret_access_key must be set together: only one of them is set");
});
