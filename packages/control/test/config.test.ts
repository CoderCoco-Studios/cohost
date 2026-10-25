import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerOk, loadControlConfig } from "../src/index.js";

test("disabled unless CONTROL_ENABLED=1", () => {
  assert.deepEqual(loadControlConfig({}), { enabled: false });
  assert.deepEqual(loadControlConfig({ CONTROL_ENABLED: "true", CONTROL_TOKEN: "x" }), { enabled: false });
});

test("enabled without a token fails fast naming CONTROL_TOKEN", () => {
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1" }), /CONTROL_TOKEN/);
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "  " }), /CONTROL_TOKEN/);
});

test("enabled defaults: loopback bind, compose runtime, not advanced", () => {
  const c = loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t" });
  assert.deepEqual(c, { enabled: true, token: "t", bind: "127.0.0.1", bindExplicit: false, runtime: "compose", advanced: false, processMode: "dev" });
});

test("overrides: CONTROL_BIND, CONTROL_RUNTIME, CONTROL_ADVANCED, CONTROL_PROCESS_MODE; bad values throw", () => {
  const c = loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t", CONTROL_BIND: "0.0.0.0", CONTROL_RUNTIME: "process", CONTROL_ADVANCED: "1", CONTROL_PROCESS_MODE: "start" });
  assert.deepEqual(c, { enabled: true, token: "t", bind: "0.0.0.0", bindExplicit: true, runtime: "process", advanced: true, processMode: "start" });
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t", CONTROL_RUNTIME: "k8s" }), /CONTROL_RUNTIME/);
  assert.throws(() => loadControlConfig({ CONTROL_ENABLED: "1", CONTROL_TOKEN: "t", CONTROL_PROCESS_MODE: "x" }), /CONTROL_PROCESS_MODE/);
});

test("bearerOk accepts only the exact token", () => {
  assert.equal(bearerOk("Bearer s3cret", "s3cret"), true);
  assert.equal(bearerOk("Bearer s3cret!", "s3cret"), false);
  assert.equal(bearerOk("Bearer ", "s3cret"), false);
  assert.equal(bearerOk("s3cret", "s3cret"), false);
  assert.equal(bearerOk("Basic s3cret", "s3cret"), false);
  assert.equal(bearerOk(undefined, "s3cret"), false);
  assert.equal(bearerOk("Bearer x", ""), false);
});
