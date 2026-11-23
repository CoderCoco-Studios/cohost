import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Duplex } from "node:stream";
import { join_, relay, eventually } from "./relay-rig.js";
import { send } from "./models-rig.js";
import { addressKey, refuseUpgrade } from "../src/avatar-relay.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hardening of the relay's upgrade and close paths: refused raw sockets are absorbed and freed, an over-rate socket is
// terminated after its close handshake stalls, and the per-address cap compares addresses without the IPv4-mapped prefix.

/** A raw socket that records whether it was destroyed; `end` writes and finishes like a TCP socket would. */
function rawSocket(): Duplex & { wrote: string[] } {
  const wrote: string[] = [];
  const d = new Duplex({
    read() { /* nothing to read */ },
    write(chunk, _enc, cb) { wrote.push(String(chunk)); cb(); },
    final(cb) { cb(); },
  }) as Duplex & { wrote: string[] };
  d.wrote = wrote;
  return d;
}

// @spec DASH-AVR-002, DASH-AVR-003
test("a refused upgrade writes its response, frees its socket once written, and absorbs a reset while it is written", async () => {
  const s = rawSocket();
  refuseUpgrade(s, "HTTP/1.1 503 Service Unavailable\r\n\r\n");
  s.emit("error", new Error("ECONNRESET")); // would be an uncaught exception without the listener
  await once(s, "close");
  assert.equal(s.destroyed, true, "the refused socket is freed");
  assert.deepEqual(s.wrote, ["HTTP/1.1 503 Service Unavailable\r\n\r\n"]);
});

// @spec DASH-AVR-002
test("the listeners survive a reset of raw upgrade sockets that are refused: nothing is thrown and the full surface still answers", async (t) => {
  const r = await relay(t);
  for (let i = 0; i < 10; i++) {
    const c = net.connect(r.port, "127.0.0.1");
    await once(c, "connect");
    c.write("GET /avatar/ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://evil.example\r\n\r\n");
    c.resetAndDestroy();
  }
  await new Promise((res) => setTimeout(res, 50));
  assert.equal((await r.get("/avatar/renderer")).status, 200);
});

// @spec DASH-AVR-033
test("an over-rate socket whose close handshake stalls is terminated one second later on the injected clock", async (t) => {
  const r = await relay(t);
  // Counts the server's terminate calls: a close that is answered would end the socket without one.
  const orig = WebSocket.prototype.terminate;
  let terminated = 0;
  WebSocket.prototype.terminate = function (this: WebSocket) { terminated++; return orig.call(this); };
  t.after(() => { WebSocket.prototype.terminate = orig; });
  const c = await join_(r.port);
  const sock = (c.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
  sock.pause(); // the client stops reading, so it cannot answer the close frame
  for (let i = 0; i < 21; i++) c.send("x");
  await eventually(async () => (await r.renderer()).pages.length === 0, "the over-rate socket left the relay");
  r.clock.advance(999);
  assert.equal(terminated, 0, "not yet terminated at 999 ms");
  r.clock.advance(1);
  assert.equal(terminated, 1, "terminated one second after the close");
  sock.resume();
  await once(c.ws, "close");
  assert.equal(c.closed, true);
});

// @spec DASH-AVR-032
test("a peer address is compared without its IPv4-mapped prefix and without case", () => {
  assert.equal(addressKey("::ffff:192.168.1.5"), "192.168.1.5");
  assert.equal(addressKey("192.168.1.5"), "192.168.1.5");
  assert.equal(addressKey("::FFFF:192.168.1.5"), "192.168.1.5");
  assert.equal(addressKey("FE80::1"), "fe80::1");
  assert.equal(addressKey(undefined), undefined);
});

// @spec DASH-AVP-001
test("the 503 'not built' page answers nosniff and a policy that allows only its inline style", async (t) => {
  const ui = mkdtempSync(join(tmpdir(), "cohost-avatar-ui-"));
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>x</title>");
  const r = await relay(t, { uiDir: ui });
  const x = await send(r.port, "GET", "/avatar");
  assert.equal(x.status, 503);
  assert.equal(x.headers["x-content-type-options"], "nosniff");
  assert.equal(x.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
});
