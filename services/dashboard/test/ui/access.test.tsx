import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccess } from "../../ui/src/state/access";
import { FakeStorage } from "./helpers/fakes";

const mk = (o: { local?: Storage; session?: Storage } = {}) => {
  const local = o.local ?? new FakeStorage(), session = o.session ?? new FakeStorage();
  const events = new EventTarget();
  return { local, session, events, access: createAccess({ local, session, events }) };
};

// @spec DASH-ACC-007
test("the token is kept per tab by default (sessionStorage) and per browser on request (localStorage), under its own key", () => {
  const { access, local, session } = mk();
  access.setToken("control", "c1", "tab");
  assert.equal(session.getItem("cohost.controlToken"), "c1");
  assert.equal(local.getItem("cohost.controlToken"), null);
  assert.equal(access.getToken("control"), "c1");
  assert.deepEqual(access.state.get().control, { present: true, scope: "tab" });
  access.setToken("control", "c2", "browser");
  assert.equal(local.getItem("cohost.controlToken"), "c2");
  assert.equal(session.getItem("cohost.controlToken"), null);
  assert.deepEqual(access.state.get().control, { present: true, scope: "browser" });
  assert.equal("viewers" in access.state.get(), false, "one token");
});

// @spec DASH-ACC-007
test("a token written to one scope leaves the other storage, and a fresh page reads the stored token back", () => {
  const { access, local, session } = mk();
  access.setToken("control", "c1", "tab");
  access.setToken("control", "c2", "browser");
  assert.equal(session.getItem("cohost.controlToken"), null);
  assert.equal(local.getItem("cohost.controlToken"), "c2");
  const again = createAccess({ local, session, events: new EventTarget() });
  assert.equal(again.getToken("control"), "c2");
  assert.equal(again.state.get().control.scope, "browser");
});

// @spec DASH-ACC-007
test("lock removes the token from both storages and memory", () => {
  const { access, local, session } = mk();
  access.setToken("control", "c1", "browser");
  session.setItem("cohost.controlToken", "stale");
  access.lock("control");
  assert.equal(local.getItem("cohost.controlToken"), null);
  assert.equal(session.getItem("cohost.controlToken"), null);
  assert.equal(access.getToken("control"), undefined);
  assert.equal(access.state.get().control.present, false);
});

// @spec DASH-ACC-007
test("a storage event from another tab that removes or changes a token updates this tab", () => {
  const { access, local, events } = mk();
  access.setToken("control", "c1", "browser");
  local.setItem("cohost.controlToken", "c2");
  events.dispatchEvent(Object.assign(new Event("storage"), { key: "cohost.controlToken" }));
  assert.equal(access.getToken("control"), "c2");
  local.removeItem("cohost.controlToken");
  events.dispatchEvent(Object.assign(new Event("storage"), { key: "cohost.controlToken" }));
  assert.equal(access.getToken("control"), undefined);
  assert.equal(access.state.get().control.present, false);
  // clear() fires the event with a null key
  access.setToken("control", "v", "browser");
  local.clear();
  events.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
  assert.equal(access.getToken("control"), undefined);
});

// @spec DASH-ACC-007
test("when storage throws, the token lives in memory for the page's life and the state says so", () => {
  const { access } = mk({ local: FakeStorage.throwing(), session: FakeStorage.throwing() });
  access.setToken("control", "c1", "tab");
  assert.equal(access.getToken("control"), "c1");
  assert.equal(access.state.get().memoryOnly, true);
  access.lock("control");
  assert.equal(access.getToken("control"), undefined);
});

// @spec DASH-ACC-012
test("the token never appears in the store's state", () => {
  const { access } = mk();
  access.setToken("control", "super-secret-token", "tab");
  assert.ok(!JSON.stringify(access.state.get()).includes("super-secret-token"));
});

// @spec DASH-UI-006, DASH-ACC-002
test("ask opens one prompt naming the waiting action and resolves true when it is unlocked", async () => {
  const { access } = mk();
  const waiting = access.ask("control", "Restart voice");
  assert.deepEqual({ ...access.state.get().prompt, resolve: undefined }, { kind: "control", action: "Restart voice", rejected: false, resolve: undefined });
  access.setToken("control", "c", "tab");
  access.resolvePrompt(true);
  assert.equal(await waiting, true);
  assert.equal(access.state.get().prompt, null);
});

// @spec DASH-UI-006, DASH-ACC-002
test("cancelling the prompt resolves false", async () => {
  const { access } = mk();
  const waiting = access.ask("control", "Load viewers");
  access.resolvePrompt(false);
  assert.equal(await waiting, false);
  assert.equal(access.state.get().prompt, null);
});

// @spec DASH-UI-006
test("requests waiting on the token share one prompt, a viewers request included", async () => {
  const { access } = mk();
  const a = access.ask("control", "Mute");
  const b = access.ask("control", "Say");
  const c = access.ask("control", "Load viewers");
  assert.equal(access.state.get().prompt?.action, "Mute");
  access.resolvePrompt(true);
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.equal(access.state.get().prompt, null);
});

// @spec DASH-ACC-006
test("a prompt opened because the server rejected a stored token carries the rejection", async () => {
  const { access } = mk();
  const waiting = access.ask("control", "Save", { rejected: true });
  assert.equal(access.state.get().prompt?.rejected, true);
  access.resolvePrompt(false);
  await waiting;
});

// @spec DASH-ACC-001, DASH-ACC-008
test("the Access panel opens and closes through the store; the token's state is only whether it is held and where", () => {
  const { access } = mk();
  access.openPanel();
  assert.equal(access.state.get().panelOpen, true);
  access.closePanel();
  assert.equal(access.state.get().panelOpen, false);
  assert.deepEqual(access.state.get().control, { present: false, scope: null });
  access.setToken("control", "t", "tab");
  assert.deepEqual(access.state.get().control, { present: true, scope: "tab" });
  access.lock("control");
  assert.deepEqual(access.state.get().control, { present: false, scope: null });
});
