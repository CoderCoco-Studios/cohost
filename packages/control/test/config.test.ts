import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { bearerOk, EARS_LISTENER_LABEL, earsListenerKey, isLoopback, loadControlConfig } from "../src/index.js";

const T = "0123456789abcdef0123456789abcdef"; // 32 characters, the shortest token accepted

// @spec CTRL-CONFIG-001
test("CONTROL_TOKEN is always required: unset, empty, whitespace-only or under 32 characters after trimming throws naming it, never the value", () => {
  for (const env of [{}, { CONTROL_TOKEN: "" }, { CONTROL_TOKEN: "   " }, { CONTROL_TOKEN: "short-secret-value" }, { CONTROL_TOKEN: ` ${T.slice(1)} ` }]) {
    assert.throws(() => loadControlConfig(env), (err: Error) => {
      assert.match(err.message, /CONTROL_TOKEN/);
      assert.match(err.message, /at least 32 characters/);
      assert.match(err.message, /openssl rand -hex 24/);
      const v = (env as { CONTROL_TOKEN?: string }).CONTROL_TOKEN?.trim();
      if (v) assert.ok(!err.message.includes(v), "the value is never in the message");
      return true;
    }, JSON.stringify(env));
  }
});

// @spec CTRL-CONFIG-001
test("CONTROL_ENABLED is not read: a valid token loads whatever it says, and no value switches control off", () => {
  for (const flag of [undefined, "0", "1", "false"]) {
    assert.deepEqual(loadControlConfig({ CONTROL_TOKEN: T, ...(flag !== undefined ? { CONTROL_ENABLED: flag } : {}) }), { token: T, advanced: false });
  }
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1" }), /CONTROL_TOKEN/);
});

// @spec CTRL-CONFIG-001
test("the token is carried trimmed", () => {
  assert.deepEqual(loadControlConfig({ CONTROL_TOKEN: `  ${T}\t` }), { token: T, advanced: false });
});

// @spec CTRL-CONFIG-002
test("defaults: not advanced, no listen address, no runtime selection", () => {
  assert.deepEqual(loadControlConfig({ CONTROL_TOKEN: T }), { token: T, advanced: false });
});

// @spec CTRL-CONFIG-002
test("CONTROL_ADVANCED is set only by exactly 1; CONTROL_RUNTIME and CONTROL_PROCESS_MODE are ignored", () => {
  const c = loadControlConfig({ CONTROL_TOKEN: T, CONTROL_ADVANCED: "1", CONTROL_RUNTIME: "process", CONTROL_PROCESS_MODE: "bogus" });
  assert.deepEqual(c, { token: T, advanced: true });
  assert.deepEqual(loadControlConfig({ CONTROL_TOKEN: T, CONTROL_ADVANCED: "true" }), { token: T, advanced: false });
});

// @spec CTRL-RUNTIME-017
test("the ears listener key is HMAC-SHA256 keyed with the trimmed token of cohost/ears-listener/v1, as 64 lowercase hex digits", () => {
  assert.equal(EARS_LISTENER_LABEL, "cohost/ears-listener/v1");
  const want = createHmac("sha256", T).update("cohost/ears-listener/v1").digest("hex");
  assert.equal(earsListenerKey(T), want);
  assert.equal(earsListenerKey(` ${T}\n`), want, "derived from the trimmed token");
  assert.match(want, /^[0-9a-f]{64}$/);
  assert.notEqual(earsListenerKey(T), earsListenerKey(T.replace("0", "1")));
});

// @spec CTRL-CONFIG-002
test("isLoopback accepts exactly localhost, ::1 and an IPv4 literal in 127.0.0.0/8; a name starting with 127. is not loopback", () => {
  for (const h of ["localhost", "::1", "127.0.0.1", "127.0.0.2", "127.9.9.9", "127.255.255.255"]) assert.equal(isLoopback(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com", "127.example.com", "127.0.0.1.example.com", "127.0.0.256", "127.1", "localhost.example.com", "128.0.0.1"]) assert.equal(isLoopback(h), false, h);
});

// @spec CTRL-CONFIG-003
test("bearerOk accepts only the exact token", () => {
  assert.equal(bearerOk("Bearer s3cret", "s3cret"), true);
  assert.equal(bearerOk("Bearer s3cret!", "s3cret"), false);
  assert.equal(bearerOk("Bearer ", "s3cret"), false);
  assert.equal(bearerOk("s3cret", "s3cret"), false);
  assert.equal(bearerOk("Basic s3cret", "s3cret"), false);
  assert.equal(bearerOk(undefined, "s3cret"), false);
  assert.equal(bearerOk("Bearer x", ""), false);
});

// @spec DASH-AVR-031
test("isLoopbackPeer takes a socket's remote address: ::1, 127.0.0.0/8 and their IPv4-mapped forms are loopback; a LAN address, mapped or not, is not", async () => {
  const { isLoopbackPeer } = await import("../src/index.js");
  for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::FFFF:127.4.5.6"]) assert.equal(isLoopbackPeer(a), true, a);
  for (const a of ["192.168.1.5", "::ffff:192.168.1.5", "::", "::ffff:0.0.0.0", "127.evil.example", "::ffff:10.0.0.1", "fe80::1", undefined]) assert.equal(isLoopbackPeer(a), false, String(a));
});
