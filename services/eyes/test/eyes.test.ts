import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { Eyes, ollamaDescriber, stripDataUrl } from "../src/eyes.js";

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

test("SAME (any case, with trailing words) or an empty reply publishes nothing and keeps the previous line", async () => {
  const { eyes, bus, previous } = setup(["In the menu.", "SAME", "same.", "Same as before", "", "Samurai attack!"]);
  for (let i = 0; i < 6; i++) await eyes.look();
  assert.deepEqual(bus.of("vision.summary").map((v) => v.text), ["In the menu.", "Samurai attack!"]);
  assert.deepEqual(previous.slice(1, 5), ["In the menu.", "In the menu.", "In the menu.", "In the menu."]);
});

test("stripDataUrl removes the data: prefix obs-websocket adds", () => {
  assert.equal(stripDataUrl("data:image/jpg;base64,AAAA"), "AAAA");
  assert.equal(stripDataUrl("data:image/png;base64,BBBB"), "BBBB");
  assert.equal(stripDataUrl("CCCC"), "CCCC");
});

test("ollamaDescriber sends the frame and previous line, and keeps only the first line of the reply", async () => {
  let body: { model: string; messages: { role: string; content: string; images?: string[] }[] } | undefined;
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
  const describe = ollamaDescriber(testConfig({ vision: { model: "llava" } }).vision);

  assert.equal(await describe("IMG", ""), "A boss appears.");
  assert.equal(body!.model, "llava");
  assert.deepEqual(body!.messages[1], { role: "user", content: "What is happening now?", images: ["IMG"] });
  await describe("IMG", "In a cave.");
  assert.equal(body!.messages[1]!.content, "Previous description: In a cave.\nWhat is happening now?");
  status = 500;
  await assert.rejects(describe("IMG", ""), /vision model 500/);
});
