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
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
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
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
  assert.ok(document.activeElement === opener, "focus is on the expected element");
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
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
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
  assert.ok(document.activeElement === opener, "focus is on the expected element");
});

// @spec DASH-NAV-003, DASH-A11Y-005
test("Esc cancels the top-most modal, the one opened last, whatever the order of the dialogs in the document", async () => {
  const { useShortcuts } = await import("../../ui/src/app/shortcuts");
  const log: string[] = [];
  function Harness() {
    const [first, setFirst] = useState(false);   // later in the document, opened second
    const [second, setSecond] = useState(true);  // earlier in the document, open from the start
    useShortcuts({ say() {}, view() {}, mute() {}, help() {} });
    return (<>
      <Dialog open={second} title="Behind" onClose={() => { log.push("behind"); setSecond(false); }}><button type="button" onClick={() => setFirst(true)}>Open on top</button></Dialog>
      <Dialog open={first} title="On top" onClose={() => { log.push("top"); setFirst(false); }}><button type="button">Inside</button></Dialog>
    </>);
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "Open on top" }));
  assert.equal(screen.getAllByRole("dialog").length, 2);
  await user.keyboard("{Escape}");
  assert.deepEqual(log, ["top"], "the dialog opened last is the one that closes");
  assert.ok(screen.getByRole("dialog", { name: "Behind" }), "the dialog behind stays open");
  await user.keyboard("{Escape}");
  assert.deepEqual(log, ["top", "behind"]);
  assert.ok(screen.queryByRole("dialog") === null, "expected nothing to be found");
});

// @spec DASH-A11Y-005
test("focus returns to the opener only after the dialog has closed: a modal dialog makes the page behind it inert, and an inert element refuses focus", async () => {
  const user = userEvent.setup();
  render(<Host />);
  const opener = screen.getByRole("button", { name: "Open" });
  let dialogOpenWhenFocused: boolean | undefined;
  const realFocus = opener.focus.bind(opener);
  opener.focus = (...a: Parameters<HTMLElement["focus"]>) => { dialogOpenWhenFocused = (document.querySelector("dialog") as HTMLDialogElement | null)?.open; realFocus(...a); };
  await user.click(opener);
  dialogOpenWhenFocused = undefined;
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  assert.equal(dialogOpenWhenFocused, false, "the opener was focused while the dialog was still open");
  assert.ok(document.activeElement === opener, "focus is on the opener");
});

// @spec DASH-A11Y-005
test("when the opener is gone, focus goes to the screen heading, not to the page body", async () => {
  const user = userEvent.setup();
  function H() { const [open, setOpen] = useState(false); const [gone, setGone] = useState(false); return (<>
    <h1 tabIndex={-1}>Screen</h1>
    {gone ? null : <button onClick={() => setOpen(true)}>Open</button>}
    <Dialog open={open} title="T" onClose={() => { setGone(true); setOpen(false); }}><input aria-label="Field" /></Dialog>
  </>); }
  render(<H />);
  await user.click(screen.getByRole("button", { name: "Open" }));
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
  assert.ok(document.activeElement === screen.getByRole("heading", { name: "Screen" }), "focus is on the heading");
});

// @spec DASH-A11Y-005, DASH-UI-033
test("every dialog and sheet has a visible Close button in its header, which closes it as a cancel", async () => {
  const user = userEvent.setup();
  const reasons: string[] = [];
  function H({ sheet }: { sheet?: boolean }) { const [open, setOpen] = useState(true); const C = sheet ? SideSheet : Dialog; return <C open={open} title="T" onClose={(r) => { reasons.push(r); setOpen(false); }}><p>x</p></C>; }
  for (const sheet of [false, true]) {
    const { unmount } = render(<H sheet={sheet} />);
    const close = within(screen.getByRole("dialog")).getByRole("button", { name: "Close" });
    assert.ok(close.closest(".dialog-h") !== null, "Close is in the header");
    assert.match(close.textContent ?? "", /Close/, "the label is visible text");
    await user.click(close);
    assert.ok(screen.queryByRole("dialog") === null, "closed");
    unmount();
  }
  assert.deepEqual(reasons, ["cancel", "cancel"]);
});

// @spec DASH-A11Y-005
test("a click on the backdrop closes a sheet or an informational dialog, but never a dialog that holds input or asks a question", async () => {
  const user = userEvent.setup();
  let closed = 0;
  const onClose = () => { closed++; };
  const { rerender } = render(<SideSheet open title="Sheet" onClose={onClose}><p>x</p></SideSheet>);
  await user.click(screen.getByRole("dialog"));
  assert.equal(closed, 1, "a sheet closes on a backdrop click");
  await user.click(within(screen.getByRole("dialog")).getByText("x"));
  assert.equal(closed, 1, "a click inside the sheet does not");
  rerender(<Dialog open title="Info" onClose={onClose} backdropClose><p>x</p></Dialog>);
  await user.click(screen.getByRole("dialog"));
  assert.equal(closed, 2, "an informational dialog closes");
  rerender(<Dialog open title="Form" onClose={onClose}><input aria-label="Token" /></Dialog>);
  await user.click(screen.getByRole("dialog"));
  assert.equal(closed, 2, "a dialog without backdropClose stays open");
  rerender(<ConfirmDialog open title="Sure?" confirmLabel="Yes" onConfirm={() => {}} onCancel={onClose}>x</ConfirmDialog>);
  await user.click(screen.getByRole("dialog"));
  assert.equal(closed, 2, "a confirmation stays open");
});

// @spec DASH-A11Y-005
test("a drag that starts inside the dialog and ends on the backdrop does not close it", () => {
  let closed = 0;
  render(<SideSheet open title="Sheet" onClose={() => { closed++; }}><input aria-label="Field" /></SideSheet>);
  const dlg = screen.getByRole("dialog");
  fireEvent.mouseDown(screen.getByLabelText("Field"));
  fireEvent.mouseUp(dlg);
  fireEvent.click(dlg);
  assert.equal(closed, 0);
});
