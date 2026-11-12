import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBus, recordingLog } from "@cohost/testing";
import { wavWrap } from "@cohost/shared";
import { ClipCache, ClipMirror, refreshClips } from "../../mouth/src/clips.js";
import { ClipService } from "../src/clips.js";
import { Voice } from "../src/voice.js";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "voice-mouth-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const settings = { model: "kokoro", voice: "af_heart", speed: 1, response_format: "wav" };
const wav = (text: string) => {
  const pcm = Buffer.alloc(24000 * 2 * 0.3); // 300 ms
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(100 + text.length, i);
  return wavWrap(pcm, 24000, 1);
};

/** voice's real clip service and HTTP routes, read by mouth' real clip-sync code. */
test("voice's manifest and clip routes are accepted by mouth's clip sync: replace, unchanged, regenerate, empty", async () => {
  // @spec VOICE-CLIP-009, VOICE-CLIP-011, VOICE-CLIP-012
  const store = tmp();
  const log = recordingLog();
  const make = (lines: string[]) => new ClipService({ dir: store, lines, engine: "kokoro", settings, synth: async (t) => wav(t), log: log.log });
  let svc = make(["Error: unable to play line.", "Buffering. Buffering. Nope."]);
  const routes = { manifest: () => svc.manifest(), clipBytes: (name: string) => svc.clipBytes(name) };
  const voice = new Voice({ bus: new FakeBus(), log: log.log, synth: async () => wav("x"), publicUrl: "http://x", clips: routes });
  const server = http.createServer(voice.handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cache = new ClipCache();
    const mirror = new ClipMirror(join(tmp(), "mouth", "fallback-clips"));
    const mouth = { baseUrl, cache, mirror, log: log.log as never };

    assert.equal(await refreshClips(mouth), "kept", "no set committed yet: voice answers 404 and mouth keeps its cache");
    await svc.start();
    assert.equal(await refreshClips(mouth), "replaced");
    assert.deepEqual(cache.clips.map((c) => c.text), ["Error: unable to play line.", "Buffering. Buffering. Nope."]);
    assert.deepEqual(cache.clips[0]!.wav, wav("Error: unable to play line."));
    assert.equal(cache.fingerprint, svc.fingerprint);
    assert.equal(await refreshClips(mouth), "unchanged");

    svc = make(["Brand new line."]);
    await svc.start();
    assert.equal(await refreshClips(mouth), "replaced");
    assert.deepEqual(cache.clips.map((c) => c.text), ["Brand new line."]);

    svc = make([]);
    await svc.start();
    assert.equal(await refreshClips(mouth), "replaced");
    assert.deepEqual(cache.clips, [], "an empty list empties mouth' cache");
    assert.equal((await mirror.load())?.clips.length, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
