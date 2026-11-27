import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerOk, isLoopback, loadControlConfig } from "../src/index.js";

const T = "0123456789abcdef0123456789abcdef";

// @spec CTRL-CONFIG-001
test("loadControlConfig reads no control token and no CONTROL_ENABLED: a token in the environment changes nothing", () => {
  for (const flag of [undefined, "0", "1", "false"]) {
    assert.deepEqual(loadControlConfig({ CONTROL_TOKEN: T, ...(flag !== undefined ? { CONTROL_ENABLED: flag } : {}) }), { advanced: false });
  }
  assert.deepEqual(loadControlConfig({}), { advanced: false });
});

// @spec CTRL-CONFIG-002
test("CONTROL_ADVANCED is set only by exactly 1; CONTROL_RUNTIME and CONTROL_PROCESS_MODE are ignored", () => {
  assert.deepEqual(loadControlConfig({ CONTROL_ADVANCED: "1", CONTROL_RUNTIME: "process", CONTROL_PROCESS_MODE: "bogus" }), { advanced: true });
  assert.deepEqual(loadControlConfig({ CONTROL_ADVANCED: "true" }), { advanced: false });
});

// @spec CTRL-CONFIG-002
test("isLoopback accepts exactly localhost, ::1 and an IPv4 literal in 127.0.0.0/8; a name starting with 127. is not loopback", () => {
  for (const h of ["localhost", "::1", "127.0.0.1", "127.0.0.2", "127.9.9.9", "127.255.255.255"]) assert.equal(isLoopback(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com", "127.example.com", "127.0.0.1.example.com", "127.0.0.256", "127.1", "localhost.example.com", "128.0.0.1"]) assert.equal(isLoopback(h), false, h);
});

// @spec CTRL-CONFIG-003
test("bearerOk hands only a non-empty Bearer value to the verifier, and answers what it answers", async () => {
  const seen: string[] = [];
  const verify = async (v: string): Promise<"ok" | "bad" | "busy"> => { seen.push(v); return v === T ? "ok" : v === "slow" ? "busy" : "bad"; };
  assert.equal(await bearerOk(`Bearer ${T}`, verify), "ok");
  assert.equal(await bearerOk(`Bearer ${T}!`, verify), "bad");
  assert.equal(await bearerOk("Bearer slow", verify), "busy");
  for (const h of ["Bearer ", "Bearer   ", T, `Basic ${T}`, undefined]) assert.equal(await bearerOk(h, verify), "bad", String(h));
  assert.deepEqual(seen, [T, `${T}!`, "slow"], "a malformed header never reaches the verifier");
  assert.equal(await bearerOk(`Bearer ${T}`, async () => "bad"), "bad", "no verifier in the store: every bearer is refused");
});

// @spec DASH-AVR-031
test("isLoopbackPeer takes a socket's remote address: ::1, 127.0.0.0/8 and their IPv4-mapped forms are loopback; a LAN address, mapped or not, is not", async () => {
  const { isLoopbackPeer } = await import("../src/index.js");
  for (const a of ["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1", "::FFFF:127.4.5.6"]) assert.equal(isLoopbackPeer(a), true, a);
  for (const a of ["192.168.1.5", "::ffff:192.168.1.5", "::", "::ffff:0.0.0.0", "127.evil.example", "::ffff:10.0.0.1", "fe80::1", undefined]) assert.equal(isLoopbackPeer(a), false, String(a));
});
