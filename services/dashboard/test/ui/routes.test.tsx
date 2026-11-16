import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatHash, parseHash } from "../../ui/src/app/routes";

// @spec DASH-NAV-001
test("the four views and a settings section are read from the hash", () => {
  assert.deepEqual(parseHash("#live"), { view: "live" });
  assert.deepEqual(parseHash("#services"), { view: "services" });
  assert.deepEqual(parseHash("#viewers"), { view: "viewers" });
  assert.deepEqual(parseHash("#settings"), { view: "settings" });
  assert.deepEqual(parseHash("#settings/brain.salience"), { view: "settings", section: "brain.salience" });
  assert.deepEqual(parseHash("#settings/personality"), { view: "settings", section: "personality" });
});

// @spec DASH-NAV-001
test("an empty or unknown hash opens Live; a section on another view is ignored", () => {
  for (const h of ["", "#", "#nope", "#LIVE", "#settingsx", "#/services", "#main"]) assert.deepEqual(parseHash(h), { view: "live" }, h);
  assert.deepEqual(parseHash("#services/anything"), { view: "services" });
  assert.deepEqual(parseHash("#settings/"), { view: "settings" });
});

// @spec DASH-NAV-001
test("a section is decoded, and formatting is the inverse", () => {
  assert.deepEqual(parseHash("#settings/mouth.outputs%2Ehttp"), { view: "settings", section: "mouth.outputs.http" });
  assert.equal(parseHash("#settings/%E0%A4%A").view, "settings");
  for (const r of [{ view: "live" as const }, { view: "viewers" as const }, { view: "settings" as const, section: "brain.salience" }]) assert.deepEqual(parseHash(formatHash(r)), r);
  assert.equal(formatHash({ view: "settings", section: "a b" }), "#settings/a%20b");
});
