import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, renderApp, screen, userEvent, waitFor } from "./helpers/render";
import { RecoveryKeyBanner } from "../../ui/src/app/RecoveryKeyBanner";

const TITLE = "A recovery key was created and has not been saved";

function open(answer: unknown) {
  const app = makeApp();
  app.fetch.on("GET /recovery", { json: answer });
  renderApp(<RecoveryKeyBanner />, app);
  return app;
}

// @spec DASH-RCV-029
test("the banner shows while the store says the recovery key is unconfirmed, naming the command that prints it and never a key", async () => {
  const app = open({ active: false, recoveryKeyUnconfirmed: true });
  await screen.findByText(TITLE);
  assert.match(document.body.textContent ?? "", /mise run config:key -- --show/);
  assert.doesNotMatch(document.body.textContent ?? "", /cohost-key-1:/);
  assert.ok(screen.getByRole("button", { name: "I have saved it" }));
  assert.equal(app.fetch.callsTo("GET /recovery").length, 1);
});

// @spec DASH-RCV-029
test("no banner when the flag is not set, in recovery mode, or when the read fails", async () => {
  for (const answer of [{ active: false }, { active: true, cause: "missing-key", problems: [], backups: [], gated: true, recoveryKeyUnconfirmed: true }]) {
    const app = open(answer);
    await waitFor(() => assert.equal(app.fetch.callsTo("GET /recovery").length, 1));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(screen.queryByText(TITLE), null, JSON.stringify(answer));
    document.body.innerHTML = "";
  }
  const app = makeApp();
  app.fetch.on("GET /recovery", { status: 500, text: "boom" });
  renderApp(<RecoveryKeyBanner />, app);
  await waitFor(() => assert.equal(app.fetch.callsTo("GET /recovery").length, 1));
  assert.equal(screen.queryByText(TITLE), null);
});

// @spec DASH-RCV-029
test("I have saved it sends POST /recovery/key-confirmed with the token and hides the banner; a failure stays with its detail", async () => {
  const app = open({ active: false, recoveryKeyUnconfirmed: true });
  await screen.findByText(TITLE);
  app.fetch.on("POST /recovery/key-confirmed", { status: 500, json: { ok: false, detail: "the store is busy" } });
  await userEvent.click(screen.getByRole("button", { name: "I have saved it" }));
  assert.match((await screen.findByRole("alert")).textContent ?? "", /the store is busy/);
  assert.ok(screen.getByText(TITLE), "still shown");
  app.fetch.on("POST /recovery/key-confirmed", { status: 204 });
  await userEvent.click(screen.getByRole("button", { name: "I have saved it" }));
  await waitFor(() => assert.equal(screen.queryByText(TITLE), null));
  assert.equal(app.fetch.callsTo("POST /recovery/key-confirmed").length, 2);
});
