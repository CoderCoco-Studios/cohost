import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDockerBin } from "@cohost/control";

// MOD-TEST-007 end to end: the whole stack under Docker with every unit's isolation preset, a real dashboard process
// in front of it, and each unit's declared input answered by that unit. Heavy (the first run pulls images), so it runs
// only where COHOST_LIVE_STACK=1, Docker answers, and the environment carries the mock presets (README quickstart:
// `set -a; . ./.env; set +a`, with COMPOSE_PROFILES=eyes,ears,mouth and the presets of CTRL-MANIFEST-003 in `.env`) and ports
// 3000 and 3001 are free (the dashboard under test binds them).

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const env: NodeJS.ProcessEnv = { ...process.env, CONTROL_ENABLED: "1" };
const TOKEN =env.CONTROL_TOKEN ?? "";
const BASE = "http://127.0.0.1:3000";
const docker = resolveDockerBin(env);

const sh = (args: string[]) => new Promise<string>((resolve, reject) => {
  if (!docker.ok) return reject(new Error(docker.detail));
  execFile(docker.bin, args, { env, cwd: root, timeout: 30_000, maxBuffer: 64 << 20 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});
const skip = process.env.COHOST_LIVE_STACK !== "1" ? "set COHOST_LIVE_STACK=1 to run the live stack test"
  : !TOKEN ? "CONTROL_TOKEN is not in the environment"
  : !docker.ok ? docker.detail
  : await sh(["info"]).then(() => undefined, () => "no reachable Docker daemon");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${TOKEN}`, ...headers }, ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) });
  const text = await r.text();
  let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json: json as any };
}
const redis = (...a: string[]) => sh(["compose", "exec", "-T", "redis", "redis-cli", ...a]);
const lastId = async () => (await redis("XREVRANGE", "cohost:events", "+", "-", "COUNT", "1")).split("\n")[0]!;
async function observe(since: string, types: string[], pred: (data: string) => boolean = () => true, ms = 30_000): Promise<string[]> {
  const end = Date.now() + ms;
  for (;;) {
    const lines = (await redis("XRANGE", "cohost:events", `(${since}`, "+")).split("\n");
    const hits: string[] = [];
    for (let i = 0; i + 8 < lines.length; i += 9) if (types.includes(lines[i + 2]!) && pred(lines[i + 8]!)) hits.push(`${lines[i + 2]} ${lines[i + 8]}`);
    if (hits.length || Date.now() > end) return hits;
    await sleep(1000);
  }
}
const wav = () => { const n = 4800; const b = Buffer.alloc(44 + n * 2); b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40); return b; };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CASE_DEADLINE_MS = 90_000;
const ATTEMPT_MS = 8000;
/** Resolves once cortex's newest brain.status is not "speaking" (its voice-busy gate is open), or at the deadline. */
async function waitSpeakingGateOpen(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const lines = (await redis("XREVRANGE", "cohost:events", "+", "-", "COUNT", "200")).split("\n");
    for (let i = 0; i + 8 < lines.length; i += 9) {
      if (lines[i + 2] === "brain.status") { if (!lines[i + 8]!.includes('"speaking"')) return; break; }
    }
    await sleep(1000);
  }
}
const chat = (text: string) => ({ platform: "twitch", user: "live_verify", text, mentionsCohost: true });

// @spec MOD-TEST-007
test("every unit of the isolated stack answers its declared input", { skip, timeout: 900_000 }, async () => {
  const dash: ChildProcess = spawn(process.execPath, [join(root, "services/dashboard/dist/index.js")], { env, cwd: root, stdio: "ignore" });
  let launchedHere = false;
  try {
    for (let i = 0; ; i++) {
      assert.ok(i < 60, "the dashboard did not come up");
      if (await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) break;
      await sleep(1000);
    }
    // /health answers before the controller has its first snapshot: wait until /stack answers too.
    for (let i = 0; ; i++) {
      assert.ok(i < 60, "the dashboard's /stack did not answer");
      if ((await api("GET", "/stack").catch(() => ({ status: 0 }))).status === 200) break;
      await sleep(1000);
    }
    const stack0 = (await api("GET", "/stack")).json;
    if (stack0.state !== "up") {
      launchedHere = true;
      let status = 0;
      for (let i = 0; i < 30 && status !== 202; i++) {
        status = (await api("POST", "/stack/launch")).status;
        if (status !== 202) await sleep(2000);
      }
      assert.equal(status, 202, "the stack launch was not accepted");
      for (let i = 0; ; i++) {
        assert.ok(i < 120, "the stack did not reach up");
        const s = (await api("GET", "/stack")).json;
        if (s.state === "up" && !s.action) break;
        await sleep(5000);
      }
    }
    // every unit up before injecting
    for (let i = 0; ; i++) {
      const states: Record<string, string> = Object.fromEntries((await api("GET", "/services")).json.services.map((s: any) => [s.service, s.state]));
      const bad = Object.entries(states).filter(([, st]) => st !== "up");
      if (bad.length === 0) break;
      assert.ok(i < 60, `units not up: ${bad.map((b) => b.join("=")).join(", ")}`);
      await sleep(3000);
    }

    const cases: { unit: string; send: () => Promise<{ status: number; json: any }>; types: string[]; pred?: (d: string) => boolean }[] = [
      { unit: "chat", send: () => api("POST", "/inject/text", { level: "service", text: "live verify chat", user: "live_verify" }), types: ["inject.result"], pred: (d) => d.includes('"ok":true') },
      { unit: "eyes", send: () => api("POST", "/inject/image?level=service", PNG, { "content-type": "image/png" }), types: ["inject.result"], pred: (d) => d.includes('"ok":true') },
      { unit: "ears", send: () => api("POST", "/inject/audio?level=service", wav(), { "content-type": "audio/wav" }), types: ["inject.result"], pred: (d) => d.includes('"ok":true') },
      { unit: "salience", send: () => api("POST", "/inject/event", { unit: "salience", type: "chat.message", data: chat("hey Coco, salience check?") }), types: ["attention.focus"], pred: (d) => d.includes("salience check") },
      { unit: "affect", send: () => api("POST", "/inject/event", { unit: "affect", type: "chat.message", data: chat("this is awesome and amazing!!") }), types: ["affect.state"], pred: (d) => d.includes("live_verify") },
      { unit: "memory", send: () => api("POST", "/inject/event", { unit: "memory", type: "memory.recall.request", data: { id: "lv-recall", query: "live verify" } }), types: ["memory.recall.reply"], pred: (d) => d.includes("lv-recall") },
      { unit: "cortex", send: () => api("POST", "/inject/event", { unit: "cortex", type: "attention.focus", data: { reason: "mentioned", score: 0.9, focus: { kind: "chat", who: "live_verify", text: "hello cortex", mention: true } } }), types: ["brain.say"], pred: (d) => d.includes("\"injected\":true") },
      { unit: "voice", send: () => api("POST", "/inject/event", { unit: "voice", type: "brain.say", data: { id: "lv-voice", text: "voice verify", emotion: "happy" } }), types: ["voice.utterance"], pred: (d) => d.includes("lv-voice") },
      { unit: "mouth", send: () => api("POST", "/inject/event", { unit: "mouth", type: "brain.say", data: { id: "lv-mouth", text: "mouth verify", emotion: "happy" } }), types: ["voice.playing", "voice.done"], pred: (d) => d.includes("lv-mouth") },
      { unit: "avatar", send: () => api("POST", "/inject/event", { unit: "avatar", type: "affect.state", data: { valence: -0.8, arousal: 0.9, mood: "angry", cause: "live-verify" } }), types: ["avatar.state"], pred: (d) => d.includes('"emotion":"angry"') },
    ];
    // Each unit's injection is judged by its own answering event. A unit may legitimately drop one (cortex while its
    // speaking gate is closed, affect/avatar while a background tick overtakes it), so an injection is re-sent, each
    // attempt observed on its own for a bounded window, until the case's deadline; the case fails only when no attempt
    // in the deadline was answered. Cortex's gate is open once its status is not "speaking", so its retries wait for it.
    for (const c of cases) {
      const deadline = Date.now() + CASE_DEADLINE_MS;
      let hit: string[] = [];
      for (let a = 0; hit.length === 0 && (a === 0 || Date.now() < deadline); a++) {
        if (c.unit === "cortex") await waitSpeakingGateOpen(deadline);
        const since = await lastId();
        const r = await c.send();
        assert.equal(r.status, 202, `${c.unit}: injection answered ${r.status} ${JSON.stringify(r.json)}`);
        hit = await observe(since, c.types, c.pred, ATTEMPT_MS);
      }
      assert.ok(hit.length > 0, `${c.unit}: no ${c.types.join("/")} answered its injection within ${CASE_DEADLINE_MS / 1000} s`);
    }
  } finally {
    dash.kill();
    if (launchedHere && docker.ok) await sh(["compose", "stop"]).catch(() => undefined);
  }
});
