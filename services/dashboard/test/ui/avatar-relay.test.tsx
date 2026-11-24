// The renderer's model reports to the relay (DASH-AVP-039, DASH-AVP-040): a preview sends none, a normal page sends each
// one and sends the last one again on a reconnect. Pure: the send is a recording stand-in (ui/src/avatar/relay.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelRelay } from "../../ui/src/avatar/relay";

// @spec DASH-AVP-039
test("a preview page sends no model report to the relay, and no resend", () => {
  const sent: unknown[] = [];
  const relay = createModelRelay({ preview: true, send: (m) => sent.push(m) });
  relay.report({ version: "draft:a.vrm", state: "loading", detail: "" });
  relay.report({ version: "draft:a.vrm", state: "failed", detail: "HTTP 404" });
  relay.resend();
  assert.deepEqual(sent, []);
});

// @spec DASH-AVP-039
test("a normal (loopback owner) page sends each model report as one relay message with its version, state and detail", () => {
  const sent: unknown[] = [];
  const relay = createModelRelay({ preview: false, send: (m) => sent.push(m) });
  relay.report({ version: "v1", state: "loading", detail: "" });
  relay.report({ version: "v1", state: "ready", detail: "" });
  assert.deepEqual(sent, [
    { type: "model", version: "v1", state: "loading", detail: "" },
    { type: "model", version: "v1", state: "ready", detail: "" },
  ]);
});

// @spec DASH-AVP-040
test("after a reconnect the page sends its last model report again, and nothing when it has none", () => {
  const sent: unknown[] = [];
  const relay = createModelRelay({ preview: false, send: (m) => sent.push(m) });
  relay.resend();
  assert.deepEqual(sent, [], "no report yet: nothing to send");
  relay.report({ version: "v1", state: "ready", detail: "" });
  relay.resend();
  assert.deepEqual(sent.at(-1), { type: "model", version: "v1", state: "ready", detail: "" });
  assert.equal(sent.length, 2);
});

// @spec DASH-AVP-040
test("a failed model is reported again on a reconnect with its reason, not fetched again by the relay", () => {
  const sent: unknown[] = [];
  const relay = createModelRelay({ preview: false, send: (m) => sent.push(m) });
  relay.report({ version: "v2", state: "failed", detail: "HTTP 404" });
  relay.resend();
  assert.deepEqual(sent.at(-1), { type: "model", version: "v2", state: "failed", detail: "HTTP 404" });
});
