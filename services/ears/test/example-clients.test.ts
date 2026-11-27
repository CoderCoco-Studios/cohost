/**
 * The audio clients and converters in examples/audio-in/ are run for real against a real `http` capture (the stub
 * transcriber behind it), so each is held to the listener it talks to. A client whose program is not installed, or a
 * `.ts` client on a Node older than 22.18, is skipped with a message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
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

/** The control token the clients are run with, and the listener key the listener holds (control-plane CTRL-RUNTIME-017). */
const TOKEN = "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed";
const KEY = createHmac("sha256", TOKEN).update("cohost/ears-listener/v1").digest("hex");

async function listener(verifier = KEY) {
  const bus = new FakeBus();
  const hearing = new Hearing({ cfg: testConfig().ears, bus, log: silentLog, transcribe: (w) => createBatchEngine("stub", testConfig().ears).transcribe(w) });
  const cap = createHttpCapture({ host: "127.0.0.1", port: 0, log: silentLog, verifier, hear: (c, s, src, id) => hearing.heardClip(c, s, src, id) });
  await cap.start();
  return { bus, cap, url: `http://127.0.0.1:${cap.port}/audio` };
}

interface Run { code: number; stdout: string; stderr: string }
/** Runs a client with `CONTROL_TOKEN` set to `TOKEN` unless `env` says otherwise (`undefined` leaves it unset). */
function run(cmd: string, args: string[], env: Record<string, string | undefined> = { CONTROL_TOKEN: TOKEN }): Promise<Run> {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.CONTROL_TOKEN;
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
  test(`${c.name} derives the listener key from the trimmed CONTROL_TOKEN and sends it, never the token; without the variable it exits 1 and sends nothing`, { skip: c.skip }, async () => {
    const l = await listener();
    try {
      const withToken = await run(c.cmd, to(c, l.url), { CONTROL_TOKEN: `  ${TOKEN}\t` });
      assert.equal(withToken.code, 0, withToken.stderr);
      assert.deepEqual(speakers(l.bus), ["http"], "answered 200 and heard");
    } finally {
      await l.cap.stop();
    }
    const seen: IncomingHttpHeaders[] = [];
    const spy = createServer((req, res) => { seen.push(req.headers); req.resume(); res.end("{}"); });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(spy.address() as { port: number }).port}/audio`;
      await run(c.cmd, to(c, url));
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!["content-type"], "audio/wav");
      assert.equal(seen[0]!.authorization, `Bearer ${KEY}`, "the derived key, never the token");
      for (const env of [{ CONTROL_TOKEN: "" }, { CONTROL_TOKEN: undefined }]) {
        const r = await run(c.cmd, to(c, url), env);
        assert.equal(r.code, 1, JSON.stringify(env));
        assert.match(r.stderr, /CONTROL_TOKEN/);
      }
      assert.equal(seen.length, 1, "nothing sent without the variable");
    } finally {
      spy.close();
    }
  });

  // @spec EARS-EX-001
  test(`${c.name} exits 1 and reports on a refused clip and on an unreachable listener`, { skip: c.skip }, async () => {
    const l = await listener("ab".repeat(32)); // a listener holding another key refuses the clip 401
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
      assert.ok(!urls[0]!.includes(" ") && !urls[0]!.includes("&Bo"), urls[0]!);
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
  const l = await listener("ab".repeat(32)); // another key: the clip is refused 401
  try {
    const r = await run("sh", [path.join(dir, "send.sh"), clipPath, l.url]);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /listener key is required/);
  } finally {
    await l.cap.stop();
  }
});

// @spec EARS-EX-003
test("send_clip.py imports only the standard library and send-clip.ts only node: modules, with erasable types", () => {
  const py = readFileSync(path.join(dir, "send_clip.py"), "utf8");
  const mods = [...py.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)].map((m) => m[1]!.split(".")[0]!);
  assert.ok(mods.length > 0);
  const stdlib = new Set(["os", "sys", "urllib", "json", "http", "pathlib", "hmac", "hashlib"]);
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
