import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** The first anchor in the page source whose markup matches, as its attributes and text. */
function anchor(re: RegExp): { attrs: Record<string, string>; text: string } | undefined {
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!re.test(m[0])) continue;
    const attrs = Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    return { attrs, text: m[2]!.trim() };
  }
  return undefined;
}

// @spec DASH-UI-024
test("the header has a `docs` link to /cohost/ in a new tab, immediately after the last tab button and hidden in sink mode", () => {
  const a = anchor(/href="\/cohost\/"/)!;
  assert.ok(a, "docs link present");
  assert.equal(a.text, "docs");
  assert.equal(a.attrs.target, "_blank");
  assert.equal(a.attrs.rel, "noopener");
  const header = /<header>([\s\S]*?)<\/header>/.exec(html)![1]!;
  assert.match(header, /<button id="tabSettings"[^>]*>settings<\/button>\s*<a [^>]*href="\/cohost\/"/, "right after the last tab");
  const cls = a.attrs.class!;
  assert.ok(cls, "has a class the sink rule can hide");
  const rules = [...html.matchAll(/([^{}]*\.sink[^{}]*)\{([^}]*)\}/g)].filter((m) => /display:\s*none/.test(m[2]!)).flatMap((m) => m[1]!.split(",").map((x) => x.trim()));
  assert.ok(cls.split(/\s+/).some((c) => rules.includes(`.sink .${c}`)), `.sink .${cls} is hidden`);
});

// @spec DASH-UI-025
test("the Services tab has a `how to read this` link beside its heading, to the health page's states, in a new tab", () => {
  const a = anchor(/how to read this/)!;
  assert.ok(a, "link present");
  assert.equal(a.text, "how to read this");
  assert.equal(a.attrs.href, "/cohost/guide/operate/health#the-states");
  assert.equal(a.attrs.target, "_blank");
  assert.equal(a.attrs.rel, "noopener");
  const h2 = /<h2>services\b[\s\S]*?<\/h2>/.exec(html)![0];
  assert.ok(h2.includes(">how to read this</a>"), "inside the services heading");
});
