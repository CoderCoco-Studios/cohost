import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTheme } from "../../ui/src/state/theme";
import { cohostName } from "../../ui/src/state/name";
import { FakeStorage } from "./helpers/fakes";

const mk = (storage: Storage | undefined = new FakeStorage()) => {
  const root = document.createElement("html");
  return { root, storage, theme: createTheme({ storage, root }) };
};

// @spec DASH-THEME-002
test("Auto is the default: no data-theme on <html>, nothing stored", () => {
  const { root, storage, theme } = mk();
  assert.equal(theme.state.get().preference, "auto");
  assert.equal(root.dataset.theme, undefined);
  assert.equal((storage as Storage).getItem("cohost.theme"), null);
});

// @spec DASH-THEME-002
test("Light and Dark set data-theme and are kept in localStorage under cohost.theme; Auto removes both", () => {
  const { root, storage, theme } = mk();
  theme.set("dark");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(storage!.getItem("cohost.theme"), "dark");
  theme.set("light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(storage!.getItem("cohost.theme"), "light");
  theme.set("auto");
  assert.equal(root.dataset.theme, undefined);
  assert.equal(storage!.getItem("cohost.theme"), null);
});

// @spec DASH-THEME-002
test("a stored choice is applied when the page starts; an unknown stored value is Auto", () => {
  const s = new FakeStorage(); s.setItem("cohost.theme", "dark");
  assert.equal(mk(s).theme.state.get().preference, "dark");
  assert.equal(mk(s).root.dataset.theme, "dark");
  const junk = new FakeStorage(); junk.setItem("cohost.theme", "neon");
  assert.equal(mk(junk).theme.state.get().preference, "auto");
});

// @spec DASH-THEME-002
test("when storage throws the control still works for the page and starts at Auto", () => {
  const { root, theme } = mk(FakeStorage.throwing());
  assert.equal(theme.state.get().preference, "auto");
  assert.doesNotThrow(() => theme.set("light"));
  assert.equal(root.dataset.theme, "light");
  assert.equal(theme.state.get().preference, "light");
});

// @spec DASH-THEME-002
test("index.html's bootstrap script applies a saved Light or Dark before first paint and tolerates throwing storage", () => {
  const html = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const run = (storage: unknown) => {
    const doc = { documentElement: { dataset: {} as Record<string, string> } };
    new Function("localStorage", "document", script)(storage, doc);
    return doc.documentElement.dataset.theme;
  };
  const s = new FakeStorage(); s.setItem("cohost.theme", "light");
  assert.equal(run(s), "light");
  s.setItem("cohost.theme", "auto");
  assert.equal(run(s), undefined);
  assert.doesNotThrow(() => run(FakeStorage.throwing()));
});

// @spec DASH-HTTP-001
test("the co-host name is read from <meta name=cohost-name>; empty or unreplaced becomes the generic name", () => {
  document.head.innerHTML = `<meta name="cohost-name" content="Coco">`;
  assert.equal(cohostName(), "Coco");
  document.head.innerHTML = `<meta name="cohost-name" content="__COHOST_NAME__">`;
  assert.equal(cohostName(), "cohost");
  document.head.innerHTML = "";
  assert.equal(cohostName(), "cohost");
});
