import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { startListeners } from "../src/host.js";
import { ModelStore } from "../src/models.js";
import { model, MiB, rig, send, TOKEN } from "./models-rig.js";

// The transport under the model routes: a refusal before the body reads little of it (DASH-MDL-017), the full surface has no
// request timeout (DASH-MDL-023), and a commit that finds its name taken leaves the stored file alone (DASH-MDL-028).

// @spec DASH-MDL-017
test("a refusal before the body is answered with the connection closed, and the server takes in only what the socket buffers hold", async (t) => {
  const r = await rig(t, { seed: { "Aiko.vrm": model("a") } });
  const sock = net.connect(r.port, "127.0.0.1");
  sock.on("error", () => undefined);
  let answer = "";
  sock.on("data", (d: Buffer) => { answer += d.toString("latin1"); });
  let closed = false;
  sock.on("close", () => { closed = true; });
  const total = 64 * MiB;
  // The name is already stored, so the refusal (409) comes before any byte of the 64 MiB body.
  sock.write(`POST /avatar/models?name=Aiko.vrm HTTP/1.1\r\nhost: 127.0.0.1:${r.port}\r\nauthorization: Bearer ${TOKEN}\r\ncontent-length: ${total}\r\n\r\n`);
  let written = 0;
  const chunk = Buffer.alloc(256 * 1024);
  const pump = (async () => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `closed` is set by the socket's close handler while the loop awaits drain
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
    log: quiet as never, exit: () => undefined,
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

// @spec DASH-MDL-004, DASH-MDL-021
test("no model file stays open after a served, 304, HEAD or aborted download (a handle left to the garbage collector is an error in Node 24)", async (t) => {
  const { readdirSync, readlinkSync } = await import("node:fs");
  const openIn = (dir: string): string[] => {
    const out: string[] = [];
    for (const fd of readdirSync("/proc/self/fd")) {
      try { const l = readlinkSync(`/proc/self/fd/${fd}`); if (l.startsWith(dir)) out.push(l); } catch { /* the descriptor closed meanwhile */ }
    }
    return out;
  };
  // Checked soon after each step: a leaked handle is closed by the garbage collector later, which hides it and raises the error.
  const settle = () => new Promise((ok) => setTimeout(ok, 100));
  const r = await rig(t, { seed: { "Big.vrm": model("big", 8 * MiB), "Aiko.vrm": model("a") }, renderer: { model: "Aiko.vrm" } });
  const first = await r.get("/avatar/model");
  assert.equal(first.status, 200);
  await settle();
  assert.deepEqual(openIn(r.models), [], "after a served model");
  await r.get("/avatar/model", { "if-none-match": first.headers["etag"] as string });
  await send(r.port, "HEAD", "/avatar/model");
  await settle();
  assert.deepEqual(openIn(r.models), [], "after a 304 and a HEAD");
  // A download the client leaves after its first bytes.
  await new Promise<void>((resolve) => {
    const sock = net.connect(r.port, "127.0.0.1", () => sock.write("GET /avatar/models/Big.vrm HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n"));
    sock.once("data", () => { sock.destroy(); resolve(); });
  });
  await settle();
  assert.deepEqual(openIn(r.models), [], "after a download the client left");
});

// @spec DASH-MDL-021
test("a client that drops an upload mid-body leaves no temporary file and no descriptor open", async (t) => {
  const { readdirSync, readlinkSync } = await import("node:fs");
  const r = await rig(t, {});
  await new Promise<void>((resolve) => {
    const sock = net.connect(r.port, "127.0.0.1", () => {
      sock.write(`POST /avatar/models?name=Drop.vrm HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: ${8 * MiB}\r\n\r\n`);
      sock.write(model("drop", 4096).subarray(0, 4096));
      setTimeout(() => { sock.destroy(); resolve(); }, 100);
    });
  });
  await new Promise((ok) => setTimeout(ok, 100));
  const open = readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(r.models); } catch { return false; } });
  assert.deepEqual(open, [], "no descriptor into the model folder");
  assert.deepEqual(r.ls(), [], "the dropped upload left no temporary file");
});
