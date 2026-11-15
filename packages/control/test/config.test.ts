import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerOk, isLoopback, loadControlConfig } from "../src/index.js";

// @spec CTRL-CONFIG-001
test("disabled unless CONTROL_ENABLED=1", () => {
  assert.deepEqual(loadControlConfig({}), { enabled: false });
  assert.deepEqual(loadControlConfig({ CONTROL_ENABLED: "true", CONTROL_TOKEN: "x" }), { enabled: false });
});

// @spec CTRL-CONFIG-001
test("enabled without a token fails fast naming CONTROL_TOKEN", () => {
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1" }), /CONTROL_TOKEN/);
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "  " }), /CONTROL_TOKEN/);
});

// @spec CTRL-CONFIG-002
test("enabled defaults: not advanced, no listen address, no runtime selection", () => {
  const c = loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t" });
  assert.deepEqual(c, { enabled: true, token: "t", advanced: false });
});

// @spec CTRL-CONFIG-002
test("CONTROL_ADVANCED is set only by exactly 1; CONTROL_RUNTIME and CONTROL_PROCESS_MODE are ignored", () => {
  const c = loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t", CONTROL_ADVANCED: "1", CONTROL_RUNTIME: "process", CONTROL_PROCESS_MODE: "bogus" });
  assert.deepEqual(c, { enabled: true, token: "t", advanced: true });
  assert.deepEqual(loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t", CONTROL_ADVANCED: "true" }), { enabled: true, token: "t", advanced: false });
});

// @spec CTRL-CONFIG-002
test("isLoopback accepts localhost, ::1 and 127.x only", () => {
  for (const h of ["localhost", "::1", "127.0.0.1", "127.9.9.9"]) assert.equal(isLoopback(h), true, h);
  for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) assert.equal(isLoopback(h), false, h);
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
