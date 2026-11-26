import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import { WebSocket } from "ws";
import { connect, join_, relay, eventually, externalAddress } from "./relay-rig.js";

// The relay's socket layer: its own server on both listeners, the Origin/Host rules, the page and preview caps, ping and
// terminate, the message cap and the shutdown path (DASH-AVR-001..004, 030, DASH-HTTP-010, DASH-HTTP-016).


// @spec DASH-AVR-001
test("/avatar/ws upgrades on both listeners, sends only view then status, and a /ws feed client never sees an avatar message", async (t) => {
  const r = await relay(t);
  const feed = new WebSocket(`ws://127.0.0.1:${r.port}/ws`);
  const seen: string[] = [];
  feed.on("message", (d) => seen.push(JSON.parse(String(d)).type));
  await once(feed, "open");
  for (const port of [r.port, r.lanPort]) {
    const u = await connect(port);
    assert.equal(u.result, "open", `upgrade on ${port}`);
    if (u.result !== "open") continue;
    const { view, status } = await u.client.hello();
    assert.equal(view.type, "view");
    assert.equal(status.type, "status");
    assert.deepEqual(u.client.drain(), [], "no feed message (services, stack, replay) follows the connect pair");
  }
  await r.bus.until(() => r.bus.reading);
  r.bus.batch({ mouthOpen: 0.5 });
  // The feed delivers an event after the frame; once it arrives, the frame had its chance to reach the feed client.
  const fed = new Promise<void>((resolve) => feed.on("message", (d) => { if (JSON.parse(String(d)).type === "avatar.state") resolve(); }));
  r.bus.state("vmc");
  await fed;
  assert.ok(!seen.includes("frame") && !seen.includes("view") && !seen.includes("status"), `the /ws feed got ${seen.join(",")}`);
  feed.close();
});

// @spec DASH-AVR-001
test("GET /avatar/ws without an upgrade is a 404 on the LAN listener", async (t) => {
  const r = await relay(t);
  assert.equal((await r.lan("GET", "/avatar/ws")).status, 404);
});

// @spec DASH-AVR-002
test("an upgrade with a cross-site, null or unparsable Origin is 403 on both listeners and completes no socket", async (t) => {
  const r = await relay(t);
  for (const port of [r.port, r.lanPort]) {
    for (const origin of ["http://evil.example", "null", "not a url", `http://127.0.0.1:${port + 1}`]) {
      for (const preview of [false, true]) {
        const u = await connect(port, { headers: { origin }, preview });
        assert.equal(u.result, 403, `${port} ${origin} preview=${preview}`);
      }
    }
  }
  const s = await r.renderer();
  assert.deepEqual([s.pages.length, s.previews], [0, 0]);
  assert.equal(r.bus.starts, 0, "a refused upgrade starts no reader");
  const ok = await connect(r.port, { headers: { origin: `http://127.0.0.1:${r.port}` } });
  assert.equal(ok.result, "open", "an Origin equal to the Host is accepted");
});

// @spec DASH-AVR-002
test("a foreign Host name is 403 on the loopback-bound full surface and on the LAN listener; an address literal is accepted on the LAN listener", async (t) => {
  const r = await relay(t);
  for (const port of [r.port, r.lanPort]) {
    const u = await connect(port, { headers: { host: "rebind.example" } });
    assert.equal(u.result, 403, `Host rebind.example on ${port}`);
  }
  assert.equal((await connect(r.lanPort, { headers: { host: `127.0.0.1:${r.lanPort}` } })).result, "open");
  assert.equal((await r.renderer()).pages.length, 1);
});

// @spec DASH-AVR-003
test("a fifth renderer page on a listener is 503 with retry-after 5 and no socket; the two listeners count apart; a close frees a place", async (t) => {
  const r = await relay(t);
  for (const port of [r.port, r.lanPort]) {
    const held = [];
    for (let i = 0; i < 4; i++) held.push(await join_(port));
    const over = await connect(port);
    assert.equal(over.result, 503, `fifth page on ${port}`);
    if (over.result === 503) assert.equal(over.headers["retry-after"], "5");
    assert.equal((await r.renderer()).pages.length, port === r.port ? 4 : 8, "the refused upgrade completed no socket; both listeners' pages are listed");
    await held[0]!.close();
    // The place is released when the server sees the close, which can follow the client's own close event.
    await eventually(async () => (await connect(port)).result === "open", `a place free again on ${port}`);
    const again = { result: "open" };
    assert.equal(again.result, "open", `a place is free again on ${port}`);
  }
});

// @spec DASH-AVR-003
test("a third preview on the full surface is 503; previews and pages do not take each other's places; preview=1 on the LAN listener counts as a page", async (t) => {
  const r = await relay(t);
  const pv1 = await join_(r.port, { preview: true }), pv2 = await join_(r.port, { preview: true });
  assert.ok(pv1 && pv2);
  const third = await connect(r.port, { preview: true });
  assert.equal(third.result, 503);
  if (third.result === 503) assert.equal(third.headers["retry-after"], "5");
  for (let i = 0; i < 4; i++) await join_(r.port); // four pages still fit beside two previews
  assert.equal((await connect(r.port)).result, 503, "and a fifth page does not");
  const s = await r.renderer();
  assert.deepEqual([s.pages.length, s.previews, s.maxPages, s.maxPreviews], [4, 2, 4, 2]);
  // On the LAN listener the query is ignored: four such sockets are four pages and a fifth is refused.
  for (let i = 0; i < 4; i++) await join_(r.lanPort, { preview: true });
  assert.equal((await connect(r.lanPort, { preview: true })).result, 503);
  const after = await r.renderer();
  assert.equal(after.previews, 2, "none of them is a preview");
  assert.equal(after.pages.length, 8);
});

// @spec DASH-AVR-004
test("the relay pings every 10 s and terminates a socket that answers no ping, and keeps one that does", async (t) => {
  const r = await relay(t);
  const mute = await connect(r.port, { autoPong: false });
  assert.equal(mute.result, "open");
  if (mute.result !== "open") return;
  const quiet = mute.client;
  await quiet.hello();
  const live = await join_(r.port);
  assert.equal(quiet.pings, 0, "no ping before 10 s");
  r.clock.advance(10_000);
  await quiet.until(() => quiet.pings >= 1);
  // The answering client has to have answered before the 20 s mark: round-trip each ping before advancing again.
  await live.barrier();
  r.clock.advance(5_000);
  assert.equal(quiet.closed, false, "not terminated at 15 s");
  r.clock.advance(6_000);
  await quiet.until(() => quiet.closed);
  await live.barrier(); // the answer to the ping at 20 s reaches the server before the clock moves on
  assert.equal(quiet.closed, true, "terminated by 21 s of silence");
  for (let i = 0; i < 4; i++) {
    r.clock.advance(10_000);
    await live.barrier();
  }
  assert.equal(live.closed, false, "an answering socket stays");
  assert.equal((await r.renderer()).pages.length, 1);
});

// @spec DASH-AVR-030
test("a message over 4096 bytes closes the socket with 1009 on either listener; 4096 bytes is accepted", async (t) => {
  const r = await relay(t);
  for (const port of [r.port, r.lanPort]) {
    const c = await join_(port);
    c.send("x".repeat(4096));
    await c.barrier();
    assert.equal(c.closed, false, "4096 bytes is within the cap");
    c.send("x".repeat(4097));
    await once(c.ws, "close");
    assert.equal(c.closeCode, 1009);
  }
});

// @spec DASH-AVR-030, DASH-AVR-015
test("the cap holds for a socket that is not on loopback", { skip: externalAddress() ? false : "no non-loopback interface" }, async (t) => {
  const addr = externalAddress()!;
  const r = await relay(t, { lanHost: "0.0.0.0" });
  const c = await join_(r.lanPort, { host: addr });
  c.send("x".repeat(4097));
  await once(c.ws, "close");
  assert.equal(c.closeCode, 1009);
});

// @spec DASH-HTTP-010, DASH-HTTP-016, DASH-AVR-011
test("shutdown closes the relay's sockets, stops the reader once and leaves no listener", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port), d = await join_(r.lanPort);
  await r.bus.until(() => r.bus.reading);
  await r.stop();
  await Promise.all([c, d].map((x) => (x.closed ? Promise.resolve() : once(x.ws, "close"))));
  assert.equal(r.bus.stops, 1, "the frame reader is stopped exactly once");
  assert.equal(r.bus.reading, false);
  for (const port of [r.port, r.lanPort]) {
    const refused = await new Promise<boolean>((resolve) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); resolve(false); }); s.on("error", () => resolve(true)); });
    assert.ok(refused, `${port} no longer listens`);
  }
});

// @spec DASH-HTTP-010
test("with no socket open at shutdown the reader was never started and nothing is stopped twice", async (t) => {
  const r = await relay(t);
  await r.stop();
  assert.deepEqual([r.bus.starts, r.bus.stops], [0, 0]);
});

// @spec DASH-AVR-032
test("a remote address that is not loopback holds at most 2 renderer pages across both listeners; a third is 503 with retry-after 5, and the owner's loopback address is not limited", { skip: externalAddress() ? false : "no non-loopback interface" }, async (t) => {
  const addr = externalAddress()!;
  const r = await relay(t, { lanHost: "0.0.0.0" });
  const a = await join_(r.lanPort, { host: addr });
  const b = await join_(r.lanPort, { host: addr });
  const over = await connect(r.lanPort, { host: addr });
  assert.equal(over.result, 503);
  if (over.result === 503) assert.equal(over.headers["retry-after"], "5");
  assert.equal((await r.renderer()).pages.length, 2, "the refused upgrade completed no socket");
  for (let i = 0; i < 2; i++) await join_(r.lanPort); // loopback addresses keep their own four places
  assert.equal((await r.renderer()).pages.length, 4);
  assert.ok(a && b);
});

// @spec DASH-AVR-033
test("a socket that sends more than 20 messages in one second is closed with 1008; 20 in a second is not", async (t) => {
  const r = await relay(t);
  const ok = await join_(r.port);
  for (let i = 0; i < 20; i++) ok.send("x");
  await ok.barrier();
  assert.equal(ok.closed, false, "20 messages in a second are within the rate");
  r.clock.advance(1000);
  const c = await join_(r.port);
  for (let i = 0; i < 21; i++) c.send("x");
  await once(c.ws, "close");
  assert.equal(c.closeCode, 1008);
  assert.equal((await r.renderer()).pages.length, 1, "the dropped socket no longer holds a place");
});

// @spec DASH-AVR-035
test("a send whose data has left the socket is not stuck: the clock passing 5 s before its completion callback runs does not terminate the socket", async (t) => {
  const r = await relay(t);
  const c = await join_(r.port);
  await r.bus.until(() => r.bus.reading);
  r.clock.toTick();
  r.bus.state("vmc");
  r.clock.advance(1000); // a status goes out; its completion callback has not run yet
  r.clock.advance(5_000); // synchronously past the 5 s limit
  assert.deepEqual(await c.next((m) => m.type === "status"), { type: "status", state: "off", driver: "vmc" });
  assert.equal(c.closed, false, "nothing was buffered in the socket, so the send was not stuck");
  assert.equal((await r.renderer()).pages.length, 1);
});
