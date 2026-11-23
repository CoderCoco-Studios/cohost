/**
 * The stub model servers in examples/model-stub/ are run for real: each is started on a free port, called over HTTP,
 * and pointed at by the real OpenAI-compatible provider, so the example is held to the client it stands in for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { createChatProvider } from "../src/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "examples/model-stub");
const REPLY = "[happy] Hello from the stub model server.";

const has = (cmd: string, arg = "--version"): boolean => spawnSync(cmd, [arg]).status === 0;
const hasPython = has("python3");
const nodeOk = (() => {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 18);
})();

interface Stub { name: string; skip: string | false; cmd: string; args: string[] }
const stubs: Stub[] = [
  { name: "stub.py", skip: !hasPython && "python3 not installed", cmd: "python3", args: ["-I", "-B", path.join(dir, "stub.py")] },
  { name: "stub.ts", skip: !nodeOk && "needs Node 22.18 or later", cmd: process.execPath, args: [path.join(dir, "stub.ts")] },
];

/** Starts a stub with the given arguments; resolves once its first stdout line arrives. */
function start(s: Stub, extra: string[]): Promise<{ child: ChildProcess; first: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(s.cmd, [...s.args, ...extra], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve({ child, first: buf.slice(0, nl) });
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`${s.name} exited ${code} before listening`)));
  });
}

/** Runs `fn` against a stub on a free port, then stops it. */
async function withStub<T>(s: Stub, fn: (port: number) => Promise<T>): Promise<T> {
  const { child, first } = await start(s, ["0"]);
  child.removeAllListeners("exit");
  try {
    const m = /^listening on (\d+)$/.exec(first);
    assert.ok(m, `first line was ${JSON.stringify(first)}`);
    assert.notEqual(Number(m[1]), 0);
    return await fn(Number(m[1]));
  } finally {
    child.kill();
  }
}

for (const s of stubs) {
  // @spec LLM-EX-001
  test(`${s.name} prints 'listening on <port>' and exits 1 with a usage line for a bad port`, { skip: s.skip }, async () => {
    await withStub(s, async () => {});
    for (const bad of ["abc", "-1", "70000", "8.5"]) {
      const r = spawnSync(s.cmd, [...s.args, bad], { encoding: "utf8", timeout: 10_000 });
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /usage/i, bad);
    }
  });

  // @spec LLM-EX-003, LLM-EX-004
  test(`${s.name} answers /v1/models and /v1/chat/completions, and 404s anything else`, { skip: s.skip }, async () => {
    await withStub(s, async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const models = await fetch(`${base}/v1/models`);
      assert.equal(models.status, 200);
      assert.match(models.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(await models.json(), { object: "list", data: [{ id: "stub", object: "model", owned_by: "cohost" }] });

      for (const body of ['{"messages":[]}', "not json", ""]) {
        const chat = await fetch(`${base}/v1/chat/completions?x=1`, { method: "POST", body });
        assert.equal(chat.status, 200);
        assert.match(chat.headers.get("content-type") ?? "", /^application\/json/);
        const j = (await chat.json()) as Record<string, unknown>;
        assert.equal(typeof j.id, "string");
        assert.ok(Number.isInteger(j.created));
        assert.equal(j.object, "chat.completion");
        assert.equal(j.model, "stub");
        assert.deepEqual(j.choices, [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: REPLY } }]);
      }

      const misses: [string, string][] = [["GET", "/v1/chat/completions"], ["POST", "/v1/models"], ["GET", "/models"], ["GET", "/"], ["DELETE", "/v1/models"]];
      for (const [method, p] of misses) {
        const r = await fetch(`${base}${p}`, { method });
        assert.equal(r.status, 404, `${method} ${p}`);
        assert.deepEqual(await r.json(), { error: "not found" });
      }
    });
  });

  // @spec LLM-EX-005
  test(`the OpenAI-compatible provider pings and chats against ${s.name}`, { skip: s.skip }, async () => {
    await withStub(s, async (port) => {
      const cfg = ConfigSchema.shape.llm.parse({
        provider: "openai", model: "stub", embed_model: "e", openai: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "" },
      });
      const p = createChatProvider(cfg);
      assert.equal(await p.ping(), true);
      assert.equal(await p.chat([{ role: "user", content: "hi" }]), REPLY);
    });
  });

  // @spec LLM-EX-007
  test(`the OpenAI-compatible provider streams ${s.name}'s single JSON answer as one text event then done`, { skip: s.skip }, async () => {
    await withStub(s, async (port) => {
      const cfg = ConfigSchema.shape.llm.parse({
        provider: "openai", model: "stub", embed_model: "e", openai: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "" },
      });
      const evs: any[] = [];
      for await (const e of (createChatProvider(cfg) as any).stream([{ role: "user", content: "hi" }])) evs.push(e);
      assert.deepEqual(evs.map((e) => e.type), ["text", "done"]);
      assert.equal(evs[0].delta, REPLY);
      assert.equal(evs[1].result.text, REPLY);
    });
  });

  // @spec LLM-EX-008
  test(`the OpenAI-compatible provider offered tools gets ${s.name}'s text and no tool call`, { skip: s.skip }, async () => {
    await withStub(s, async (port) => {
      const cfg = ConfigSchema.shape.llm.parse({
        provider: "openai", model: "stub", embed_model: "e", openai: { base_url: `http://127.0.0.1:${port}/v1`, api_key: "" },
      });
      const tools = [{ name: "get_weather", description: "Weather", parameters: { type: "object", properties: {} } }];
      const r = await (createChatProvider(cfg) as any).complete([{ role: "user", content: "hi" }], { tools });
      assert.equal(r.text, REPLY);
      assert.deepEqual(r.toolCalls, []);
    });
  });

  // @spec LLM-EX-006
  test(`try.sh against ${s.name} prints the lines of try.expected.txt`, { skip: s.skip || (!has("curl") && "curl not installed") }, async () => {
    await withStub(s, async (port) => {
      const r = spawnSync("sh", [path.join(dir, "try.sh"), `http://127.0.0.1:${port}/v1`], { encoding: "utf8", timeout: 20_000 });
      assert.equal(r.status, 0, r.stderr);
      const lines = (t: string): string[] => t.replace(/\n+$/, "").split("\n");
      const got = lines(r.stdout);
      const want = lines(readFileSync(path.join(dir, "try.expected.txt"), "utf8"));
      assert.equal(got.length, want.length);
      want.forEach((w, i) => assert.deepEqual(JSON.parse(got[i]!), JSON.parse(w), `line ${i + 1}`));
    });
  });
}

// @spec LLM-EX-002
test("stub.py imports only the standard library and stub.ts only node: modules", () => {
  const py = readFileSync(path.join(dir, "stub.py"), "utf8");
  const mods = [...py.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]!.split(".")[0]!);
  assert.ok(mods.length > 0);
  const stdlib = new Set(["json", "sys", "http", "time", "os", "socket", "threading"]);
  for (const m of mods) assert.ok(stdlib.has(m), `non-stdlib import ${m}`);

  const ts = readFileSync(path.join(dir, "stub.ts"), "utf8");
  const specs = [...ts.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.ok(specs.length > 0);
  for (const sp of specs) assert.ok(sp.startsWith("node:"), `import ${sp}`);
  assert.doesNotMatch(ts, /^\s*(enum|namespace)\s|constructor\s*\([^)]*\b(private|public|readonly)\s/m, "needs more than type stripping");
});

// @spec LLM-EX-006
test("try.expected.txt holds one JSON document per line", () => {
  const lines = readFileSync(path.join(dir, "try.expected.txt"), "utf8").replace(/\n+$/, "").split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) JSON.parse(l);
});
