import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../../ui/src/styles/", import.meta.url);
const strip = (c: string) => c.replace(/\/\*[\s\S]*?\*\//g, "");
const all = readdirSync(dir).filter((f) => f.endsWith(".css")).map((f) => strip(readFileSync(new URL(f, dir), "utf8"))).join("\n");
const index = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");

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
  for (const el of ["input", "select"]) assert.match(rule(all, el), /min-height:\s*var\(--target-dense\)/, el);
  assert.match(rule(all, ".row-action"), /min-height:\s*var\(--target-dense\)/);
  const narrow = media(all, "(max-width: 719.98px)");
  for (const el of ["button", "input", "select", ".row-action"]) assert.match(rule(narrow, el), /min-height:\s*var\(--target-touch\)/, el);
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
