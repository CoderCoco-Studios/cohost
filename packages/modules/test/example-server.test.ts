/**
 * Tests of the reference HTTP hook servers: the Python, TypeScript and Rust ones answer alike.
 *
 * Two layers. The fixture layer needs no Python: every recorded response of the reference server must be
 * accepted by the real salience, affect and critic validators (an `http`-kind Module that falls back to
 * rules would log a warning and return the rules result instead of the response). The live layer runs
 * each server (when its toolchain is installed) and checks it still answers the fixture requests with the
 * fixture responses, including the empty-body cases, so the fixtures cannot drift from the server.
 *
 * The files the docs pages show, each run or read below:
 * examples/modules/server.py
 * examples/modules/server.ts
 * examples/modules/try.sh
 * examples/modules/try.expected.txt
 * examples/modules/rust/Cargo.toml
 * examples/modules/rust/src/main.rs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
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
  ears: {},
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

// ---- live layer: one set of assertions per reference server

const hasCurl = spawnSync("curl", ["--version"]).status === 0;
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const nodeStrips = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
const NEEDS_NODE = "needs Node 22.18 or later";
const repoRoot = path.resolve(exampleDir, "../..");

// A throwaway Python entry point: serve server.py's server on an OS-assigned port and print the port.
const launcher = [
  "import sys; sys.path.insert(0, sys.argv[1])",
  "import server",
  "s = server.make_server('127.0.0.1', 0)",
  "print(s.server_address[1], flush=True)",
  "s.serve_forever()",
].join("\n");

/** Spawn a server and resolve the port its first stdout line reports (`listening on N`, or a bare N); kill it after the run. */
function startServer(cmd: string, args: string[], firstLine: RegExp): Promise<number> {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
  after(() => { child.kill(); });
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${cmd} ${args.join(" ")} exited early (${code})`)));
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += String(d);
      if (!buf.includes("\n")) return;
      const line = buf.split("\n")[0]!;
      const m = firstLine.exec(line);
      if (!m) return reject(new Error(`unexpected first line of output: ${JSON.stringify(line)}`));
      resolve(Number(m[1]));
    });
  });
}

const expectedLines = readFileSync(path.join(exampleDir, "try.expected.txt"), "utf8").split("\n");
while (expectedLines.length && expectedLines[expectedLines.length - 1] === "") expectedLines.pop();

function runTryScript(base: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("sh", [path.join(exampleDir, "try.sh"), base], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.once("error", reject);
    p.once("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`try.sh exited ${code}`))));
  });
}

// HOOK-EX-016: try.sh prints one JSON reply per line, equal to the same line of try.expected.txt.
async function tryAssertions(base: string): Promise<void> {
  if (!hasCurl) return;
  const lines = (await runTryScript(base)).split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  assert.equal(lines.length, expectedLines.length, "try.sh prints as many lines as try.expected.txt holds");
  lines.forEach((l, i) => assert.deepEqual(JSON.parse(l), JSON.parse(expectedLines[i]!), `try.sh line ${i + 1}`));
}

async function liveAssertions(port: number): Promise<void> {
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
  // error naming the missing field, not a framing error from reading the body.
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

  // HOOK-EX-010: a rewritten line keeps the request's emotion, `neutral` when it has none.
  const fixed = await post("/critic", JSON.stringify({ text: "Nice one. Did you see that?", emotion: "smug", reason: "idle", transcript: "" }));
  assert.deepEqual(await fixed.json(), { ok: true, text: "Nice one.", emotion: "smug" });
  const noEmotion = await post("/critic", JSON.stringify({ text: "Nice one. Did you see that?" }));
  assert.deepEqual(await noEmotion.json(), { ok: true, text: "Nice one.", emotion: "neutral" });

  await tryAssertions(base);
}

// @spec HOOK-EX-001, HOOK-EX-002, HOOK-EX-003, HOOK-EX-004, HOOK-EX-005, HOOK-EX-006, HOOK-EX-007, HOOK-EX-008, HOOK-EX-009, HOOK-EX-010, HOOK-EX-016
test("server.py answers the fixture requests with the fixture responses, 404s unknown paths, and tolerates an empty body", async () => {
  await liveAssertions(await startServer("python3", ["-I", "-B", "-c", launcher, exampleDir], /^(\d+)$/));
});

// @spec HOOK-EX-011, HOOK-EX-012, HOOK-EX-015, HOOK-EX-016
test("server.ts behaves as server.py does, run with no flags", { skip: !nodeStrips && NEEDS_NODE }, async () => {
  const port = await startServer(process.execPath, [path.join(exampleDir, "server.ts"), "0"], /^listening on (\d+)$/);
  await liveAssertions(port);
  // HOOK-EX-015: it binds every interface, so a non-loopback address of this machine reaches it too.
  const external = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal);
  if (external) {
    const res = await fetch(`http://${external.address}:${port}/affect`, { method: "POST", body: JSON.stringify(fixtures.affect[0]!.request) });
    assert.equal(res.status, 200);
  }
});

// @spec HOOK-EX-012
test("server.ts imports only node: built-ins", { skip: !nodeStrips && NEEDS_NODE }, () => {
  const src = readFileSync(path.join(exampleDir, "server.ts"), "utf8");
  const specs = [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.ok(specs.length > 0, "server.ts imports something");
  for (const s of specs) assert.match(s, /^node:/, `import of ${s}`);
});

// @spec HOOK-EX-013, HOOK-EX-015, HOOK-EX-016
test("the Rust server behaves as server.py does", { timeout: 600_000 }, async () => {
  const build = spawnSync("cargo", ["build", "--manifest-path", path.join(repoRoot, "examples/Cargo.toml"), "-p", "cohost-example-hook-server"], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);
  const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(repoRoot, "examples/target");
  await liveAssertions(await startServer(path.join(targetDir, "debug/cohost-example-hook-server"), ["0"], /^listening on (\d+)$/));
});

// @spec HOOK-EX-014
test("the Rust server depends on serde_json alone, at the version crates/cohost-bus uses", () => {
  const section = (t: string, name: string) => {
    const lines = t.split("\n");
    const start = lines.findIndex((l) => l.trim() === `[${name}]`);
    if (start < 0) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.trim().startsWith("["));
    return (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  };
  const toml = readFileSync(path.join(exampleDir, "rust/Cargo.toml"), "utf8");
  const busToml = readFileSync(path.join(repoRoot, "crates/cohost-bus/Cargo.toml"), "utf8");
  const busVersion = section(busToml, "dependencies").map((l) => /^serde_json\s*=\s*"([^"]+)"/.exec(l)?.[1]).find(Boolean);
  assert.ok(busVersion, "crates/cohost-bus names a serde_json version");
  assert.deepEqual(section(toml, "dependencies"), [`serde_json = "${busVersion}"`]);
  assert.doesNotMatch(toml, /^\[(dev|build)-dependencies\]/m);
});
