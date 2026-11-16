import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrictMode, useState } from "react";
import { act, render, renderApp, makeApp, screen, userEvent } from "./helpers/render";
import { Dialog, ConfirmDialog, topModal } from "../../ui/src/components/Dialog";
import { SideSheet } from "../../ui/src/components/SideSheet";
import { AccessDialog } from "../../ui/src/app/AccessDialog";

/**
 * A browser queues the `close` event of `close()` as a task: it fires after the code that called `close()` has gone on
 * (React's development double run calls `showModal()` again before it). happy-dom fires the event inside `close()`, so
 * this test file makes it a queued task too, the way Chrome orders it.
 */
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
  const wasOpen = this.open;
  this.removeAttribute("open");
  if (wasOpen) setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  void returnValue;
};

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

function Host({ sheet }: { sheet?: boolean }) {
  const [open, setOpen] = useState(false);
  const C = sheet ? SideSheet : Dialog;
  return (<>
    <button onClick={() => setOpen(true)}>Open</button>
    <C open={open} title="T" onClose={() => setOpen(false)}><input aria-label="Field" /></C>
  </>);
}

// @spec DASH-A11Y-005
test("in StrictMode (development: setup, cleanup, setup) a dialog and a side sheet stay open after the queued close event", async () => {
  for (const sheet of [false, true]) {
    const user = userEvent.setup();
    const { unmount } = render(<StrictMode><Host sheet={sheet} /></StrictMode>);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await flush();
    const dlg = screen.getByRole("dialog", { name: "T" }) as HTMLDialogElement;
    assert.equal(dlg.open, true, "the dialog is open");
    assert.ok(dlg.contains(document.activeElement), "focus is inside the dialog");
    assert.ok(topModal() === dlg, "the open dialog is the registered top modal");
    unmount();
  }
});

// @spec DASH-A11Y-005
test("a close event that arrives while the dialog is open is stale and is ignored", async () => {
  let closed = 0;
  render(<Dialog open title="T" onClose={() => { closed++; }}><p>x</p></Dialog>);
  const dlg = screen.getByRole("dialog") as HTMLDialogElement;
  act(() => { dlg.dispatchEvent(new Event("close")); });
  assert.equal(dlg.open, true);
  assert.equal(closed, 0, "onClose was not called for a close event of an open dialog");
});

// @spec DASH-A11Y-005
test("a close event of a dialog the browser really closed reaches the host", async () => {
  let closed = 0;
  render(<Dialog open title="T" onClose={() => { closed++; }}><p>x</p></Dialog>);
  const dlg = screen.getByRole("dialog") as HTMLDialogElement;
  act(() => { dlg.removeAttribute("open"); dlg.dispatchEvent(new Event("close")); });
  assert.equal(closed, 1);
});

// @spec DASH-A11Y-005
test("in StrictMode, closing a dialog returns focus to the opener and removes it from the registry of open dialogs", async () => {
  const user = userEvent.setup();
  render(<StrictMode><Host /></StrictMode>);
  const opener = screen.getByRole("button", { name: "Open" });
  await user.click(opener);
  await flush();
  await user.click(screen.getByRole("button", { name: "Close" }));
  await flush();
  assert.ok(screen.queryByRole("dialog") === null, "closed");
  assert.ok(document.activeElement === opener, "focus is back on the opener");
  assert.ok(topModal() === undefined, "no dialog is registered as open");
});

// @spec DASH-A11Y-005
test("in StrictMode a ConfirmDialog stays open until answered", async () => {
  function C() { const [open, setOpen] = useState(true); return <ConfirmDialog open={open} title="Sure?" confirmLabel="Yes" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>x</ConfirmDialog>; }
  render(<StrictMode><C /></StrictMode>);
  await flush();
  assert.ok(screen.getByRole("dialog", { name: "Sure?" }));
});

// @spec DASH-ACC-011, DASH-A11Y-005
test("in StrictMode the Access dialog (prompt and panel) stays open", async () => {
  const app = makeApp();
  renderApp(<StrictMode><AccessDialog /></StrictMode>, app);
  act(() => { void app.rt.access.ask("control", "Restart voice"); });
  await flush();
  assert.equal((screen.getByRole("dialog", { name: "Access" }) as HTMLDialogElement).open, true);
  act(() => { app.rt.access.resolvePrompt(false); });
  await flush();
  assert.ok(screen.queryByRole("dialog") === null, "closed once the prompt is resolved");
  act(() => { app.rt.access.openPanel(); });
  await flush();
  assert.equal((screen.getByRole("dialog", { name: "Access" }) as HTMLDialogElement).open, true);
});
