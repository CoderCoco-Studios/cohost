import { test } from "node:test";
import assert from "node:assert/strict";
import { useState } from "react";
import { render, screen, userEvent, within } from "./helpers/render";
import { SecretField } from "../../ui/src/components/SecretField";
import { ModelPicker } from "../../ui/src/components/ModelPicker";
import { VoicePicker, voiceLabel } from "../../ui/src/components/VoicePicker";

// @spec DASH-SET-009
test("a secret shows Set or Not set, never a value; the field is masked and starts empty", () => {
  const { rerender } = render(<SecretField label="API key" isSet onSave={() => {}} onClear={() => {}} />);
  assert.ok(screen.getByText("Set"));
  const input = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.value, "");
  assert.equal(input.getAttribute("autocomplete"), "off");
  rerender(<SecretField label="API key" isSet={false} onSave={() => {}} onClear={() => {}} />);
  assert.ok(screen.getByText("Not set"));
  assert.equal(screen.queryByRole("button", { name: "Clear" }), null, "nothing to clear");
});

// @spec DASH-SET-009
test("Show and Hide reveal and mask what was typed; Save sends it and empties the field after success", async () => {
  const user = userEvent.setup();
  const saved: string[] = [];
  render(<SecretField label="API key" isSet={false} onSave={(v) => { saved.push(v); }} onClear={() => {}} />);
  const input = screen.getByLabelText("API key") as HTMLInputElement;
  const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  assert.equal(save.disabled, true, "nothing typed");
  await user.type(input, "sk-abc");
  const show = screen.getByRole("button", { name: "Show" });
  await user.click(show);
  assert.equal(input.type, "text");
  assert.equal(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-pressed"), "true");
  await user.click(screen.getByRole("button", { name: "Hide" }));
  assert.equal(input.type, "password");
  await user.click(save);
  assert.deepEqual(saved, ["sk-abc"]);
  assert.equal(input.value, "");
});

// @spec DASH-SET-009
test("Clear asks for confirmation in a dialog and clears only when confirmed", async () => {
  const user = userEvent.setup();
  let cleared = 0;
  render(<SecretField label="API key" isSet onSave={() => {}} onClear={() => { cleared++; }} />);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  const dlg = screen.getByRole("dialog", { name: "Clear API key?" });
  await user.click(within(dlg).getByRole("button", { name: "Cancel" }));
  assert.equal(cleared, 0);
  await user.click(screen.getByRole("button", { name: "Clear" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Clear" }));
  assert.equal(cleared, 1);
  assert.equal(screen.queryByRole("dialog"), null);
});

// @spec DASH-SET-009
test("a failed save keeps what was typed and shows the failure beside the field", async () => {
  const user = userEvent.setup();
  render(<SecretField label="API key" isSet={false} onSave={() => {}} onClear={() => {}} error="401 unauthorized" />);
  const input = screen.getByLabelText("API key") as HTMLInputElement;
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.ok(screen.getByText("401 unauthorized"));
  await user.type(input, "secret-value");
  assert.equal(input.value, "secret-value", "what the operator typed stays for another try");
});

// @spec DASH-SET-022
test("ModelPicker is a free-text box whose suggestions list the installed models first, then the curated ones, without duplicates", async () => {
  const user = userEvent.setup();
  function H() { const [v, setV] = useState(""); return <ModelPicker label="Model" value={v} onChange={setV} installed={["qwen3:8b", "llama3.1"]} curated={["llama3.1", "gemma3"]} placeholder="same as the main model" />; }
  render(<H />);
  const input = screen.getByRole("combobox", { name: "Model" }) as HTMLInputElement;
  assert.equal(input.placeholder, "same as the main model");
  const opts = [...document.querySelectorAll(`datalist#${input.getAttribute("list")} option`)].map((o) => o.getAttribute("value"));
  assert.deepEqual(opts, ["qwen3:8b", "llama3.1", "gemma3"]);
  await user.type(input, "my-custom:1b");
  assert.equal(input.value, "my-custom:1b");
});

// @spec DASH-SET-010
test("ModelPicker with no lists is just the box, and a note names the server it could not reach", () => {
  render(<ModelPicker label="Model" value="x" onChange={() => {}} unreachable="the model server" />);
  const input = screen.getByRole("textbox", { name: "Model" });
  assert.equal(input.getAttribute("list"), null);
  assert.ok(screen.getByText("Could not reach the model server. Type the name instead."));
});

test("voiceLabel decodes the language and gender from a Kokoro voice id", () => {
  assert.equal(voiceLabel("af_heart"), "af_heart · American, female");
  assert.equal(voiceLabel("bm_george"), "bm_george · British, male");
  assert.equal(voiceLabel("zz_other"), "zz_other");
});

// @spec DASH-SET-023
test("VoicePicker is a select of the voices with decoded labels and a Custom mix entry that opens a text box", async () => {
  const user = userEvent.setup();
  const seen: string[] = [];
  function H() { const [v, setV] = useState("af_heart"); return <VoicePicker label="Voice" value={v} onChange={(x) => { seen.push(x); setV(x); }} voices={["af_heart", "bm_george"]} />; }
  render(<H />);
  const sel = screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement;
  assert.deepEqual([...sel.options].map((o) => o.textContent), ["af_heart · American, female", "bm_george · British, male", "Custom mix…"]);
  assert.equal(screen.queryByRole("textbox", { name: "Custom mix" }), null);
  await user.selectOptions(sel, "Custom mix…");
  const mix = screen.getByRole("textbox", { name: "Custom mix" });
  await user.type(mix, "af_bella(2)+af_sky");
  assert.equal(seen.at(-1), "af_bella(2)+af_sky");
});

// @spec DASH-SET-023
test("a value that is a blend opens the Custom mix box on its own; a value the list lacks is an extra selected option", () => {
  const first = render(<VoicePicker label="Voice" value="af_bella(2)+af_sky" onChange={() => {}} voices={["af_heart"]} />);
  assert.equal((screen.getByRole("textbox", { name: "Custom mix" }) as HTMLInputElement).value, "af_bella(2)+af_sky");
  first.unmount();
  render(<VoicePicker label="Voice" value="old_voice" onChange={() => {}} voices={["af_heart"]} />);
  assert.equal((screen.getByRole("combobox", { name: "Voice" }) as HTMLSelectElement).value, "old_voice");
});

// @spec DASH-SET-010
test("VoicePicker with the voice server unreachable is a text box holding the current value, with the note", () => {
  render(<VoicePicker label="Voice" value="af_heart" onChange={() => {}} voices={null} unreachable="the voice server" />);
  assert.equal((screen.getByRole("textbox", { name: "Voice" }) as HTMLInputElement).value, "af_heart");
  assert.ok(screen.getByText("Could not reach the voice server. Type the name instead."));
});
