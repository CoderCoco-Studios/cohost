import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { startListeners } from "../src/host.js";
import { ModelStore } from "../src/models.js";
import { model, MiB, rig } from "./models-rig.js";

// The transport under the model routes: a refusal before the body reads little of it (DASH-MDL-017), the full surface has no
// request timeout (DASH-MDL-023), and a commit that finds its name taken leaves the stored file alone (DASH-MDL-028).

// @spec DASH-MDL-017
test("a refusal before the body is answered with the connection closed, and the server takes in only what the socket buffers hold", async (t) => {
  const r = await rig(t, { control: true, seed: { "Aiko.vrm": model("a") } });
  const sock = net.connect(r.port, "127.0.0.1");
  sock.on("error", () => undefined);
  let answer = "";
  sock.on("data", (d: Buffer) => { answer += d.toString("latin1"); });
  let closed = false;
  sock.on("close", () => { closed = true; });
  const total = 64 * MiB;
  // The name is already stored, so the refusal (409) comes before any byte of the 64 MiB body.
  sock.write(`POST /avatar/models?name=Aiko.vrm HTTP/1.1\r\nhost: 127.0.0.1:${r.port}\r\nauthorization: Bearer tok\r\ncontent-length: ${total}\r\n\r\n`);
  let written = 0;
  const chunk = Buffer.alloc(256 * 1024);
  const pump = (async () => {
    while (!closed && written < total) {
      written += chunk.length;
      if (!sock.write(chunk)) await new Promise<void>((ok) => { sock.once("drain", ok); sock.once("close", ok); });
    }
  })();
  await new Promise((ok) => setTimeout(ok, 1500));
  sock.destroy();
  await pump;
  assert.match(answer, /^HTTP\/1\.1 409 /);
  assert.match(answer, /connection: close/i);
  assert.ok(written < 16 * MiB, `the client got ${(written / MiB).toFixed(1)} MiB into the socket: the server read no body beyond its buffers`);
});

// @spec DASH-MDL-023
test("the full-surface server has no request timeout (a slow body that keeps moving is cut only by the idle limit); the LAN listener keeps Node's", async () => {
  const wss = new WebSocketServer({ noServer: true });
  const quiet = { info() {}, warn() {}, fatal() {} };
  const l = await startListeners({
    handler: (_q, s) => { s.end("ok"); }, wss, bind: "127.0.0.1", port: 0, lanPort: 0, lanHost: "127.0.0.1",
    controlEnabled: false, log: quiet as never, exit: () => undefined,
  });
  assert.ok(l, "both listeners started");
  try {
    assert.equal(l.full.requestTimeout, 0);
    assert.equal(l.lan.requestTimeout, 300_000);
  } finally {
    await l.close();
    wss.close();
  }
});

// @spec DASH-MDL-028, DASH-MDL-019
test("a commit whose name is taken answers exists and leaves the stored file alone; with replace it renames over it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mdl-store-"));
  writeFileSync(join(dir, "Aiko.vrm"), "stored");
  const store = new ModelStore(dir);
  const tmp = await store.createTemp();
  await tmp.fh.close();
  writeFileSync(tmp.path, "new");
  assert.equal(await store.commit(tmp.path, join(dir, "Aiko.vrm"), false), "exists");
  assert.equal(readFileSync(join(dir, "Aiko.vrm"), "utf8"), "stored");
  assert.equal(await store.commit(tmp.path, join(dir, "Aiko.vrm"), true), "ok");
  assert.equal(readFileSync(join(dir, "Aiko.vrm"), "utf8"), "new");
});
