import { test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { fireEvent, render, screen, userEvent, within } from "./helpers/render";
import { Button, ButtonLink } from "../../ui/src/components/Button";
import { Field, TextField } from "../../ui/src/components/Field";
import { Switch } from "../../ui/src/components/Switch";
import { Slider } from "../../ui/src/components/Slider";
import { SegmentedGroup } from "../../ui/src/components/SegmentedGroup";
import { Select } from "../../ui/src/components/Select";
import { Chips } from "../../ui/src/components/Chips";
import { TilePicker } from "../../ui/src/components/TilePicker";

// @spec DASH-A11Y-003
test("Field gives its control a label and points aria-describedby at the help and the error", () => {
  render(<Field label="Port" help="Where it listens." error="Must be a whole number">{(p) => <input {...p} />}</Field>);
  const input = screen.getByLabelText("Port");
  const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
  assert.deepEqual(described.sort(), ["Must be a whole number", "Where it listens."].sort());
  assert.equal(input.getAttribute("aria-invalid"), "true");
});

// @spec DASH-A11Y-003
test("a Field with no error is not marked invalid and a field without help has no describedby", () => {
  render(<TextField label="Name" value="x" onChange={() => {}} />);
  const input = screen.getByLabelText("Name");
  assert.equal(input.getAttribute("aria-invalid"), null);
  assert.equal(input.getAttribute("aria-describedby"), null);
});

test("TextField is a controlled text box", async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  function Host() { const [v, setV] = useState(""); return <TextField label="Say" value={v} onChange={(x) => { seen.push(x); setV(x); }} />; }
  render(<Host />);
  await user.type(screen.getByLabelText("Say"), "hi");
  assert.deepEqual(seen, ["h", "hi"]);
});

test("Button defaults to type=button, takes a variant class, and a disabled button does not fire", async () => {
  const user = userEvent.setup();
  let n = 0;
  render(<><Button onClick={() => n++}>Plain</Button><Button variant="primary" size="sm">Go</Button><Button variant="danger" disabled onClick={() => n++}>Wipe</Button></>);
  assert.equal(screen.getByRole("button", { name: "Plain" }).getAttribute("type"), "button");
  assert.match(screen.getByRole("button", { name: "Go" }).className, /btn-primary/);
  assert.match(screen.getByRole("button", { name: "Go" }).className, /btn-sm/);
  await user.click(screen.getByRole("button", { name: "Plain" }));
  await user.click(screen.getByRole("button", { name: "Wipe" }));
  assert.equal(n, 1);
  assert.equal((screen.getByRole("button", { name: "Wipe" }) as HTMLButtonElement).disabled, true);
});

test("a busy Button is disabled and says so to assistive technology", () => {
  render(<Button busy>Save</Button>);
  const b = screen.getByRole("button", { name: "Save" });
  assert.equal(b.getAttribute("aria-busy"), "true");
  assert.equal((b as HTMLButtonElement).disabled, true);
});

// @spec DASH-UI-024
test("ButtonLink is a real link styled as a button, with target and rel passed through", () => {
  render(<ButtonLink href="/cohost/" target="_blank" rel="noopener">Docs</ButtonLink>);
  const a = screen.getByRole("link", { name: "Docs" });
  assert.equal(a.getAttribute("target"), "_blank");
  assert.equal(a.getAttribute("rel"), "noopener");
  assert.match(a.className, /\bbtn\b/);
});

// @spec DASH-SET-016
test("Switch is a role=switch with the label as its name and the word On or Off beside it", async () => {
  const user = userEvent.setup();
  function Host() { const [on, setOn] = useState(false); return <Switch label="Moderator" checked={on} onChange={setOn} />; }
  render(<Host />);
  const sw = screen.getByRole("switch", { name: "Moderator" }) as HTMLInputElement;
  assert.equal(sw.checked, false);
  assert.equal(document.querySelector(".switch-word")!.textContent, "Off");
  await user.click(sw);
  assert.equal(sw.checked, true);
  assert.equal(document.querySelector(".switch-word")!.textContent, "On");
  sw.focus();
  await user.keyboard(" ");
  assert.equal(sw.checked, false);
});

// @spec DASH-SET-018, DASH-THEME-006
test("Slider prints both end values, pairs a number box with the range, and keeps --p in step with the value", async () => {
  const user = userEvent.setup();
  function Host() { const [v, setV] = useState(25); return <Slider label="Temperature" min={0} max={100} step={1} value={v} onChange={setV} />; }
  render(<Host />);
  const range = screen.getByLabelText("Temperature", { selector: "input[type=range]" }) as HTMLInputElement;
  const num = screen.getByRole("spinbutton", { name: "Temperature value" }) as HTMLInputElement;
  assert.equal(range.value, "25");
  assert.equal(num.value, "25");
  assert.equal(range.style.getPropertyValue("--p"), "25%");
  const ends = [...document.querySelectorAll(".range-wrap .end")].map((e) => e.textContent);
  assert.deepEqual(ends, ["0", "100"]);
  await user.clear(num);
  await user.type(num, "80");
  assert.equal(range.value, "80");
  assert.equal(range.style.getPropertyValue("--p"), "80%");
  // A browser moves a focused range with the arrow keys; the emulated DOM does not, so the change event stands in for it.
  fireEvent.change(range, { target: { value: "79" } });
  assert.equal(num.value, "79");
  assert.equal(range.style.getPropertyValue("--p"), "79%");
});

// @spec DASH-SET-018
test("Slider shows the unit and marks a number outside its range invalid without moving the thumb past the end", async () => {
  const user = userEvent.setup();
  function Host() { const [v, setV] = useState(5); return <Slider label="Gain" unit="dB" min={-40} max={12} value={v} onChange={setV} />; }
  render(<Host />);
  const num = screen.getByRole("spinbutton", { name: "Gain value" }) as HTMLInputElement;
  assert.ok(screen.getByText("dB"));
  await user.clear(num);
  await user.type(num, "99");
  assert.equal(num.getAttribute("aria-invalid"), "true");
  assert.equal((screen.getByLabelText("Gain", { selector: "input[type=range]" }) as HTMLInputElement).style.getPropertyValue("--p"), "100%");
});

// @spec DASH-SET-017
test("SegmentedGroup is a fieldset of native radios named by its legend, arrow keys move the selection", async () => {
  const user = userEvent.setup();
  function Host() { const [v, setV] = useState("a"); return <SegmentedGroup legend="Platform" name="platform" value={v} onChange={setV} options={[{ value: "a", label: "twitch" }, { value: "b", label: "youtube" }, { value: "c", label: "discord" }]} />; }
  render(<Host />);
  const group = screen.getByRole("group", { name: "Platform" });
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  assert.deepEqual(radios.map((r) => r.checked), [true, false, false]);
  assert.ok(within(group).getByRole("radio", { name: "youtube" }));
  await user.click(radios[1]!);
  assert.deepEqual((within(group).getAllByRole("radio") as HTMLInputElement[]).map((r) => r.checked), [false, true, false]);
  radios[1]!.focus();
  await user.keyboard("{ArrowRight}");
  assert.equal((within(group).getByRole("radio", { name: "discord" }) as HTMLInputElement).checked, true);
});

// @spec DASH-SET-017
test("Select is a native select with a label, labelled options and an extra selected option for an unlisted value", async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  function Host() { const [v, setV] = useState("legacy"); return <Select label="Backend" value={v} onChange={(x) => { seen.push(x); setV(x); }} options={[{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]} />; }
  render(<Host />);
  const sel = screen.getByRole("combobox", { name: "Backend" }) as HTMLSelectElement;
  assert.deepEqual([...sel.options].map((o) => o.textContent), ["legacy", "Alpha", "Beta"]);
  assert.equal(sel.value, "legacy");
  await user.selectOptions(sel, "Beta");
  assert.deepEqual(seen, ["b"]);
});

// @spec DASH-SET-019
test("Chips are a group of checkboxes, one per value, with the on state shown by a class and a tick", async () => {
  const user = userEvent.setup();
  function Host() { const [v, setV] = useState<string[]>(["twitch"]); return <Chips legend="Sources" values={v} onChange={setV} options={[{ value: "twitch", label: "Twitch chat" }, { value: "stt", label: "Speech" }]} />; }
  render(<Host />);
  const group = screen.getByRole("group", { name: "Sources" });
  const twitch = within(group).getByRole("checkbox", { name: "Twitch chat" }) as HTMLInputElement;
  assert.equal(twitch.checked, true);
  assert.match(twitch.closest("label")!.className, /\bon\b/);
  await user.click(within(group).getByRole("checkbox", { name: "Speech" }));
  assert.match(within(group).getByRole("checkbox", { name: "Speech" }).closest("label")!.className, /\bon\b/);
  await user.click(twitch);
  assert.ok(!/\bon\b/.test(twitch.closest("label")!.className));
});

// @spec DASH-SET-024
test("TilePicker shows a checkbox tile per option with its name and description, and a tile for adding your own", async () => {
  const user = userEvent.setup();
  const added: string[] = [];
  function Host() { const [v, setV] = useState<string[]>([]); return <TilePicker legend="Sources" values={v} onChange={setV} options={[{ value: "mic", label: "Microphone", description: "What you say" }]} addLabel="Add a source tag" onAdd={(t) => { added.push(t); setV((x) => [...x, t]); }} />; }
  render(<Host />);
  const tile = screen.getByRole("checkbox", { name: /Microphone/ }) as HTMLInputElement;
  assert.ok(screen.getByText("What you say"));
  await user.click(tile);
  assert.equal(tile.checked, true);
  assert.match(tile.closest("label")!.className, /\bon\b/);
  await user.type(screen.getByLabelText("Add a source tag"), "discord-vc");
  await user.click(screen.getByRole("button", { name: "Add" }));
  assert.deepEqual(added, ["discord-vc"]);
  assert.ok(screen.getByRole("checkbox", { name: /discord-vc/ }));
});
