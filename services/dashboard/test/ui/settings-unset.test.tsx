import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS, SECTION_PATHS, applySection, parseYaml, readSection, sectionJsonSchema, sectionPresentation, sectionSecrets } from "@cohost/config";
import { screen, userEvent, within } from "./helpers/render";
import { boot, settle } from "./settings-helpers";

// The Not set choice of an optional enum against the real editor (packages/config/src/editor.ts) and the real schema.

const real = {
  groups: GROUPS,
  sections: SECTION_PATHS.map((path) => ({ path, ...sectionPresentation(path), services: ["voice"], schema: sectionJsonSchema(path), secrets: sectionSecrets(path) })),
};
const SECTION = "brain.salience";
const KEY = "module.llm.provider";
const voiceRows = () => document.querySelector<HTMLElement>('[data-key="lang_code"][data-section="voice"]')!;

type Tree = Record<string, unknown>;

/** `tree` with the section document at the dotted `path` replaced by `doc` (removed when `doc` is null), as the store writes it. */
function withSection(tree: Tree, path: string, doc: unknown): Tree {
  const next = structuredClone(tree);
  const segs = path.split(".");
  let node = next;
  for (const s of segs.slice(0, -1)) node = (node[s] ??= {}) as Tree;
  if (doc === null || doc === undefined) delete node[segs.at(-1)!];
  else node[segs.at(-1)!] = doc;
  return next;
}

/**
 * The stored settings in memory behind the real editor, seeded from the committed example: what `handleConfig` does for GET and
 * PUT of one section over the settings store, the revision as the etag.
 */
function realFile(SECTION: string) {
  const f = { tree: parseYaml(readFileSync(new URL("../../../../config/config.example.yaml", import.meta.url), "utf8")) as Tree, revision: 1, puts: [] as string[] };
  const get = () => ({ json: { section: SECTION, etag: String(f.revision), ...readSection(f.tree, SECTION, []) } });
  const put = (call: { body?: string }) => {
    const { etag, values, remove } = JSON.parse(call.body ?? "{}") as { etag: string; values: Record<string, unknown>; remove?: string[] };
    f.puts.push(call.body ?? "");
    if (etag !== String(f.revision)) return { status: 409, json: { ok: false, etag: String(f.revision) } };
    const r = applySection(f.tree, SECTION, values, remove ?? []);
    if (!r.ok) return { status: 400, json: { ok: false, issues: r.issues } };
    f.tree = withSection(f.tree, SECTION, r.doc);
    f.revision++;
    return { status: 200, json: { ok: true, etag: String(f.revision), restart: [], warnings: r.warnings } };
  };
  return { f, get, put };
}

const provider = () => document.querySelector<HTMLElement>(`[data-key="${KEY}"][data-section="${SECTION}"]`)!;
const saveBar = () => within(screen.getByRole("group", { name: "Save settings" }));

// @spec DASH-SET-004
test("Not set on an optional enum saves through the real editor and the key reads as not set afterwards", async () => {
  const { f, get, put } = realFile(SECTION);
  boot({ section: SECTION, schema: real, routes: { [`GET /config/${SECTION}`]: get, [`PUT /config/${SECTION}`]: put } });
  await screen.findByRole("heading", { level: 1 });
  await settle(3);
  const user = userEvent.setup();
  await user.type(within(document.querySelector<HTMLElement>(`[data-key="module.llm.model"][data-section="${SECTION}"]`)!).getByLabelText("Model override"), "llama3.2:3b");
  await user.click(within(provider()).getByRole("radio", { name: "ollama" }));
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(screen.queryAllByRole("alert").map((a) => a.textContent), [], "setting a provider saved");
  assert.equal(readSection(f.tree, SECTION, []).keys[KEY]?.value, "ollama");
  await user.click(within(provider()).getByRole("radio", { name: "Not set" }));
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  const alert = screen.queryByRole("alert");
  assert.ok(alert === null, `Not set was refused: ${alert?.textContent}`);
  const held = readSection(f.tree, SECTION, []).keys[KEY]!;
  assert.equal(held.value, undefined, "the store no longer holds a provider for this key");
  assert.ok((within(provider()).getByRole("radio", { name: "Not set" }) as HTMLInputElement).checked, "the screen shows Not set");
  assert.ok(screen.getByText("0 edits in this section"));
});

// @spec DASH-SET-004
test("an optional enum with many choices (a select) offers Not set too, shows it while the key is unset, and clears the key through the real editor", async () => {
  const { f, get, put } = realFile("voice");
  boot({ section: "voice", schema: real, routes: { "GET /config/voice": get, "PUT /config/voice": put } });
  await screen.findByRole("heading", { level: 1 });
  await settle(3);
  const select = () => within(voiceRows()).getByRole("combobox") as HTMLSelectElement;
  assert.equal(select().selectedOptions[0]?.textContent, "Not set", "an unset key does not show the first choice as if it were chosen");
  const user = userEvent.setup();
  await user.selectOptions(select(), "a");
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(screen.queryAllByRole("alert").map((a) => a.textContent), []);
  assert.equal(readSection(f.tree, "voice", []).keys.lang_code?.value, "a");
  await user.selectOptions(select(), "");
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  assert.deepEqual(screen.queryAllByRole("alert").map((a) => a.textContent), [], "Not set was accepted");
  assert.equal(readSection(f.tree, "voice", []).keys.lang_code?.value, undefined);
  assert.equal(select().selectedOptions[0]?.textContent, "Not set");
});

// @spec DASH-SET-004, DASH-SET-012
test("a Not set save whose answer was lost after it landed is confirmed by the re-read, which shows the key with no value", async () => {
  const { f, get, put } = realFile("voice");
  const b = boot({ section: "voice", schema: real, routes: { "GET /config/voice": get, "PUT /config/voice": put } });
  await screen.findByRole("heading", { level: 1 });
  await settle(3);
  const select = () => within(voiceRows()).getByRole("combobox") as HTMLSelectElement;
  const user = userEvent.setup();
  await user.selectOptions(select(), "a");
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  await user.selectOptions(select(), "");
  b.app.fetch.on("PUT /config/voice", async (call) => { put(call); throw new TypeError("network error"); });
  await user.click(saveBar().getByRole("button", { name: "Save" }));
  await settle();
  assert.equal(readSection(f.tree, "voice", []).keys.lang_code?.value, undefined, "the write landed");
  assert.deepEqual(screen.queryAllByRole("alert").map((a) => a.textContent), [], "the lost answer was confirmed, not reported as unknown");
  assert.ok(screen.getByText("Saved."));
});
