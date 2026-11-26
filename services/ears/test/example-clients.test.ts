/**
 * The audio clients and converters in examples/audio-in/ are run for real against a real `http` capture (the stub
 * transcriber behind it), so each is held to the listener it talks to. A client whose program is not installed, or a
 * `.ts` client on a Node older than 22.18, is skipped with a message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FakeBus, silentLog, testConfig } from "@cohost/testing";
import { parseWav, wavWrap } from "@cohost/shared";
import { createHttpCapture } from "../src/capture-http.js";
import { decodeClip } from "../src/capture.js";
import { Hearing } from "../src/hearing.js";
import { createBatchEngine } from "../src/engines.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "examples/audio-in");
const tmp = mkdtempSync(path.join(tmpdir(), "audio-in-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const has = (cmd: string, arg = "--version"): boolean => spawnSync(cmd, [arg]).status === 0;
const nodeOk = (() => {
  const [maj = 0, min = 0] = process.versions.node.split(".").map(Number);
  return maj > 22 || (maj === 22 && min >= 18);
})();

/** A 1000 ms silent clip: 16 kHz mono, written to disk. */
const clipPath = path.join(tmp, "clip.wav");
writeFileSync(clipPath, wavWrap(Buffer.alloc(32000), 16000, 1));

async function listener(token = "") {
  const bus = new FakeBus();
  const hearing = new Hearing({ cfg: testConfig().ears, bus, log: silentLog, transcribe: (w) => createBatchEngine("stub", testConfig().ears).transcribe(w) });
  const cap = createHttpCapture({ host: "127.0.0.1", port: 0, log: silentLog, token, hear: (c, s, src, id) => hearing.heardClip(c, s, src, id) });
  await cap.start();
  return { bus, cap, url: `http://127.0.0.1:${cap.port}/audio` };
}

interface Run { code: number; stdout: string; stderr: string }
function run(cmd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.EARS_HTTP_TOKEN;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return new Promise((resolve) => {
    execFile(cmd, args, { env: e, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

interface Client { name: string; skip: string | false; cmd: string; script: string; flags: boolean }
const clients: Client[] = [
  { name: "send_clip.py", skip: false, cmd: "python3", script: "send_clip.py", flags: true },
  { name: "send-clip.ts", skip: !nodeOk && "needs Node 22.18 or later", cmd: process.execPath, script: "send-clip.ts", flags: true },
  { name: "send.sh", skip: !has("curl") && "curl not installed", cmd: "sh", script: "send.sh", flags: false },
];
const argsFor = (c: Client, ...rest: string[]): string[] => (c.cmd === "python3" ? ["-I", "-B"] : []).concat(path.join(dir, c.script), ...rest);
/** The arguments sending `clipPath` to `url`: the clients take `--url`, `send.sh` a second positional. */
const to = (c: Client, url: string): string[] => argsFor(c, clipPath, ...(c.flags ? ["--url", url] : [url]));
const speakers = (bus: FakeBus): string[] => bus.published.map((p) => (p.data as { speaker: string }).speaker);

for (const c of clients) {
  // @spec EARS-EX-001, EARS-EX-005
  test(`${c.name} posts the clip, prints the reply, and the bus carries one speech.heard`, { skip: c.skip }, async () => {
    const l = await listener();
    try {
      const r = await run(c.cmd, to(c, l.url));
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { heard: true, text: "stub transcript (1000 ms)" });
      assert.deepEqual(speakers(l.bus), ["http"]);
    } finally {
      await l.cap.stop();
    }
  });

  // @spec EARS-EX-002
  test(`${c.name} sends the bearer token from EARS_HTTP_TOKEN, and none when it is empty`, { skip: c.skip }, async () => {
    const l = await listener("s3cret");
    try {
      const withToken = await run(c.cmd, to(c, l.url), { EARS_HTTP_TOKEN: "s3cret" });
      assert.equal(withToken.code, 0, withToken.stderr);
      const without = await run(c.cmd, to(c, l.url));
      assert.equal(without.code, 1);
      assert.match(without.stdout, /bearer token required/, "the 401 body is printed");
    } finally {
      await l.cap.stop();
    }
    // An empty variable sends no Authorization header at all.
    let seen: IncomingHttpHeaders = {};
    const spy = createServer((req, res) => { seen = req.headers; req.resume(); res.end("{}"); });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
    try {
      const port = (spy.address() as { port: number }).port;
      await run(c.cmd, to(c, `http://127.0.0.1:${port}/audio`), { EARS_HTTP_TOKEN: "" });
      assert.equal(seen["content-type"], "audio/wav");
      assert.equal(seen.authorization, undefined);
    } finally {
      spy.close();
    }
  });

  // @spec EARS-EX-001
  test(`${c.name} exits 1 and reports on a refused clip and on an unreachable listener`, { skip: c.skip }, async () => {
    const l = await listener("s3cret");
    try {
      const refused = await run(c.cmd, to(c, l.url));
      assert.equal(refused.code, 1);
      const dead = await run(c.cmd, to(c, "http://127.0.0.1:1/audio"));
      assert.notEqual(dead.code, 0);
      if (c.flags) assert.notEqual(dead.stderr, "", "a message on standard error");
    } finally {
      await l.cap.stop();
    }
  });

  if (!c.flags) continue;

  // @spec EARS-EX-001, EARS-EX-005
  test(`${c.name} takes --speaker, --source and --url before or after the file, URL-encoded`, { skip: c.skip }, async () => {
    const urls: string[] = [];
    const spy = createServer((req, res) => { urls.push(req.url ?? ""); req.resume(); res.end("{}"); });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
    const port = (spy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/audio`;
    try {
      await run(c.cmd, argsFor(c, clipPath, "--url", url, "--speaker", "Ann & Bo", "--source", "desktop"));
      await run(c.cmd, argsFor(c, "--speaker", "x y", "--url", url, clipPath));
      assert.equal(new URL(urls[0]!, "http://h").searchParams.get("speaker"), "Ann & Bo");
      assert.ok(!urls[0]!.includes(" ") && !urls[0]!.includes("&Bo"), urls[0]);
      assert.equal(new URL(urls[0]!, "http://h").searchParams.get("source"), "desktop");
      assert.equal(new URL(urls[1]!, "http://h").searchParams.get("speaker"), "x y");
      assert.equal(new URL(urls[1]!, "http://h").searchParams.has("source"), false);
    } finally {
      spy.close();
    }
    const l = await listener();
    try {
      const r = await run(c.cmd, argsFor(c, clipPath, "--url", l.url, "--speaker", "bob"));
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(speakers(l.bus), ["bob"]);
    } finally {
      await l.cap.stop();
    }
  });

  // @spec EARS-EX-001
  test(`${c.name} exits 1 with a message for an unreadable file or wrong arguments`, { skip: c.skip }, async () => {
    for (const args of [[path.join(tmp, "nope.wav")], [], [clipPath, "extra"], [clipPath, "--bogus"], [clipPath, "--url"]]) {
      const r = await run(c.cmd, argsFor(c, ...args));
      assert.equal(r.code, 1, JSON.stringify(args));
      assert.notEqual(r.stderr.trim(), "", JSON.stringify(args));
    }
  });
}

// @spec EARS-EX-004
test("send.sh exits non-zero and still prints the reply body when the status is not 200", { skip: !has("curl") && "curl not installed" }, async () => {
  const l = await listener("s3cret");
  try {
    const r = await run("sh", [path.join(dir, "send.sh"), clipPath, l.url]);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /bearer token required/);
  } finally {
    await l.cap.stop();
  }
});

// @spec EARS-EX-003
test("send_clip.py imports only the standard library and send-clip.ts only node: modules, with erasable types", () => {
  const py = readFileSync(path.join(dir, "send_clip.py"), "utf8");
  const mods = [...py.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]!.split(".")[0]!);
  assert.ok(mods.length > 0);
  const stdlib = new Set(["os", "sys", "urllib", "json", "http", "pathlib"]);
  for (const m of mods) assert.ok(stdlib.has(m), `non-stdlib import ${m}`);

  const ts = readFileSync(path.join(dir, "send-clip.ts"), "utf8");
  const specs = [...ts.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1]!);
  assert.ok(specs.length > 0);
  for (const sp of specs) assert.ok(sp.startsWith("node:"), `import ${sp}`);
  assert.doesNotMatch(ts, /^\s*(enum|namespace)\s|\b(private|public|readonly)\s+\w+\s*[:,)]/m, "needs more than type stripping");
});

// ---- converters

/** A 44100 Hz, two-channel WAV of one second of a quiet tone. */
function tone(): Buffer {
  const frames = 44100;
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 44100) * 8000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  return wavWrap(pcm, 44100, 2);
}

for (const [spec, tool, script] of [["EARS-EX-006", "sox", "to-wav-sox.sh"], ["EARS-EX-007", "ffmpeg", "to-wav-ffmpeg.sh"]] as const) {
  const installed = tool === "sox" ? has("sox", "--version") : has("ffmpeg", "-version");
  const skip = !installed && `${tool} is not installed; ${script} is tested only where it is`;
  // @spec EARS-EX-006, EARS-EX-007
  test(`${script} writes a 16 kHz mono 16-bit WAV that decodeClip accepts (${spec})`, { skip }, async () => {
    const input = path.join(tmp, `${tool}-in.wav`);
    const output = path.join(tmp, `${tool}-out.wav`);
    writeFileSync(input, tone());
    const r = await run("sh", [path.join(dir, script), input, output]);
    assert.equal(r.code, 0, r.stderr);
    const buf = readFileSync(output);
    const w = parseWav(buf);
    assert.equal(w.sampleRate, 16000);
    assert.equal(w.channels, 1);
    const clip = decodeClip(buf, "audio/wav");
    assert.equal(clip.rate, 16000);
    assert.equal(clip.channels, 1);
    assert.ok(clip.pcm.length > 30000 && clip.pcm.length < 34000, `about one second of 16-bit samples, got ${clip.pcm.length} bytes`);
  });

  // @spec EARS-EX-006, EARS-EX-007
  test(`${script} prints a usage line and exits non-zero without exactly two arguments`, async () => {
    for (const args of [[], ["a"], ["a", "b", "c"]]) {
      const r = await run("sh", [path.join(dir, script), ...args]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /usage/i);
    }
  });
}
