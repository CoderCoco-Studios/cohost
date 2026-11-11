/**
 * Smoke test for the reference HTTP hook server (examples/modules/server.py).
 *
 * Two layers. The fixture layer needs no Python: every recorded response of the reference server must be
 * accepted by the real salience, affect and critic validators (an `http`-kind Module that falls back to
 * rules would log a warning and return the rules result instead of the response). The live layer runs
 * server.py itself when `python3` is installed and checks it still answers the fixture requests with the
 * fixture responses, including the empty-body cases, so the fixtures cannot drift from the server.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { createScorer } from "../../../services/salience/src/scoring.js";
import { createAppraiser } from "../../../services/affect/src/appraise.js";
import { createCritic } from "../../../services/cortex/src/critic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleDir = path.resolve(here, "../../../examples/modules");
type Pair = { request: Record<string, unknown>; response: Record<string, unknown> };
const fixtures = JSON.parse(readFileSync(path.join(exampleDir, "fixtures/contracts.json"), "utf8")) as
  { salience: Pair[]; affect: Pair[]; critic: Pair[] };

const warns: string[] = [];
const log = { info() {}, error() {}, debug() {}, warn: (_o: unknown, msg: string) => warns.push(msg) } as never;

let answer: unknown;
const stub = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(answer));
});
await new Promise<void>((r) => stub.listen(0, r));
after(() => stub.close());
const stubUrl = `http://127.0.0.1:${(stub.address() as { port: number }).port}/m`;

const cfg = (brain: Record<string, unknown>) => ConfigSchema.parse({
  cohost: { name: "Coco", streamer: "Chris" },
  llm: { model: "m", embed_model: "e" },
  vision: { model: "v", obs: {} },
  chat: { twitch: {} },
  brain,
  voice: {},
  avatar: { vtube_studio: { host: "h", port: 1 }, vmc: { host: "h", port: 1 } },
  ears: { discord: {} },
  dashboard: {},
});
const hook = { module: { kind: "http", url: stubUrl, timeout_ms: 1000 } };

// @spec HOOK-EX-002, HOOK-EX-003, HOOK-EX-004
test("every recorded reference-server response passes the real salience, affect and critic validators", async () => {
  const scorer = createScorer(cfg({ salience: hook }), log);
  const appraiser = createAppraiser(cfg({ affect: hook }), log);
  const critic = createCritic(cfg({ cortex: { critic: hook.module } }), log);
  for (const { request, response } of fixtures.salience) {
    answer = response;
    assert.deepEqual(await scorer.run(request as never), response);
  }
  for (const { request, response } of fixtures.affect) {
    answer = response;
    assert.deepEqual(await appraiser.run(request as never), response);
  }
  for (const { request, response } of fixtures.critic) {
    answer = response;
    assert.deepEqual(await critic.run(request as never), response);
  }
  assert.deepEqual(warns, [], "no response fell back to rules");
});

// ---- live layer: needs python3

const hasPython = spawnSync("python3", ["--version"]).status === 0;

// A throwaway Python entry point: serve server.py's server on an OS-assigned port and print the port.
const launcher = [
  "import sys; sys.path.insert(0, sys.argv[1])",
  "import server",
  "s = server.make_server('127.0.0.1', 0)",
  "print(s.server_address[1], flush=True)",
  "s.serve_forever()",
].join("\n");

// @spec HOOK-EX-001, HOOK-EX-002, HOOK-EX-003, HOOK-EX-004, HOOK-EX-005, HOOK-EX-006, HOOK-EX-007, HOOK-EX-008, HOOK-EX-009, HOOK-EX-010
test("server.py answers the fixture requests with the fixture responses, 404s unknown paths, and tolerates an empty body", { skip: !hasPython && "python3 not installed" }, async () => {
  const child = spawn("python3", ["-I", "-B", "-c", launcher, exampleDir], { stdio: ["ignore", "pipe", "inherit"] });
  after(() => { child.kill(); });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`server.py exited early (${code})`)));
    child.stdout.once("data", (d) => resolve(Number(String(d).trim())));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, body?: string) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body });

  for (const route of ["salience", "affect", "critic"] as const) {
    for (const { request, response } of fixtures[route]) {
      const res = await post(`/${route}`, JSON.stringify(request));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), response);
    }
  }

  const unknown = await post("/nope", "{}");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "unknown module" });

  // HOOK-EX-006: no body, or Content-Length 0, reads as `{}`. The handlers then reject it with their own
  // KeyError (a 500 naming the missing field), not a framing TypeError from reading the body.
  const empty = await post("/critic");
  assert.equal(empty.status, 500);
  const emptyError = String((await empty.json() as { error: string }).error);
  assert.match(emptyError, /text/);
  assert.doesNotMatch(emptyError, /bytes|integer/);
  const zero = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(`${base}/affect`, { method: "POST", headers: { "content-length": "0" } }, (res) => {
      let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(zero.status, 500);
  assert.match(zero.body, /text/);
  assert.doesNotMatch(zero.body, /bytes|integer/);

  // HOOK-EX-007: a client that has sent headers but not its body does not hold up other requests.
  const stalled = net.connect(port, "127.0.0.1");
  after(() => { stalled.destroy(); });
  stalled.write("POST /critic HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
  await new Promise((r) => setTimeout(r, 50));
  const other = await fetch(`${base}/affect`, { method: "POST", body: JSON.stringify(fixtures.affect[0]!.request), signal: AbortSignal.timeout(3000) });
  assert.equal(other.status, 200);

  // HOOK-EX-008: routing uses the path alone; a query string or fragment does not make a known module unknown.
  const withQuery = await post("/critic?debug=1", JSON.stringify(fixtures.critic[2]!.request));
  assert.equal(withQuery.status, 200);
  assert.deepEqual(await withQuery.json(), fixtures.critic[2]!.response);
  assert.equal((await post("/critic/x", "{}")).status, 404);

  // HOOK-EX-009: the link check ignores case.
  const shout = await post("/critic", JSON.stringify({ text: "Watch HTTPS://EXAMPLE.COM now", emotion: "neutral", reason: "idle", transcript: "" }));
  assert.deepEqual(await shout.json(), { ok: false, note: "no links on air" });

  // HOOK-EX-010: a rewritten line keeps the request's emotion, as the contract in the file header shows.
  const fixed = await post("/critic", JSON.stringify({ text: "Nice one. Did you see that?", emotion: "smug", reason: "idle", transcript: "" }));
  assert.deepEqual(await fixed.json(), { ok: true, text: "Nice one.", emotion: "smug" });
});
