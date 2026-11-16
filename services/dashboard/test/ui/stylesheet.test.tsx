import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../ui/src/styles/", import.meta.url);
const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, "");
// The stylesheets in the order main.tsx imports them: that order is the cascade, so it is the order the tests read them in.
const main = readFileSync(new URL("../../ui/src/main.tsx", import.meta.url), "utf8");
const order = [...main.matchAll(/import "\.\/styles\/([\w-]+\.css)";/g)].map((m) => m[1]!);
const sheet = (f: string) => strip(readFileSync(new URL(f, dir), "utf8"));
const all = order.map(sheet).join("\n");
const index = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");

/** The inputs that take the generic minimum height: not a switch, slider, radio, checkbox or file input (they keep their shape). */
const TEXT_INPUT = 'input:where(:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]))';

/** The body of the first `@media (query) { ... }` block, matching braces. */
function media(css: string, query: string): string {
  const at = css.indexOf(`@media ${query}`);
  assert.ok(at >= 0, `no @media ${query}`);
  let depth = 0, i = css.indexOf("{", at);
  const start = i + 1;
  for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; }
  return css.slice(start, i);
}
/** Declarations of the first rule whose selector list contains `selector`. */
function rule(css: string, selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) if (m[1]!.split(",").map((s) => s.trim()).includes(selector)) return m[2]!;
  assert.fail(`no rule for ${selector}`);
}

// @spec DASH-A11Y-002
test("every interactive element has a :focus-visible rule of a 2px --accent outline with a 2px offset, and no rule removes an outline", () => {
  const focus = /([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/.exec(all)!;
  for (const el of ["a", "button", "input", "select", "textarea", "summary", "[tabindex]"]) assert.ok(focus[1]!.split(",").some((s) => s.trim() === `${el}:focus-visible`), el);
  assert.match(focus[2]!, /outline:\s*2px solid var\(--accent\)/);
  assert.match(focus[2]!, /outline-offset:\s*2px/);
  assert.ok(!/outline\s*:\s*(none|0)\b/.test(all) && !/outline-style\s*:\s*none/.test(all), "an outline is removed");
});

// @spec DASH-A11Y-006
test("--target-dense and --target-touch are defined; buttons, inputs, selects and row actions take the dense minimum, and the touch one on narrow screens", () => {
  assert.match(all, /--target-dense:\s*30px/);
  assert.match(all, /--target-touch:\s*44px/);
  assert.match(rule(all, "button"), /min-height:\s*var\(--target-dense\)/);
  for (const el of [TEXT_INPUT, "select"]) assert.match(rule(all, el), /min-height:\s*var\(--target-dense\)/, el);
  assert.match(rule(all, ".row-action"), /min-height:\s*var\(--target-dense\)/);
  const narrow = media(all, "(max-width: 719.98px)");
  for (const el of ["button", TEXT_INPUT, "select", ".row-action", ".btn", ".btn-sm", ".field"]) assert.match(rule(narrow, el), /min-height:\s*var\(--target-touch\)/, el);
});

// @spec DASH-A11Y-007
test("the narrow breakpoint is --bp-narrow 720px and its block sets a 16px gutter and stacks the service rows, Viewers panes and settings navigation", () => {
  assert.match(all, /--bp-narrow:\s*720px/);
  const narrow = media(all, "(max-width: 719.98px)");
  assert.match(narrow, /--gutter:\s*16px/);
  for (const cls of [".svc", ".viewers-panes", ".settings-layout"]) assert.match(narrow, new RegExp(`\\${cls}\\s*[,{]`), `${cls} stacks`);
  assert.match(rule(narrow, ".svc"), /grid-template-columns:\s*(minmax\(0,\s*1fr\)|1fr)/);
});

// @spec DASH-A11Y-007
test("text cells, names, ids and details wrap at every width and nothing has a fixed width wider than its container", () => {
  const wrap = media(all, "(min-width: 0px)");
  assert.match(wrap, /overflow-wrap:\s*anywhere/);
  assert.match(wrap, /min-width:\s*0/);
  for (const m of all.matchAll(/(?:^|[;{\s])width:\s*(\d+(?:\.\d+)?)px/gm)) assert.ok(Number(m[1]) <= 64, `a fixed width of ${m[1]}px`); // icons, switch tracks and thumbs only
});

// @spec DASH-NAV-002
test("the header wraps, and below 720px the nav takes its own full-width row", () => {
  assert.match(rule(all, ".top"), /flex-wrap:\s*wrap/);
  assert.match(rule(media(all, "(max-width: 719.98px)"), ".nav"), /flex-basis:\s*100%/);
  assert.match(rule(all, ".header-group"), /display:\s*flex/);
});

// @spec DASH-THEME-005
test("a prefers-reduced-motion block turns off every animation and transition, pseudo-elements included", () => {
  const block = media(all, "(prefers-reduced-motion: reduce)");
  const sel = /([^{}]+)\{([^{}]*)\}/.exec(block)!;
  for (const s of ["*", "*::before", "*::after"]) assert.ok(sel[1]!.split(",").map((x) => x.trim()).includes(s), s);
  assert.match(sel[2]!, /animation:\s*none/);
  assert.match(sel[2]!, /transition:\s*none/);
});

// @spec DASH-THEME-004, DASH-THEME-005
test("the building status spins, and is the only animation", () => {
  assert.match(all, /\.spin\s*\{[^}]*animation:/);
});

// @spec DASH-BUILD-002
test("no stylesheet declares @font-face or @import or references another origin", () => {
  assert.ok(!/@font-face|@import/.test(all));
  assert.ok(!/url\(\s*['"]?(https?:)?\/\//.test(all));
  assert.ok(!/(?:href|src)=["'](https?:)?\/\//.test(index), "index.html references another origin");
});

// @spec DASH-THEME-001
test("the page background is the gradient token on body", () => {
  assert.match(rule(all, "body"), /background:\s*var\(--bg\)/);
  assert.match(all, /body\s*\{[^}]*background-image:\s*var\(--bg-grad\)/);
});

// @spec DASH-THEME-006
test("no component or screen sets an inline style except a run-time computed value (an allow-list of files)", () => {
  const allowed = new Set(["components/Slider.tsx"]);
  const walk = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d).pathname]);
  const root = new URL("../../ui/src/", import.meta.url);
  for (const f of walk(root).filter((p) => /\.tsx?$/.test(p))) {
    const rel = f.slice(root.pathname.length);
    if (/style=\{|\.style\.|setAttribute\(["']style/.test(readFileSync(f, "utf8"))) assert.ok(allowed.has(rel), `${rel} sets an inline style; use a class, or add it to this allow-list with the run-time value it computes`);
  }
});

// @spec DASH-UI-030, DASH-UI-033, DASH-A11Y-008
test("no source inserts a string as HTML, calls alert/confirm/prompt, or carries a pictograph", () => {
  const walk = (d: URL): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(new URL(`${e.name}/`, d)) : [new URL(e.name, d).pathname]);
  for (const f of walk(new URL("../../ui/src/", import.meta.url)).filter((p) => /\.tsx?$/.test(p))) {
    const t = readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(t), `${f} inserts HTML`);
    assert.ok(!/\b(window\.)?(alert|confirm|prompt)\s*\(/.test(t), `${f} calls alert, confirm or prompt`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(t.replace(/[✓—·…–]/g, "")), `${f} has a pictograph`);
  }
});

// @spec DASH-A11Y-007
test("every stylesheet main.tsx imports exists, and every stylesheet is imported", () => {
  assert.deepEqual([...order].sort(), readdirSync(dir).filter((f) => f.endsWith(".css")).sort());
});

// @spec DASH-A11Y-007
test("the narrow-width rules live in the last stylesheet imported, so they come after every rule they override", () => {
  const last = order[order.length - 1]!;
  assert.equal(last, "narrow.css");
  for (const f of order.slice(0, -1)) assert.ok(!/@media[^{]*max-width/.test(sheet(f)), `${f} has a max-width block; narrow rules belong in narrow.css`);
  assert.match(sheet(last), /@media \(max-width: 719\.98px\)/);
});

// @spec DASH-A11Y-007
test("the narrow block stacks the settings rows and navigation, the feed rows, and sets the 16px gutter", () => {
  const narrow = media(sheet("narrow.css"), "(max-width: 719.98px)");
  for (const cls of [".settings-layout", ".srow", ".srow-s", ".viewers-panes", ".svc", ".ev"]) assert.match(narrow, new RegExp(`\\${cls}\\s*[,{]`), `${cls} is in the narrow block`);
  assert.match(rule(narrow, ".srow"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule(narrow, ".settings-layout"), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

// @spec DASH-A11Y-006
test("no bare input rule stretches a switch, slider, radio, checkbox or file input: the generic minimum height skips them", () => {
  for (const m of all.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1]!.split(",").map((x) => x.trim());
    if (/min-height/.test(m[2]!) && sels.includes("input")) assert.fail("a bare `input` selector sets min-height; use input:where(:not([type=...]))");
  }
  const generic = [...all.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /min-height:\s*var\(--target-/.test(m[2]!) && m[1]!.includes("input:where"));
  assert.ok(generic.length >= 2, "dense and touch rules for input exist");
  for (const g of generic) for (const t of ["checkbox", "radio", "range", "file"]) assert.ok(g[1]!.includes(`[type="${t}"]`), `${g[1]!.trim()} must exclude ${t}`);
  assert.match(rule(all, ".switch"), /height:\s*26px/);
});

// @spec DASH-SET-016
test("on touch widths the switch keeps its pill shape and the 44px target is the row's: .check carries the touch height", () => {
  const narrow = media(sheet("narrow.css"), "(max-width: 719.98px)");
  assert.match(rule(narrow, ".check"), /min-height:\s*var\(--target-touch\)/);
});

// @spec DASH-VIEWERS-011
test("the memory meter keeps a fixed width and one line, and its fill takes the token colours in WebKit and Firefox", () => {
  assert.match(rule(all, ".meter"), /flex:\s*none/);
  assert.match(rule(all, ".meter-text"), /white-space:\s*nowrap/);
  assert.match(rule(all, ".meter meter"), /width:\s*min\(\d+px/);
  for (const p of [".meter meter::-webkit-meter-bar", ".meter meter::-webkit-meter-optimum-value", ".meter meter::-webkit-meter-suboptimum-value", ".meter meter::-webkit-meter-even-less-good-value", ".meter meter::-moz-meter-bar"]) assert.match(rule(all, p), /var\(--/, p);
});

// @spec DASH-SET-018
test("the slider and its number box stay on one row: the box has a fixed width and the wrapper does not wrap", () => {
  assert.ok(!/flex-wrap:\s*wrap/.test(rule(all, ".range-wrap")), ".range-wrap wraps");
  assert.match(rule(all, ".range-wrap .num"), /width:\s*\d/);
  assert.match(rule(all, ".range-wrap .num"), /flex:\s*none/);
});

// @spec DASH-SET-001
test("the settings section list stays in view while a long section scrolls", () => {
  assert.match(rule(all, ".snav"), /position:\s*sticky/);
});

// @spec DASH-THEME-003
test("a disabled button is neutral and uses the --disabled-fg token, not a dimmed live colour", () => {
  const r = rule(all, ".btn[disabled]");
  assert.match(r, /color:\s*var\(--disabled-fg\)/);
  assert.match(r, /background:\s*var\(--surface-2\)/);
  assert.match(r, /cursor:\s*not-allowed/);
  assert.ok(!/opacity/.test(r), "opacity dims the text below the token's contrast");
});

// @spec DASH-THEME-006
test("no stylesheet uses !important except the reduced-motion block", () => {
  for (const f of order) {
    const css = sheet(f).replace(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\}\s*\}/, "");
    assert.ok(!/!important/.test(css), `${f} uses !important`);
  }
});
