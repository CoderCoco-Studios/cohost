import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, SECTION_PATHS, sectionJsonSchema, sectionPresentation, sectionSecrets, sectionKeyPaths, readSection } from "@cohost/config";
import { screen } from "./helpers/render";
import { boot, settle } from "./settings-helpers";

/** The payload `GET /config/schema` serves, built from the config package exactly as `handleConfig` builds it. */
const real = {
  groups: GROUPS,
  sections: SECTION_PATHS.map((path) => ({ path, ...sectionPresentation(path), services: ["voice"], schema: sectionJsonSchema(path), secrets: sectionSecrets(path) })),
};

/** Whether a control is named by a label for it, aria-label, aria-labelledby or the legend of its fieldset. */
function hasName(el: HTMLElement): boolean {
  if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby")) return true;
  if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
  if (el.closest("label")) return true;
  return !!el.closest("fieldset")?.querySelector(":scope > legend");
}

/** `GET /config/<section>` for a default config file: every key at its schema default. */
function read(path: string) {
  return { section: path, etag: "e", ...readSection("", path, ["llm.openai.api_key"]) };
}

// @spec DASH-SET-004, DASH-SET-003, DASH-A11Y-003
test("every section of the real schema renders every key as a labelled control with non-empty help, and no key is hidden", async () => {
  const listed = real.sections.filter((s) => !(s as { page?: string }).page).map((s) => s.path);
  assert.ok(listed.length >= 13);
  for (const path of listed) {
    const members = real.sections.filter((s) => s.path === path || (s as { page?: string }).page === path);
    const routes: Record<string, { json: unknown }> = {};
    for (const m of members) routes[`GET /config/${m.path}`] = { json: read(m.path) };
    const b = boot({ section: path, schema: real, routes });
    await screen.findByRole("heading", { level: 1 });
    await settle(3);
    for (const m of members) {
      for (const key of sectionKeyPaths(m.path)) {
        const rel = key === m.path ? m.path.split(".").pop()! : key.slice(m.path.length + 1);
        const row = document.querySelector<HTMLElement>(`[data-key="${rel}"][data-section="${m.path}"]`);
        assert.ok(row, `${key} has no row on the ${path} page`);
        const pres = (sectionPresentation(m.path).keys as Record<string, { help: string; items?: Record<string, { help: string }> }>)[rel];
        assert.ok(pres?.help, `${key} has no presentation help in the config package`);
        assert.ok((row.textContent ?? "").includes(pres.help), `${key}: its help text is not shown`);
        const controls = [...row.querySelectorAll<HTMLElement>("input:not([type=hidden]):not([type=range]), select, textarea")];
        assert.ok(controls.length > 0 || (row.querySelector("button")?.textContent ?? "").startsWith("Add"), `${key} has no control`); // an empty list of cards is its Add button
        for (const c of controls) assert.ok(hasName(c), `${key}: a ${c.tagName.toLowerCase()} has no accessible name`);
      }
    }
    b.unmount();
    document.body.innerHTML = "";
  }
});
