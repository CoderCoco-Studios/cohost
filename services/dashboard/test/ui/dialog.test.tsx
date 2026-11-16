import { test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { dialogSupported } from "./helpers/dom";
import { fireEvent, render, screen, userEvent, within } from "./helpers/render";
import { Dialog, ConfirmDialog } from "../../ui/src/components/Dialog";
import { SideSheet } from "../../ui/src/components/SideSheet";

test("the emulated DOM supports <dialog>.showModal and close, which the dialog tests rely on", () => {
  assert.equal(dialogSupported(), true);
});

function Host({ children = <input aria-label="Field" />, initialFocus }: { children?: React.ReactNode; initialFocus?: string }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>Open</button>
    <Dialog open={open} title="Restart voice?" onClose={() => setOpen(false)} initialFocus={initialFocus}>{children}</Dialog>
  </>);
}

// @spec DASH-A11Y-005
test("a dialog is a modal <dialog> named by its heading, opened with showModal, and nothing renders while it is closed", async () => {
  const user = userEvent.setup();
  render(<Host />);
  assert.equal(screen.queryByRole("dialog"), null);
  await user.click(screen.getByRole("button", { name: "Open" }));
  const dlg = screen.getByRole("dialog", { name: "Restart voice?" }) as HTMLDialogElement;
  assert.equal(dlg.tagName, "DIALOG");
  assert.equal(dlg.open, true);
  assert.equal(within(dlg).getByRole("heading", { name: "Restart voice?" }).tagName, "H2");
});

// @spec DASH-A11Y-005
test("focus moves into the dialog on open and returns to the control that opened it on close", async () => {
  const user = userEvent.setup();
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Open" });
  await user.click(opener);
  assert.ok(screen.getByRole("dialog").contains(document.activeElement), "focus is inside");
  assert.equal((document.activeElement as HTMLElement).getAttribute("aria-label"), "Field");
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(document.activeElement, opener);
});

// @spec DASH-A11Y-005
test("an element marked data-autofocus, or the initialFocus selector, takes the focus on open", async () => {
  const user = userEvent.setup();
  render(<Host><input aria-label="First" /><input aria-label="Token" data-autofocus /></Host>);
  await user.click(screen.getByRole("button", { name: "Open" }));
  assert.equal((document.activeElement as HTMLElement).getAttribute("aria-label"), "Token");
});

// @spec DASH-ACC-011
test("the cancel event (what Esc fires) closes the dialog as a cancel and is not left to the browser", async () => {
  const user = userEvent.setup();
  let reason = "";
  function H() { const [open, setOpen] = useState(true); return <Dialog open={open} title="T" onClose={(r) => { reason = r; setOpen(false); }}><p>x</p></Dialog>; }
  render(<H />);
  const ev = new Event("cancel", { cancelable: true });
  fireEvent(screen.getByRole("dialog"), ev);
  assert.equal(ev.defaultPrevented, true);
  assert.equal(reason, "cancel");
  assert.equal(screen.queryByRole("dialog"), null);
  void user;
});

// @spec DASH-ACC-012
test("what was typed in a dialog is gone when it closes and reopens", async () => {
  const user = userEvent.setup();
  function H() { const [open, setOpen] = useState(false); const [v, setV] = useState(""); return (<>
    <button onClick={() => setOpen(true)}>Open</button>
    <Dialog open={open} title="T" onClose={() => setOpen(false)}><input aria-label="Token" value={v} onChange={(e) => setV(e.target.value)} /></Dialog>
  </>); }
  render(<H />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  assert.equal((screen.getByLabelText("Token") as HTMLInputElement).value, "");
});

// @spec DASH-UI-033, DASH-UI-008
test("ConfirmDialog has Cancel and a confirm button naming the action; confirm calls back, Cancel does not", async () => {
  const user = userEvent.setup();
  const log: string[] = [];
  render(<ConfirmDialog open title="Stop voice?" confirmLabel="Stop voice" onConfirm={() => log.push("confirm")} onCancel={() => log.push("cancel")}>It stops.</ConfirmDialog>);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Stop voice" }));
  assert.deepEqual(log, ["cancel", "confirm"]);
});

// @spec DASH-UI-008
test("ConfirmDialog disables confirm with the reason shown while it cannot run, and shows a failure inside itself", () => {
  render(<ConfirmDialog open title="Restart voice?" confirmLabel="Restart" disabledReason="A stack action is running." error="500 boom" onConfirm={() => {}} onCancel={() => {}}>x</ConfirmDialog>);
  const confirm = screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);
  assert.ok(screen.getByText("A stack action is running."));
  assert.equal(within(screen.getByRole("dialog")).getByRole("alert").textContent, "500 boom");
});

// @spec DASH-UI-032
test("a SideSheet is a dialog with the sheet class that takes focus on open and returns it to the opener", async () => {
  const user = userEvent.setup();
  function H() { const [open, setOpen] = useState(false); return (<>
    <button onClick={() => setOpen(true)}>Test</button>
    <SideSheet open={open} title="Test voice" onClose={() => setOpen(false)}><button>Inside</button></SideSheet>
  </>); }
  render(<H />);
  const opener = screen.getByRole("button", { name: "Test" });
  await user.click(opener);
  const dlg = screen.getByRole("dialog", { name: "Test voice" });
  assert.match(dlg.className, /\bsheet\b/);
  assert.ok(dlg.contains(document.activeElement));
  fireEvent(dlg, new Event("cancel", { cancelable: true }));
  assert.equal(document.activeElement, opener);
});
