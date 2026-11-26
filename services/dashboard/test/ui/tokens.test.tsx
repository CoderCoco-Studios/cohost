import "./helpers/dom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const stylesDir = new URL("../../ui/src/styles/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, stylesDir), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = strip(read("tokens.css"));

/** The custom properties declared in the first rule block whose selector matches `selector` exactly. */
function block(css: string, selector: string): Record<string, string> {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[1]!.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
  }
  return out;
}

const light = block(tokens, ":root");
// Dark is declared twice (the OS preference with no manual choice, and the manual choice); both must be the same set.
const darkAuto = block(tokens.slice(tokens.indexOf("@media (prefers-color-scheme: dark)")), ':root:not([data-theme="light"])');
const darkManual = block(tokens, ':root[data-theme="dark"]');

const lum = (hex: string): number => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].toSorted((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const hexes = (v: string): string[] => v.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];

// @spec DASH-THEME-001
test("the token table has the Aurora values for light and dark, exactly", () => {
  const dark = { "--bg": "#12142a", "--surface": "#1a1d39", "--surface-2": "#24274a", "--line": "#343868", "--ctl": "#8a8ec2", "--fg": "#f3f5ff", "--muted": "#c5c9ee", "--faint": "#a1a6d3", "--accent": "#4fcbff", "--accent-fill": "#4fcbff", "--on-accent": "#04202e", "--accent-tint": "#16365a", "--current": "#cf8cff", "--current-fill": "#c77dff", "--on-current": "#24063a", "--current-tint": "#3a2a62", "--ok": "#6fe0b0", "--ok-tint": "#283c4c", "--warn": "#ffd479", "--warn-tint": "#3f3a43", "--bad": "#ff8fa3", "--bad-tint": "#3f2f4a", "--build": "#9db8ff", "--build-tint": "#2f3659" };
  const lite = { "--bg": "#f5f7ff", "--surface": "#ffffff", "--surface-2": "#e9edfb", "--line": "#d3d9f0", "--ctl": "#7480a8", "--fg": "#14162c", "--muted": "#40446b", "--faint": "#5a5e86", "--accent": "#0a6690", "--accent-fill": "#4fcbff", "--on-accent": "#04202e", "--accent-tint": "#d9f1ff", "--current": "#7a2fc4", "--current-fill": "#c77dff", "--on-current": "#24063a", "--current-tint": "#f0e2ff", "--ok": "#126a52", "--ok-tint": "#d9e7e3", "--warn": "#855600", "--warn-tint": "#ebe4d6", "--bad": "#b4232f", "--bad-tint": "#f3dcde", "--build": "#3650bd", "--build-tint": "#dfe3f4" };
  for (const [k, v] of Object.entries(dark)) { assert.equal(darkAuto[k], v, `dark auto ${k}`); assert.equal(darkManual[k], v, `dark manual ${k}`); }
  for (const [k, v] of Object.entries(lite)) assert.equal(light[k], v, `light ${k}`);
  assert.deepEqual(Object.keys(darkAuto).toSorted(), Object.keys(darkManual).toSorted());
  assert.equal(darkAuto["--bg-grad"], "linear-gradient(115deg,#111a31 0%,#131530 50%,#1f1738 100%)");
  assert.equal(light["--bg-grad"], "linear-gradient(115deg,#eef6ff 0%,#f5f7ff 50%,#f6effe 100%)");
  assert.equal(darkAuto["--shadow"], "0 12px 40px rgba(4,6,20,.6)");
  assert.equal(light["--shadow"], "0 12px 40px rgba(20,22,44,.16)");
});

// @spec DASH-THEME-002
test("the light set is the default and the dark set applies under prefers-color-scheme: dark unless the page forces light", () => {
  assert.ok(tokens.includes("@media (prefers-color-scheme: dark)"));
  assert.match(tokens, /:root:not\(\[data-theme="light"\]\)/);
  assert.match(tokens, /:root\[data-theme="dark"\]/);
  assert.match(tokens, /color-scheme:\s*light dark/);
});

for (const [name, set] of [["light", light], ["dark", darkAuto]] as const) {
  const stops = hexes(set["--bg-grad"]!);
  const grounds: [string, string][] = [["--bg", set["--bg"]!], ...stops.map((s, i) => [`--bg-grad stop ${i + 1}`, s] as [string, string]), ["--surface", set["--surface"]!], ["--surface-2", set["--surface-2"]!]];

  // @spec DASH-THEME-003
  test(`${name}: every text colour reaches 4.5:1 on --bg, every --bg-grad stop, --surface and --surface-2`, () => {
    assert.equal(stops.length, 3, "the gradient has three stops");
    for (const t of ["--fg", "--muted", "--faint", "--accent", "--current", "--ok", "--warn", "--bad", "--build"]) {
      for (const [g, c] of grounds) assert.ok(ratio(set[t]!, c) >= 4.5, `${name} ${t} on ${g}: ${ratio(set[t]!, c).toFixed(2)}`);
    }
  });

  // @spec DASH-THEME-003
  test(`${name}: status colours and --fg reach 4.5:1 on their tint; --accent and --current on theirs; the on-colours on their fills`, () => {
    for (const s of ["ok", "warn", "bad", "build"]) {
      assert.ok(ratio(set[`--${s}`]!, set[`--${s}-tint`]!) >= 4.5, `${name} --${s} on tint: ${ratio(set[`--${s}`]!, set[`--${s}-tint`]!).toFixed(2)}`);
      assert.ok(ratio(set["--fg"]!, set[`--${s}-tint`]!) >= 4.5, `${name} --fg on --${s}-tint`);
    }
    assert.ok(ratio(set["--accent"]!, set["--accent-tint"]!) >= 4.5, `${name} --accent on its tint`);
    assert.ok(ratio(set["--current"]!, set["--current-tint"]!) >= 4.5, `${name} --current on its tint`);
    assert.ok(ratio(set["--on-accent"]!, set["--accent-fill"]!) >= 4.5, `${name} --on-accent on --accent-fill`);
    assert.ok(ratio(set["--on-current"]!, set["--current-fill"]!) >= 4.5, `${name} --on-current on --current-fill`);
  });

  // @spec DASH-THEME-003
  test(`${name}: --ctl and the focus ring (--accent) reach 3:1 on --bg, --surface and --surface-2`, () => {
    for (const g of ["--bg", "--surface", "--surface-2"]) {
      assert.ok(ratio(set["--ctl"]!, set[g]!) >= 3, `${name} --ctl on ${g}: ${ratio(set["--ctl"]!, set[g]!).toFixed(2)}`);
      assert.ok(ratio(set["--accent"]!, set[g]!) >= 3, `${name} focus ring on ${g}`);
    }
  });
}

for (const [name, set] of [["light", light], ["dark", darkAuto], ["dark (manual)", darkManual]] as const) {
  // @spec DASH-THEME-003
  test(`${name}: --disabled-fg (a disabled control's text) reaches 3:1 on --bg, every --bg-grad stop, --surface and --surface-2`, () => {
    assert.ok(set["--disabled-fg"], "--disabled-fg is declared");
    const grounds = [set["--bg"]!, ...hexes(set["--bg-grad"]!), set["--surface"]!, set["--surface-2"]!];
    for (const g of grounds) assert.ok(ratio(set["--disabled-fg"]!, g) >= 3, `${name} --disabled-fg on ${g}: ${ratio(set["--disabled-fg"]!, g).toFixed(2)}`);
  });
}

// @spec DASH-THEME-001
test("no stylesheet uses a colour literal outside the token definitions in tokens.css", () => {
  const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/;
  for (const f of readdirSync(stylesDir).filter((n) => n.endsWith(".css") && n !== "tokens.css")) {
    strip(read(f)).split("\n").forEach((line, i) => assert.ok(!literal.test(line), `${f}:${i + 1} has a colour literal: ${line.trim()}`));
  }
  // In tokens.css a literal appears only on a custom-property declaration.
  tokens.split("\n").forEach((line, i) => { if (literal.test(line)) assert.match(line, /^\s*--[\w-]+\s*:/, `tokens.css:${i + 1}: ${line.trim()}`); });
});

// @spec DASH-THEME-001
test("every colour the stylesheets use is a custom property declared on :root", () => {
  const used = new Set<string>();
  for (const f of readdirSync(stylesDir).filter((n) => n.endsWith(".css") && n !== "tokens.css")) for (const m of strip(read(f)).matchAll(/var\((--[\w-]+)/g)) used.add(m[1]!);
  const declared = new Set(Object.keys(light));
  // A component may define its own working variable (--p for a slider's fill); only colour tokens must be declared here.
  const colourish = [...used].filter((v) => /^--(bg|surface|line|ctl|fg|muted|faint|accent|current|on-|ok|warn|bad|build|shadow|lift|scrim|thumb)/.test(v));
  for (const v of colourish) assert.ok(declared.has(v), `${v} is used but not declared on :root`);
});
