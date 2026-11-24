// The renderer's model reports to the relay (DASH-AVP-039): a preview sends none, a normal page sends each one. Pure: the
// send is a recording stand-in. Failing-first step of issue #218 follow-up: the module is ui/src/avatar/relay.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelRelay } from "../../ui/src/avatar/relay";

// @spec DASH-AVP-039
test("a preview page sends no model report to the relay", () => {
  const sent: unknown[] = [];
  const report = createModelRelay({ preview: true, send: (m) => sent.push(m) });
  report({ version: "draft:a.vrm", state: "loading", detail: "" });
  report({ version: "draft:a.vrm", state: "failed", detail: "HTTP 404" });
  assert.deepEqual(sent, []);
});

// @spec DASH-AVP-039
test("a normal (loopback owner) page sends each model report as one relay message with its version, state and detail", () => {
  const sent: unknown[] = [];
  const report = createModelRelay({ preview: false, send: (m) => sent.push(m) });
  report({ version: "v1", state: "loading", detail: "" });
  report({ version: "v1", state: "ready", detail: "" });
  assert.deepEqual(sent, [
    { type: "model", version: "v1", state: "loading", detail: "" },
    { type: "model", version: "v1", state: "ready", detail: "" },
  ]);
});
