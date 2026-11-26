import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, baseFiles, page, repoRoot, script, REQUIRED_TERMS, writeTree } from "./helpers/docs-fixture.js";
import { extendRepo, guide, INDEX, RUST_BUS, CONNECTOR, GUIDES_TABLE, TESTED_TABLE, LAYOUT_TABLE, SERVICE_README, RUST_README, CONSTANTS, FIXTURES_URL, EXT, SITE } from "./helpers/docs-extend-fixture.js";
import { shell, badge, themeDist, THEME_INDEX_TS, LIVE_HEALTH_VUE, LIVE_HEALTH_MJS, LIVE_NOTE, HEALTH_BODY, HOME_BODY, docPage, FIGURE, NAV, NAV_MARK, NOT_FOUND_BODY, STYLE_CSS, TOKENS_CSS, MARK_VUE, FAVICON_SVG, MERMAID_FENCE_MJS, FLOW_BODY, PALETTE } from "./helpers/docs-theme-fixture.js";

const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const load = (p: string): Promise<any> => import(pathToFileURL(join(repoRoot, p)).href);
interface MiseTask { name: string; run: string[]; depends: string[] }
let miseTaskList: MiseTask[] | null = null;
/** The repository's mise tasks as `mise tasks ls --json` reports them (mise is on PATH whenever the tests run). */
const miseTasks = (): MiseTask[] => {
  if (miseTaskList === null) {
    const r = spawnSync("mise", ["tasks", "ls", "--json"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(r.status, 0, `mise tasks ls failed: ${r.stderr}`);
    miseTaskList = JSON.parse(r.stdout) as MiseTask[];
  }
  return miseTaskList;
};
const miseTask = (name: string): MiseTask => {
  const t = miseTasks().find((x) => x.name === name);
  assert.ok(t, `mise.toml defines no task ${name}`);
  return t;
};
const frontmatter = (title: string, track: string, extra = "") => `---\ntitle: ${title}\ndescription: About ${title}.\ntrack: ${track}\n${extra}---\n\n`;
/** One file of the base fixture tree; fails the test when the fixture has no such path. */
const base = (p: string): string => {
  const s = baseFiles()[p];
  assert.ok(s !== undefined, `no base fixture file ${p}`);
  return s;
};

function fails(r: { code: number | null; err: string; out: string }, re: RegExp) {
  assert.equal(r.code, 1, `expected exit 1; stdout: ${r.out} stderr: ${r.err}`);
  assert.match(r.err, re);
}
function passes(r: { code: number | null; err: string; out: string }) {
  assert.equal(r.code, 0, `expected exit 0; stdout: ${r.out} stderr: ${r.err}`);
}


// A built site holding the pages the README and examples READMEs link; `files` adds to or replaces them. The legacy
// helpers wrap each page's markup in a valid theme shell (favicon, nav mark, track badge, home and 404 pages) so the
// older tests keep exercising one concern each; `distExact` writes files verbatim for the theme tests.
const trackOf = (path: string): string | null => {
  if (/^advanced\/architecture\/(design|segments|decisions)\//.test(path)) return "advanced";
  if (path === "index.html") return null;
  const src = baseFiles()[`docs/${path.replace(/\.html$/, ".md")}`] ?? baseFiles()[`docs/${path.replace(/\.html$/, "/index.md")}`];
  return src ? (/^track: (\w+)$/m.exec(src)?.[1] ?? null) : null;
};
const wrapPage = (path: string, content: string): string => {
  if (/<!DOCTYPE/i.test(content)) return content;
  if (path === "index.html") return shell(HOME_BODY + content);
  const t = trackOf(path);
  return shell(t ? `<div class="vp-doc">${badge(t)}${content}</div>` : content);
};
const BUILT: Record<string, string> = { "guide/install/real-install.html": "", "advanced/extend/hooks.html": "" };
const distExact = (files: Record<string, string>) => (dir: string) => writeTree(join(dir, "docs/.vitepress/dist"), files);
const distRaw = (files: Record<string, string>) => {
  const all: Record<string, string> = { ...themeDist(), ...files };
  return distExact(Object.fromEntries(Object.entries(all).map(([p, c]) => [p, p.endsWith(".html") ? wrapPage(p, c) : c])));
};
const dist = (files: Record<string, string>) => distRaw({ ...BUILT, ...files });

// ---------------------------------------------------------------- Build

// @spec DOCS-BUILD-001
test("the docs:build task runs the source check, vitepress build, then the built-site check, as steps in that order", () => {
  // mise runs a task's run steps in order and stops at the first that exits non-zero.
  assert.deepEqual(miseTask("docs:build").run, ["node scripts/docs-check.mjs", "vitepress build docs", "node scripts/docs-check.mjs --dist"]);
});

// @spec DOCS-BUILD-002
test("the docs:dev task runs vitepress dev alone", () => {
  assert.deepEqual(miseTask("docs:dev").run, ["vitepress dev docs"]);
});

// @spec DOCS-BUILD-003
test("the config publishes under /cohost/ with clean URLs and local search", async () => {
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  assert.equal(cfg.base, "/cohost/");
  assert.equal(cfg.cleanUrls, true);
  assert.equal(cfg.themeConfig.search.provider, "local");
});

// @spec DOCS-BUILD-004
test("ignoreDeadLinks is unset or exactly 'localhostLinks'", async () => {
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  assert.ok(cfg.ignoreDeadLinks === undefined || cfg.ignoreDeadLinks === "localhostLinks", String(cfg.ignoreDeadLinks));
});

// @spec DOCS-BUILD-004
test("the docs check rejects a config that ignores more than localhost links", () => {
  const cfg = base("docs/.vitepress/config.ts").replace("base:", "ignoreDeadLinks: true, base:");
  fails(check({ "docs/.vitepress/config.ts": cfg }), /config\.ts.*DOCS-BUILD-004/);
});

// @spec DOCS-BUILD-005
test("a clean tree exits 0 and a problem line names the file and line and exits 1", () => {
  const ok = check();
  passes(ok);
  assert.match(ok.out, /0 problems/);
  const bad = check({ "docs/guide/troubleshooting.md": frontmatter("Troubleshooting", "simple") + "# T\n\nIt was legacy.\n" });
  fails(bad, /^docs\/guide\/troubleshooting\.md:9: .*legacy/m);
});

// @spec DOCS-BUILD-006
test("no docs task writes a markdown page", () => {
  const docs = miseTasks().filter((t) => t.name.startsWith("docs:"));
  assert.deepEqual(docs.map((t) => t.name).toSorted(), ["docs:build", "docs:dev", "docs:preview"]);
  for (const t of docs) {
    for (const step of t.run) assert.match(step.trim(), /^(vitepress (dev|build|preview) docs|node scripts\/docs-check\.mjs( --dist)?)$/, t.name);
    // the one task a docs task depends on installs the packages; it writes nothing under docs/
    assert.deepEqual(t.depends, ["install"], t.name);
  }
  assert.deepEqual(miseTask("docs:preview").run, ["vitepress preview docs"]);
  assert.deepEqual(miseTask("install").run.map((s) => s.trim()), ["pnpm install --frozen-lockfile", "touch node_modules/.modules.yaml"]);
  assert.equal(existsSync(join(repoRoot, "scripts/docs-prepare.mjs")), false);
});

// @spec DOCS-BUILD-007
test(".gitignore excludes the cache and dist and ignores no docs page", () => {
  const gi = read(".gitignore");
  assert.match(gi, /^docs\/\.vitepress\/cache$/m);
  assert.match(gi, /^docs\/\.vitepress\/dist$/m);
  for (const p of ["docs/guide/index.md", "docs/examples/modules.md", "docs/start/what-is-cohost.md", "docs/advanced/architecture/design/[section].md"]) {
    const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: repoRoot });
    assert.equal(r.status, 1, `${p} must not be ignored`);
  }
});

// @spec DOCS-BUILD-008
test("sidebar and nav are data in sidebar.mjs and the config uses them", async () => {
  const side = await load("docs/.vitepress/sidebar.mjs");
  assert.ok(Array.isArray(side.sidebar) && Array.isArray(side.nav));
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  assert.deepEqual(cfg.themeConfig.sidebar, side.sidebar);
  assert.deepEqual(cfg.themeConfig.nav, side.nav);
});

// @spec DOCS-BUILD-009
test("::: aside renders a cohost-aside element titled 'The co-host says'", async () => {
  const { createMarkdownRenderer } = await import("vitepress");
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  const md = await createMarkdownRenderer(repoRoot, cfg.markdown, "/cohost/");
  const html = md.render("::: aside\nHello **there**.\n:::\n");
  assert.match(html, /class="[^"]*cohost-aside[^"]*"/);
  assert.match(html, /The co-host says/);
  assert.match(html, /<strong>there<\/strong>/);
});

// ---------------------------------------------------------------- Publishing boundary

// @spec DOCS-PUB-001
test("srcExclude lists the unpublished paths", async () => {
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  for (const p of ["high-level-design.md", "intent/**", "decisions/**", "arrows/**", "lid/**", "plans/**"]) assert.ok(cfg.srcExclude.includes(p), p);
});

// @spec DOCS-PUB-001
test("the docs check rejects a config missing a required srcExclude pattern", () => {
  const cfg = base("docs/.vitepress/config.ts").replace("'lid/**', ", "");
  fails(check({ "docs/.vitepress/config.ts": cfg }), /DOCS-PUB-001.*lid\/\*\*/);
});

// @spec DOCS-PUB-002
test("a srcExclude pattern that matches no file fails, except decisions and plans", () => {
  fails(check({ "docs/arrows/index.yaml": null }), /DOCS-PUB-002.*arrows\/\*\*/);
  passes(check({ "docs/plans/x.md": null }));
  passes(check({ "docs/decisions/x.md": null }));
});

// @spec DOCS-PUB-003
test("the built-site pass fails when dist holds an excluded page", () => {
  passes(check({}, ["--dist"], dist({ "index.html": "<html></html>" })));
  for (const f of ["high-level-design.html", "intent/x/x-design.html", "decisions/a.html", "arrows/a.html", "lid/workflow.html", "plans/p.html"]) {
    fails(check({}, ["--dist"], dist({ "index.html": "<html></html>", [f]: "<html></html>" })), /DOCS-PUB-003/);
  }
  // an architecture excerpt route named decisions is not a top-level decisions page
  passes(check({}, ["--dist"], dist({ "index.html": "<html></html>", "advanced/architecture/decisions/a.html": "<html></html>" })));
});

// @spec DOCS-PUB-004
test("a published markdown file outside the page tree fails", () => {
  fails(check({ "docs/TESTING.md": page({ title: "T", description: "d", track: "advanced" }, "# T") }), /docs\/TESTING\.md.*DOCS-PUB-004/);
});

// @spec DOCS-PUB-004
test("dynamic-route templates under docs/advanced/architecture are allowed; excluded files are not pages", () => {
  const r = check({ "docs/advanced/architecture/design/[section].md": "<!-- @content -->\n", "docs/plans/p.md": "# plan\n" });
  assert.doesNotMatch(r.err, /DOCS-PUB-004/);
});

// ---------------------------------------------------------------- Information architecture

async function sidebarTools() {
  const mod = await load("scripts/docs-check.mjs");
  const side = await load("docs/.vitepress/sidebar.mjs");
  const tree = mod.parsePageTree(read("docs/intent/docs-site/docs-site-design.md"));
  return { mod, side, tree };
}
const sections = (side: any) => side.sidebar as any[];

// @spec DOCS-IA-001
test("the sidebar has the four sections in order", async () => {
  const { side } = await sidebarTools();
  assert.deepEqual(sections(side).map((s) => s.text), ["Start here", "Set it up and run it", "Build on it", "Project"]);
});

// @spec DOCS-IA-001
test("a page whose track differs from its section's track fails", () => {
  fails(check({ "docs/project/spec-driven.md": page({ title: "How specs work", description: "d", track: "advanced" }, "# How specs work") }), /project\/spec-driven\.md.*DOCS-IA-001/);
});

// @spec DOCS-IA-002
test("the real sidebar lists every page of the LLD page tree under its section and group in row order", async () => {
  const { mod, side, tree } = await sidebarTools();
  const problems = mod.sidebarStructureProblems(side.sidebar, side.nav, tree);
  assert.deepEqual(problems, []);
  assert.ok(tree.flatMap((s: any) => s.rows).length >= 40);
});

// @spec DOCS-IA-002
test("a page named in the tree but missing, or listed out of order, fails", () => {
  fails(check({ "docs/guide/connect/twitch.md": null }), /guide\/connect\/twitch\.md.*DOCS-IA-002/);
  const swapped = base("docs/.vitepress/sidebar.mjs")
    .replace("{ text: 'What you need', link: '/guide/install/prerequisites' },\n      { text: 'Try it', link: '/guide/install/first-run' },", "{ text: 'Try it', link: '/guide/install/first-run' },\n      { text: 'What you need', link: '/guide/install/prerequisites' },");
  fails(check({ "docs/.vitepress/sidebar.mjs": swapped }), /DOCS-IA-002.*order/);
});

// @spec DOCS-IA-003
test("a sidebar link to no published page fails", () => {
  const bad = base("docs/.vitepress/sidebar.mjs").replace("link: '/start/glossary'", "link: '/start/nowhere'");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-003.*\/start\/nowhere/);
});

// @spec DOCS-IA-003
test("a nav link to no published page fails", () => {
  const bad = base("docs/.vitepress/sidebar.mjs").replace("link: '/project/spec-driven' },\n];", "link: '/project/nowhere' },\n];");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-003.*\/project\/nowhere/);
});

// @spec DOCS-IA-004
test("a page missing from the sidebar, or listed twice, fails", () => {
  const missing = base("docs/.vitepress/sidebar.mjs").replace("    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n", "");
  fails(check({ "docs/.vitepress/sidebar.mjs": missing }), /guide\/troubleshooting\.md.*DOCS-IA-004/);
  const twice = base("docs/.vitepress/sidebar.mjs").replace("    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n", "    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n    { text: 'Again', link: '/guide/troubleshooting' },\n");
  fails(check({ "docs/.vitepress/sidebar.mjs": twice }), /DOCS-IA-004.*twice|DOCS-IA-004.*2 times/);
});

// @spec DOCS-IA-005
test("section and group collapse flags follow the design", async () => {
  const { side } = await sidebarTools();
  const [start, simple, advanced, project] = sections(side);
  for (const s of [start, simple, advanced, project]) assert.equal("collapsed" in s, false, s.text);
  assert.ok(start.items.every((i: any) => i.link));
  assert.ok(project.items.every((i: any) => i.link));
  const groups = (s: any) => s.items.filter((i: any) => i.items);
  assert.deepEqual(groups(simple).map((g: any) => [g.text, g.collapsed]), [["Install", false], ["Connect", false], ["Tune", false], ["Operate", false]]);
  assert.deepEqual(groups(advanced).map((g: any) => [g.text, g.collapsed]), [["Testing", true], ["Extend", true], ["Reference", true], ["Architecture", true]]);
});

// @spec DOCS-IA-005
test("the docs check fails a wrong collapsed flag", () => {
  const bad = base("docs/.vitepress/sidebar.mjs").replace("{ text: 'Install', collapsed: false", "{ text: 'Install', collapsed: true");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-005.*Install/);
});

// @spec DOCS-IA-006
test("the glossary has no prev/next and How it works points next at What you need", () => {
  fails(check({ "docs/start/glossary.md": base("docs/start/glossary.md").replace("next: false\n", "") }), /glossary\.md.*DOCS-IA-006/);
  fails(check({ "docs/start/how-it-works.md": page({ title: "How it works", description: "d", track: "start" }, "# How it works") }), /how-it-works\.md.*DOCS-IA-006/);
  fails(check({ "docs/start/how-it-works.md": page({ title: "How it works", description: "d", track: "start", next: "{ text: x, link: /start/glossary }" }, "# How it works") }), /how-it-works\.md.*DOCS-IA-006/);
});

// @spec DOCS-IA-007
test("the nav links the four tracks in order", async () => {
  const { side } = await sidebarTools();
  assert.deepEqual(side.nav.map((n: any) => [n.text, n.link]), [
    ["Start here", "/start/what-is-cohost"], ["Guide", "/guide/install/prerequisites"], ["Advanced", "/advanced/dev-setup"], ["Project", "/project/spec-driven"],
  ]);
});

// @spec DOCS-IA-007
test("the GitHub repository is a social link and the check rejects a wrong nav", async () => {
  const cfg = (await load("docs/.vitepress/config.ts")).default;
  assert.ok(cfg.themeConfig.socialLinks.some((s: any) => s.icon === "github" && s.link === "https://github.com/CoderCoco-Studios/cohost"));
  const bad = base("docs/.vitepress/sidebar.mjs").replace("{ text: 'Guide', link: '/guide/install/prerequisites' },\n  { text: 'Advanced', link: '/advanced/dev-setup' },", "{ text: 'Advanced', link: '/advanced/dev-setup' },\n  { text: 'Guide', link: '/guide/install/prerequisites' },");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-007/);
});

// @spec DOCS-IA-008
test("the home page's three entry actions link the three starting pages", () => {
  const home = base("docs/index.md").replace("link: /advanced/dev-setup", "link: /advanced/nowhere");
  fails(check({ "docs/index.md": home }), /docs\/index\.md.*DOCS-IA-008/);
  passes(check());
});

// @spec DOCS-IA-009
test("the real sidebar nests at most four levels, deeper only inside Architecture, closed", async () => {
  const { mod, side, tree } = await sidebarTools();
  assert.deepEqual(mod.sidebarStructureProblems(side.sidebar, side.nav, tree).filter((p: string) => /IA-009/.test(p)), []);
  const arch = sections(side)[2].items.find((i: any) => i.text === "Architecture");
  assert.deepEqual(arch.items.filter((i: any) => i.items).map((g: any) => [g.text, g.collapsed]), [["Design", true], ["Segments", true], ["Decisions", true]]);
  const seg = arch.items.find((i: any) => i.text === "Segments");
  assert.deepEqual(seg.items.map((g: any) => [g.text, g.collapsed]), ["platform", "senses", "brain", "body", "operator"].map((t) => [t, true]));
});

// @spec DOCS-IA-009
test("a third group level outside Architecture fails", () => {
  const bad = base("docs/.vitepress/sidebar.mjs").replace("{ text: 'Twitch chat', link: '/guide/connect/twitch' }", "{ text: 'Deep', collapsed: true, items: [{ text: 'Twitch chat', link: '/guide/connect/twitch' }] }");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-009/);
});

// ---------------------------------------------------------------- Page authoring

// @spec DOCS-PAGE-001
test("frontmatter title, description and a valid track are required", () => {
  const p = "docs/guide/troubleshooting.md";
  fails(check({ [p]: "---\ndescription: d\ntrack: simple\n---\n\n# T\n" }), /troubleshooting\.md.*DOCS-PAGE-001.*title/);
  fails(check({ [p]: "---\ntitle: T\ndescription: ''\ntrack: simple\n---\n\n# T\n" }), /troubleshooting\.md.*DOCS-PAGE-001.*description/);
  fails(check({ [p]: "---\ntitle: T\ndescription: d\ntrack: beginner\n---\n\n# T\n" }), /troubleshooting\.md.*DOCS-PAGE-001.*track/);
  fails(check({ [p]: "# T\n\nno frontmatter\n" }), /troubleshooting\.md.*DOCS-PAGE-001/);
  fails(check({ "docs/index.md": base("docs/index.md").replace("track: start", "track: simple") }), /docs\/index\.md.*DOCS-PAGE-001/);
});

// @spec DOCS-PAGE-002
test("a page with a fenced code block needs a verified SHA of 7 to 40 lowercase hex characters", () => {
  const p = "docs/guide/troubleshooting.md";
  const body = "# T\n\n```sh\nmise run build\n```\n";
  fails(check({ [p]: frontmatter("T", "simple") + body }), /troubleshooting\.md.*DOCS-PAGE-002/);
  fails(check({ [p]: frontmatter("T", "simple", "verified: ABCDEF1\n") + body }), /DOCS-PAGE-002/);
  fails(check({ [p]: frontmatter("T", "simple", "verified: abc12\n") + body }), /DOCS-PAGE-002/);
  fails(check({ [p]: frontmatter("T", "simple", "verified: 1234567890\n") .replace("1234567890", "123456") + body }), /DOCS-PAGE-002/);
  passes(check({ [p]: frontmatter("T", "simple", "verified: 1a2b3c4\n") + body }));
  passes(check({ [p]: frontmatter("T", "simple", `verified: ${"a".repeat(40)}\n`) + body }));
  passes(check({ [p]: frontmatter("T", "simple", "verified: 1234567\n") + body }));
  passes(check({ [p]: frontmatter("T", "simple") + "# T\n\nNo fence, `inline` only.\n" }));
});

// @spec DOCS-PAGE-003
test("every image needs alt text, markdown or html", () => {
  const p = "docs/guide/troubleshooting.md";
  fails(check({ [p]: frontmatter("T", "simple") + "# T\n\n![](a.png)\n" }), /troubleshooting\.md:9.*DOCS-PAGE-003/);
  fails(check({ [p]: frontmatter("T", "simple") + '# T\n\n<img src="a.png">\n' }), /DOCS-PAGE-003/);
  fails(check({ [p]: frontmatter("T", "simple") + '# T\n\n<img src="a.png" alt="">\n' }), /DOCS-PAGE-003/);
  passes(check({ [p]: frontmatter("T", "simple") + '# T\n\n![A screenshot of the dashboard](a.png)\n\n<img src="a.png" alt="the dashboard">\n' }));
});

// @spec DOCS-PAGE-004
test("previously, formerly, deprecated and legacy fail in prose unless allowed", () => {
  const p = "docs/guide/troubleshooting.md";
  for (const w of ["previously", "Formerly", "DEPRECATED", "legacy"]) fails(check({ [p]: frontmatter("T", "simple") + `# T\n\nIt was ${w} fine.\n` }), new RegExp(`troubleshooting\\.md:9.*DOCS-PAGE-004.*${w}`, "i"));
  passes(check({ [p]: frontmatter("T", "simple") + "# T\n\nIt was legacy. <!-- docs-check: allow -->\n" }));
  passes(check({ [p]: frontmatter("T", "simple", "verified: 1a2b3c4\n") + "# T\n\nA `legacy` span, a [legacy link](x.md) and a legacyfoo word.\n\n## legacy heading\n\n```sh\n# legacy\n```\n".replace("(x.md)", "(troubleshooting.md)") }));
  fails(check({ README: null, "README.md": base("README.md").replace("A co-host.", "A legacy co-host.") }), /README\.md:3.*DOCS-PAGE-004/);
  passes(check({ "docs/project/verification-log.md": frontmatter("Verification log", "project") + "# V\n\nFormerly deprecated legacy previously.\n" }));
});

// @spec DOCS-PAGE-005
test("install and connect step pages carry the three headings and link troubleshooting from 'If it didn't'", () => {
  const p = "docs/guide/connect/twitch.md";
  const good = base(p);
  fails(check({ [p]: good.replace("## How you know it worked", "## It worked") }), /twitch\.md.*DOCS-PAGE-005.*How you know it worked/);
  fails(check({ [p]: good.replace("## What you need", "## Needs") }), /DOCS-PAGE-005.*What you need/);
  fails(check({ [p]: good.replace("## If it didn't", "## Problems") }), /DOCS-PAGE-005.*If it didn't/);
  fails(check({ [p]: good.replace("(../troubleshooting.md)", "(../../start/glossary.md)") }), /DOCS-PAGE-005.*troubleshooting/);
  passes(check({ [p]: good.replace("## If it didn't", "## If it didn\u2019t") }));
  passes(check({ [p]: good.replace("(../troubleshooting.md)", "(../troubleshooting.md#fix)") }));
  // prerequisites is exempt
  passes(check());
});

// @spec DOCS-PAGE-006
test("the extend page presents bus-client services as supported and others as unsupported", () => {
  const p = "docs/advanced/extend/index.md";
  const fm = (x = "") => frontmatter("Ways to extend cohost", "advanced", "glossary-skip: [event]\n" + x);
  const links = "See [Add a TypeScript service](typescript-service.md) and [Rust bus client](rust-bus.md). ";
  const gets = "Others get no event validation, no dashboard control, no health reporting.";
  fails(check({ [p]: fm() + `# Ways\n\nUse \`@cohost/bus\`. ${links}${gets}\n` }), /DOCS-PAGE-006.*crates\/cohost-bus/);
  fails(check({ [p]: fm() + `# Ways\n\nUse \`@cohost/bus\` or \`crates/cohost-bus\`. ${gets}\n` }), /DOCS-PAGE-006.*typescript-service/);
  fails(check({ [p]: fm() + `# Ways\n\nUse \`@cohost/bus\` or \`crates/cohost-bus\`. See [Add a TypeScript service](typescript-service.md). ${gets}\n` }), /DOCS-PAGE-006.*rust-bus/);
  fails(check({ [p]: fm() + `# Ways\n\nUse \`@cohost/bus\` or \`crates/cohost-bus\`. ${links}Others get no event validation.\n` }), /DOCS-PAGE-006.*dashboard control|DOCS-PAGE-006.*health reporting/);
  fails(check({ [p]: fm() + `# Ways\n\nUse \`@cohost/bus\` or \`crates/cohost-bus\`. ${links}${gets}\n\nA Python service is a supported way to extend cohost.\n` }), /DOCS-PAGE-006/);
});

// @spec DOCS-PAGE-007
test("a page needs exactly one H1, fenced comment lines excepted", () => {
  const p = "docs/guide/troubleshooting.md";
  fails(check({ [p]: frontmatter("T", "simple") + "No heading.\n" }), /troubleshooting\.md.*DOCS-PAGE-007/);
  fails(check({ [p]: frontmatter("T", "simple") + "# One\n\n# Two\n" }), /DOCS-PAGE-007/);
  passes(check({ [p]: frontmatter("T", "simple", "verified: 1a2b3c4\n") + "# One\n\n```sh\n# a comment\n```\n" }));
});

// ---------------------------------------------------------------- Glossary

// @spec DOCS-GLOSS-001
test("the glossary lists unique terms with match lists and one heading per id", () => {
  const g = base("docs/start/glossary.md");
  fails(check({ "docs/start/glossary.md": g.replace("### redis {#redis}", "### Redis") .replace("### Redis", "### Cache") }), /glossary\.md.*DOCS-GLOSS-001.*redis/);
  fails(check({ "docs/start/glossary.md": g.replace("  - id: osc\n    match: [osc]", "  - id: osc\n    match: []") }), /DOCS-GLOSS-001.*osc/);
  fails(check({ "docs/start/glossary.md": g.replace("  - id: osc\n", "  - id: vrm\n") }), /DOCS-GLOSS-001.*vrm/);
  passes(check({ "docs/start/glossary.md": g.replace("### redis {#redis}", "### Redis {#redis}") }));
});

// @spec DOCS-GLOSS-002
test("a page using a term in prose must link its entry unless it skips the term", () => {
  const p = "docs/guide/troubleshooting.md";
  const gl = "../start/glossary.md";
  fails(check({ [p]: frontmatter("T", "simple") + "# T\n\nRedis is a thing.\n" }), /troubleshooting\.md:9.*DOCS-GLOSS-002.*redis/);
  fails(check({ [p]: frontmatter("T", "simple") + "# T\n\nTwo containers run.\n" }), /DOCS-GLOSS-002.*container/);
  fails(check({ [p]: frontmatter("T", "simple") + "# T\n\n| a |\n| - |\n| Compose Profile |\n" }), /DOCS-GLOSS-002.*compose-profile/);
  fails(check({ [p]: frontmatter("T", "simple") + `# T\n\nRedis is [here](${gl}#postgres).\n` }), /DOCS-GLOSS-002.*redis/);
  passes(check({ [p]: frontmatter("T", "simple") + "# T\n\nA subredis word, Redisson and redis_x are not the term.\n" }));
  passes(check({ [p]: frontmatter("T", "simple") + `# T\n\n[Redis](${gl}#redis) is a thing.\n` }));
  passes(check({ [p]: frontmatter("T", "simple", "glossary-skip: [redis]\n") + "# T\n\nRedis is a thing.\n" }));
  // code spans, code blocks, headings and link text are not prose
  passes(check({ [p]: frontmatter("T", "simple", "verified: 1a2b3c4\n") + "# Redis\n\nA `redis` span, a [redis](x) text.\n\n## Redis again\n\n```\nredis\n```\n".replace("(x)", "(troubleshooting.md)") }));
  // text inside ::: containers is prose
  fails(check({ [p]: frontmatter("T", "simple") + "# T\n\n::: aside\nRedis here.\n:::\n" }), /DOCS-GLOSS-002.*redis/);
});

// @spec DOCS-GLOSS-002
test("the glossary itself is exempt from the link rule", () => {
  passes(check());
});

// @spec DOCS-GLOSS-003
test("the glossary must define the required term ids", () => {
  assert.equal(REQUIRED_TERMS.length, 36);
  const g = base("docs/start/glossary.md");
  fails(check({ "docs/start/glossary.md": g.replace(/  - id: pgvector\n    match: \[pgvector\]\n/, "").replace("### pgvector {#pgvector}", "### nothing {#nothing}") }), /glossary\.md.*DOCS-GLOSS-003.*pgvector/);
});

// @spec DOCS-GLOSS-004
test("relative and root-relative glossary links count, with or without .md", () => {
  const p = "docs/guide/connect/twitch.md";
  const good = base(p);
  for (const href of ["../../start/glossary.md#redis", "../../start/glossary#redis", "/start/glossary#redis", "/start/glossary.md#redis"]) {
    passes(check({ [p]: good.replace("A PC.", `[Redis](${href}) runs.`) }));
  }
  passes(check({ "docs/start/how-it-works.md": base("docs/start/how-it-works.md").replace("It listens.", "[Redis](glossary#redis) runs.") }));
  fails(check({ [p]: good.replace("A PC.", "Redis runs, see [x](../../start/glossary#docker).") }), /DOCS-GLOSS-002.*redis/);
  fails(check({ [p]: good.replace("A PC.", "Redis runs, see [x](../../start/other.md#redis).") }), /DOCS-GLOSS-002.*redis/);
});

// ---------------------------------------------------------------- Links

// @spec DOCS-LINK-001
test("a built link whose fragment names no id on the target page fails", () => {
  const good = {
    "index.html": '<html><body><a href="/cohost/start/glossary#redis">r</a><a href="start/glossary.html#redis">r</a><a href="start/glossary">p</a></body></html>',
    "start/glossary.html": '<html><body><h3 id="redis">Redis</h3></body></html>',
  };
  passes(check({}, ["--dist"], dist(good)));
  fails(check({}, ["--dist"], dist({ ...good, "start/glossary.html": "<html><body><h3 id=\"other\">x</h3></body></html>" })), /index\.html.*DOCS-LINK-001.*#redis/);
  // same-page fragments and external links are checked / skipped correctly
  passes(check({}, ["--dist"], dist({ "index.html": '<html><body><h2 id="a">a</h2><a href="#a">a</a><a href="https://example.com/x#y">e</a></body></html>' })));
  fails(check({}, ["--dist"], dist({ "index.html": '<html><body><a href="#missing">a</a></body></html>' })), /DOCS-LINK-001.*#missing/);
});

// @spec DOCS-LINK-002
test("a GitHub blob or tree link to this repository must name an existing file or directory", () => {
  const p = "docs/guide/troubleshooting.md";
  const gh = "https://github.com/CoderCoco-Studios/cohost";
  const mk = (t: string) => frontmatter("T", "simple") + `# T\n\n${t}\n`;
  passes(check({ [p]: mk(`[a](${gh}/blob/main/package.json) [b](${gh}/tree/main/examples/modules) [c](${gh}/tree/main/) [d](${gh}/blob/main/package.json#L2)`) }));
  fails(check({ [p]: mk(`[a](${gh}/blob/main/nope.json)`) }), /troubleshooting\.md:9.*DOCS-LINK-002.*nope\.json/);
  fails(check({ [p]: mk(`[a](${gh}/tree/main/package.json)`) }), /DOCS-LINK-002/);
  fails(check({ [p]: mk(`[a](${gh}/blob/main/examples/modules)`) }), /DOCS-LINK-002/);
  fails(check({ "README.md": base("README.md").replace("A co-host.", `A [x](${gh}/blob/main/zzz) co-host.`) }), /README\.md.*DOCS-LINK-002/);
  fails(check({ "examples/README.md": base("examples/README.md") + `[x](${gh}/blob/main/zzz)\n` }), /examples\/README\.md.*DOCS-LINK-002/);
  passes(check({ [p]: mk("[o](https://github.com/OtherOrg/other/blob/main/nope)") }));
});

// @spec DOCS-LINK-003
test("README and examples links to the published site must map to a built file holding the fragment", () => {
  const built = { "index.html": "<html></html>", "guide/install/real-install.html": '<h2 id="x">x</h2>', "advanced/extend/hooks.html": "<html></html>" };
  passes(check({}, ["--dist"], distRaw(built)));
  fails(check({}, ["--dist"], distRaw({ "index.html": "", "advanced/extend/hooks.html": "" })), /README\.md.*DOCS-LINK-003.*real-install/);
  const frag = { "README.md": base("README.md").replace("real-install)", "real-install#nope)") };
  fails(check(frag, ["--dist"], distRaw(built)), /DOCS-LINK-003.*#nope/);
  passes(check({ "README.md": base("README.md").replace("real-install)", "real-install#x)") }, ["--dist"], distRaw(built)));
  // path ending in / maps to index.html
  const idx = { "examples/README.md": base("examples/README.md") + "[t](https://codercoco-studios.github.io/cohost/advanced/testing/)\n" };
  fails(check(idx, ["--dist"], distRaw(built)), /examples\/README\.md.*DOCS-LINK-003.*testing/);
  passes(check(idx, ["--dist"], distRaw({ ...built, "advanced/testing/index.html": "<html></html>" })));
  fails(check({}, ["--dist"], distRaw({ "index.html": "" , "advanced/extend/hooks.html": "" })), /DOCS-LINK-003/);
});

// ---------------------------------------------------------------- Facts

const shellPage = (fence: string, lang = "sh") => frontmatter("T", "simple", "verified: 1a2b3c4\n") + `# T\n\n\`\`\`${lang}\n${fence}\n\`\`\`\n`;
const FP = "docs/guide/troubleshooting.md";

// @spec DOCS-FACT-001
test("mise run and mise watch in shell fences must name a task mise.toml defines", () => {
  passes(check({ [FP]: shellPage("mise run dashboard\nmise run build\nmise run cohostctl -- status\nmise run cohostctl status\nmise r test\nmise run --jobs 2 dashboard\nmise run example:hook-server:py\nmise install\nmise trust\nmise exec -- node -v") }));
  passes(check({ [FP]: shellPage("mise watch --restart dev:chat\nmise watch --restart dev:<service>\nmise run dev:<service>\nmise watch --restart dev:chat ::: dev:cortex\nmise run dev:chat ::: dev:cortex\nmise watch -t dev:chat") }));
  fails(check({ [FP]: shellPage("mise run dashbord") }), /troubleshooting\.md:11.*DOCS-FACT-001.*mise run dashbord.*dashbord/);
  fails(check({ [FP]: shellPage("PORT=4000 mise run nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("cd x && mise run nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("mise run --jobs 2 nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("mise run dev:chat ::: nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("mise watch --restart nope:<service>") }), /DOCS-FACT-001.*nope:<service>/);
  fails(check({ [FP]: shellPage("mise watch --restart dev:chat ::: dev:gone") }), /DOCS-FACT-001.*dev:gone/);
  fails(check({ [FP]: shellPage("mise run example:nope") }), /DOCS-FACT-001.*example:nope/);
  fails(check({ [FP]: shellPage("$ mise run nope\nok", "console") }), /DOCS-FACT-001.*nope/);
  // a fence whose first non-blank line is no command line is skipped
  passes(check({ [FP]: shellPage("mise run nope\n$ mise run nope", "console") }));
  passes(check({ [FP]: shellPage("# mise run nope in a comment-first fence\nmise run nope") }));
  passes(check({ [FP]: shellPage("mise run nope", "text") }));
  fails(check({ "README.md": base("README.md").replace("mise run dashboard", "mise run dashbord") }), /README\.md.*DOCS-FACT-001/);
  // with no mise.toml no task is defined
  fails(check({ "mise.toml": null }), /mise\.toml.*DOCS-FACT-001/);
});

// @spec DOCS-FACT-001
test("a command that runs pnpm or cargo fails unless it is a dependency edit, or is on an Extend page and names no repository path", () => {
  for (const cmd of ["pnpm build", "pnpm dashboard", "pnpm install", "pnpm run test", "pnpm -r build", "pnpm --filter x foo", "cargo build", "cargo run -p cohost-bus", "cd x && pnpm test"]) {
    fails(check({ [FP]: shellPage(cmd) }), /troubleshooting\.md:11.*DOCS-FACT-001.*runs (pnpm|cargo) directly/);
  }
  fails(check({ [FP]: shellPage("pnpm build") }), /DOCS-FACT-001.*"pnpm build"/);
  fails(check({ "README.md": base("README.md").replace("mise run dashboard", "pnpm dashboard") }), /README\.md.*DOCS-FACT-001.*pnpm dashboard/);
  passes(check({ [FP]: shellPage("pnpm add x\npnpm add -D x\npnpm --filter @cohost/bus add x\npnpm remove x\ncargo add serde\ncargo remove serde\ncargo add --manifest-path crates/cohost-bus/Cargo.toml serde") }));
  // an Extend page may run pnpm or cargo on code kept outside the checkout, but not on a path inside it
  const extSh = (cmds: string) => check(extendRepo({ [`${EXT}typescript-service.md`]: guide("Add a TypeScript service", `\`\`\`sh\n${cmds}\n\`\`\`\n`) }));
  assert.doesNotMatch(extSh("cargo run\npnpm install\npnpm exec tsx main.ts").err, /DOCS-FACT-001/);
  assert.match(extSh("cargo run --manifest-path examples/Cargo.toml -p cohost-example-bus").err, /typescript-service\.md.*DOCS-FACT-001.*cargo run --manifest-path examples/);
  assert.match(extSh("pnpm exec tsc -p examples/tsconfig.json").err, /DOCS-FACT-001.*pnpm exec tsc/);
  // the allowance is the Extend pages' alone
  fails(check({ [FP]: shellPage("cargo run") }), /troubleshooting\.md.*DOCS-FACT-001.*cargo run/);
});

// @spec DOCS-FACT-002
test("NAME= assignments in shell and env fences must be named on the environment page", () => {
  passes(check({ [FP]: shellPage("DASHBOARD_PORT=4000 mise run dashboard\nexport LLM_PROVIDER=mock\ncd x") }));
  fails(check({ [FP]: shellPage("PORT=4000 mise run dashboard") }), /troubleshooting\.md:11.*DOCS-FACT-002.*PORT/);
  fails(check({ [FP]: shellPage("export NOPE_X=1") }), /DOCS-FACT-002.*NOPE_X/);
  fails(check({ [FP]: shellPage("NOPE_X=1", "env") }), /DOCS-FACT-002.*NOPE_X/);
  fails(check({ [FP]: shellPage("NOPE_X=1", "dotenv") }), /DOCS-FACT-002.*NOPE_X/);
  passes(check({ [FP]: shellPage("lowercase=1 echo hi\n# NOPE_X=1\nNOPE_X=1", "text") }));
  fails(check({ "README.md": base("README.md").replace("mise run dashboard\n", "NOPE_Y=1 mise run dashboard\n") }), /README\.md.*DOCS-FACT-002.*NOPE_Y/);
});

// @spec DOCS-FACT-003
test("the environment page names every variable .env.example assigns or comments", () => {
  const env = base("docs/advanced/reference/env.md");
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "") }), /env\.md.*DOCS-FACT-003.*LLM_PROVIDER/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `COMPOSE_PROFILES`\n", "") }), /DOCS-FACT-003.*COMPOSE_PROFILES/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "- LLM_PROVIDER in prose, not a code span\n") }), /DOCS-FACT-003.*LLM_PROVIDER/);
  passes(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "- `LLM_PROVIDER=ollama`\n") }));
});

// @spec DOCS-FACT-004
test("the environment page names every published host port with its compose default", () => {
  const env = base("docs/advanced/reference/env.md");
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `6379`\n", "") }), /env\.md.*DOCS-FACT-004.*6379/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `11434`\n", "") }), /DOCS-FACT-004.*11434/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `3001`\n", "").replace("- `DASHBOARD_LAN_PORT`\n", "- `DASHBOARD_LAN_PORT`, nothing else\n") }), /DOCS-FACT-004.*3001/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `3000`\n", "") }), /DOCS-FACT-004.*3000/);
  fails(check({ "docker-compose.yml": base("docker-compose.yml") + '  extra:\n    ports:\n      - "8080:80"\n' }), /DOCS-FACT-004.*8080/);
  passes(check({ "docker-compose.yml": base("docker-compose.yml") + '  extra:\n    ports:\n      - "127.0.0.1:6379:6379"\n' }));
});

// @spec DOCS-FACT-005
test("the configuration page names every key path of config.example.yaml", () => {
  const cfg = base("docs/advanced/reference/config.md");
  for (const path of ["llm", "llm.openai.base_url", "mouth.outputs.discord.gain_db", "mouth.list[].b"]) {
    const re = new RegExp(`- \`${path.replace(/[.[\]]/g, "\\$&")}\`\\n?`);
    fails(check({ "docs/advanced/reference/config.md": cfg.replace(re, "") }), new RegExp(`config\\.md.*DOCS-FACT-005.*${path.replace(/[.[\]]/g, "\\$&")}`));
  }
  // a longer path does not name its prefix, and a suffix does not name the whole path
  fails(check({ "docs/advanced/reference/config.md": cfg.replace("- `llm.openai`\n", "") }), /DOCS-FACT-005.*llm\.openai(?!\.)/);
  fails(check({ "docs/advanced/reference/config.md": cfg.replace("- `mouth.outputs.discord.gain_db`\n", "- `discord.gain_db`\n") }), /DOCS-FACT-005.*mouth\.outputs\.discord\.gain_db/);
  passes(check({ "docs/advanced/reference/config.md": cfg + "\n| `mouth.list[].a` | x |\n" }));
});

// @spec DOCS-FACT-006
test("the bus events page names every registered event type", () => {
  const ev = base("docs/advanced/reference/events.md");
  fails(check({ "docs/advanced/reference/events.md": ev.replace("- `speech.heard`", "") }), /events\.md.*DOCS-FACT-006.*speech\.heard/);
  fails(check({ "packages/bus/src/events.ts": base("packages/bus/src/events.ts").replace('  "speech.heard"', '  "voice.utterance": z.object({}),\n  "speech.heard"') }), /DOCS-FACT-006.*voice\.utterance/);
});

// ---------------------------------------------------------------- Architecture excerpts

const HLD = (extra = "") => `---
title: x
---

# Project

## Problem

The problem text, see [the glossary](other.md#frag) and {{ name }}.

## Approach

How we approach it, with [a dir](intent/) link.

## Target Users

Not excerpted.

## Tenets

1. One.

## System Design

Design.

### Segments

| Taxonomy | Segment | Role (observed) |
| --- | --- | --- |
| platform | alpha | Alpha does a thing |
| brain | beta | Beta does another |

## Key Design Decisions

Decisions.

## Success Metrics
${extra}`;

const LLDX = (name: string, ctx = true) => `---
parent: high-level-design
prefix: X
---

# ${name}

Parent: [hld](../../high-level-design.md).

${ctx ? `## Context and Design Philosophy\n\nWhy ${name} exists, see [spec](./${name}-specs.md#X-001) and [up](../../high-level-design.md) and [other](../beta/beta-design.md).\n\n` : ""}## Other\n\nNot excerpted.\n`;

function designTree(over: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    "docs/high-level-design.md": HLD(),
    "docs/intent/alpha/alpha-design.md": LLDX("alpha"),
    "docs/intent/alpha/alpha-specs.md": "# s\n",
    "docs/intent/beta/beta-design.md": LLDX("beta"),
    "docs/intent/beta/beta-specs.md": "# s\n",
    "docs/intent/alpha/decisions/one.md": "---\nnode: alpha\n---\n\n# Decision: one\n\nBody of one {{ x }}.\n",
    "docs/intent/beta/decisions/two.md": "---\nnode: beta\nsupersedes: ../../alpha/decisions/one.md\n---\n\n# Decision: two\n\nBody of two.\n",
    "docs/decisions/three.md": "# Decision: three\n\nBody of three.\n",
    ...over,
  };
}

/** The docs check over the base fixture plus a design tree (the docs-site leaf LLD joins the HLD's Segments table). */
function checkDesign(over: Record<string, string | null> = {}) {
  const files = designTree({
    "docs/high-level-design.md": HLD().replace("| brain | beta | Beta does another |\n", "| brain | beta | Beta does another |\n| operator | docs-site | The docs |\n"),
    "docs/advanced/architecture/design/[section].md": "<!-- @content -->\n",
    ...over,
  });
  return check(files);
}
function withTree(files: Record<string, string | null>, fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "cohost-design-"));
  const done = () => rmSync(dir, { recursive: true, force: true });
  try {
    writeTree(dir, files);
    mkdirSync(join(dir, "docs/intent"), { recursive: true });
    const r = fn(dir);
    return r instanceof Promise ? r.finally(done) : (done(), r);
  } catch (e) {
    done();
    throw e;
  }
}
const lib = () => load("docs/.vitepress/design-excerpts.mjs");

// @spec DOCS-ARCH-001
test("one design page per HLD section, holding the text up to the next ## heading", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    assert.deepEqual(d.design.map((p: any) => p.slug), ["problem", "approach", "tenets", "system-design", "key-decisions"]);
    assert.deepEqual(d.design.map((p: any) => p.route), ["advanced/architecture/design/problem", "advanced/architecture/design/approach", "advanced/architecture/design/tenets", "advanced/architecture/design/system-design", "advanced/architecture/design/key-decisions"]);
    const problem = d.design[0].content as string;
    assert.match(problem, /## Problem\n\nThe problem text/);
    assert.doesNotMatch(problem, /## Approach/);
    const sys = d.design[3].content as string;
    assert.match(sys, /### Segments/);
    assert.match(sys, /\| brain \| beta \|/);
    assert.doesNotMatch(sys, /## Key Design Decisions/);
    assert.doesNotMatch(problem + sys, /Target Users|Success Metrics/);
  });
});

// @spec DOCS-ARCH-002
test("one segment page per leaf LLD with its Context and Design Philosophy, titled and described", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    assert.deepEqual(d.segments.map((p: any) => p.slug), ["alpha", "beta"]);
    assert.deepEqual(d.segments.map((p: any) => p.route), ["advanced/architecture/segments/alpha", "advanced/architecture/segments/beta"]);
    assert.equal(d.segments[0].title, "alpha");
    assert.equal(d.segments[0].description, "Alpha does a thing");
    assert.equal(d.segments[1].taxonomy, "brain");
    const c = d.segments[0].content as string;
    assert.match(c, /## Context and Design Philosophy\n\nWhy alpha exists/);
    assert.doesNotMatch(c, /## Other|Not excerpted/);
  });
});

// @spec DOCS-ARCH-002
test("a folder without both design and specs files is not a leaf LLD", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree({ "docs/intent/gamma/gamma-design.md": LLDX("gamma") }), async (dir) => {
    assert.equal(loadDesign(dir).segments.length, 2);
  });
  await withTree(designTree({ "docs/intent/notes/readme.md": "x" }), async (dir) => {
    assert.equal(loadDesign(dir).segments.length, 2);
  });
});

// @spec DOCS-ARCH-003
test("one decision page per decision document, whole and without frontmatter, superseded ones skipped", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    assert.deepEqual(d.decisions.map((p: any) => p.slug).toSorted(), ["three", "two"]);
    const two = d.decisions.find((p: any) => p.slug === "two");
    assert.equal(two.route, "advanced/architecture/decisions/two");
    assert.match(two.content, /# Decision: two\n\nBody of two\./);
    assert.doesNotMatch(two.content, /supersedes|node: beta/);
    assert.equal(d.decisions.find((p: any) => p.slug === "one"), undefined);
  });
  // supersedes may be a list
  await withTree(designTree({ "docs/decisions/three.md": "---\nsupersedes:\n  - ../intent/alpha/decisions/one.md\n  - ../intent/beta/decisions/two.md\n---\n\n# three\n" }), async (dir) => {
    assert.deepEqual(loadDesign(dir).decisions.map((p: any) => p.slug), ["three"]);
  });
});

// @spec DOCS-ARCH-004
test("loaders fail naming the file when the design tree is inconsistent", async () => {
  const { loadDesign } = await lib();
  const bad = (over: Record<string, string | null>, re: RegExp) => withTree(designTree(over), (dir) => assert.throws(() => loadDesign(dir), re));
  await bad({ "docs/intent/beta/beta-design.md": LLDX("beta", false) }, /beta-design\.md.*Context and Design Philosophy/);
  await bad({ "docs/high-level-design.md": HLD().replace("## Tenets", "## Tenet") }, /high-level-design\.md.*Tenets/);
  await bad({ "docs/intent/gamma/gamma-design.md": LLDX("gamma"), "docs/intent/gamma/gamma-specs.md": "x" }, /high-level-design\.md.*gamma|gamma.*Segments/);
  await bad({ "docs/high-level-design.md": HLD().replace("| brain | beta | Beta does another |\n", "") }, /beta/);
  await bad({ "docs/decisions/one.md": "# dup\n" }, /one\.md/);
  await bad({ "docs/intent/beta/decisions/two.md": "---\nsupersedes: ../../alpha/decisions/missing.md\n---\n\n# two\n" }, /two\.md.*missing\.md/);
  await bad({ "docs/decisions/three.md": "---\nsupersedes: [unclosed\n---\n\n# three\n" }, /three\.md/);
  await bad({ "docs/decisions/three.md": "---\nnever closed\n# three\n" }, /three\.md/);
  await bad({ "docs/intent/alpha/alpha-design.md": "---\nkey: [unclosed\n---\n\n## Context and Design Philosophy\n\nx\n" }, /alpha-design\.md/);
});

// @spec DOCS-ARCH-004
test("the docs check reports a loader failure with the file and exits 1", () => {
  fails(checkDesign({ "docs/intent/beta/beta-design.md": LLDX("beta", false) }), /beta-design\.md.*DOCS-ARCH-004/);
});

// @spec DOCS-ARCH-005
test("every excerpt opens with a line naming and linking its source on GitHub", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    const gh = "https://github.com/CoderCoco-Studios/cohost/blob/main/";
    const sources: Record<string, string> = { problem: "docs/high-level-design.md", alpha: "docs/intent/alpha/alpha-design.md", two: "docs/intent/beta/decisions/two.md", three: "docs/decisions/three.md" };
    for (const p of [...d.design, ...d.segments, ...d.decisions]) {
      const body = (p.content as string).replace(/^---[\s\S]*?---\n/, "");
      const first = body.split("\n").find((l: string) => l.trim() && !l.startsWith(":::"))!;
      assert.match(first, /full document/i, p.slug);
      assert.ok(first.includes("`" + p.source + "`") || first.includes(p.source), p.slug);
      assert.ok(first.includes(`](${gh}${p.source})`), `${p.slug}: ${first}`);
      if (sources[p.slug]) assert.equal(p.source, sources[p.slug]);
    }
  });
});

// @spec DOCS-ARCH-006
test("relative links in an excerpt become GitHub blob or tree URLs against the source directory, fragments kept", async () => {
  const { loadDesign, rewriteLinks } = await lib();
  const gh = "https://github.com/CoderCoco-Studios/cohost";
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    const seg = d.segments[0].content as string;
    assert.ok(seg.includes(`(${gh}/blob/main/docs/intent/alpha/alpha-specs.md#X-001)`), seg);
    assert.ok(seg.includes(`(${gh}/blob/main/docs/high-level-design.md)`));
    assert.ok(seg.includes(`(${gh}/blob/main/docs/intent/beta/beta-design.md)`));
    const approach = d.design[1].content as string;
    assert.ok(approach.includes(`(${gh}/tree/main/docs/intent/)`) || approach.includes(`(${gh}/tree/main/docs/intent)`), approach);
    assert.ok((d.design[0].content as string).includes(`(${gh}/blob/main/docs/other.md#frag)`));
    const text = "[a](https://x.org/y) [b](#top) [c](mailto:a@b.c) [d](/abs) `[e](rel.md)`\n```\n[f](rel.md)\n```\n[g](rel.md)";
    const out = rewriteLinks(text, "docs/intent/alpha/alpha-design.md", dir) as string;
    assert.ok(out.includes("(https://x.org/y)") && out.includes("(mailto:a@b.c)") && out.includes("(/abs)"));
    assert.ok(out.includes("`[e](rel.md)`") && out.includes("```\n[f](rel.md)\n```"));
    assert.ok(out.includes(`[g](${gh}/blob/main/docs/intent/alpha/rel.md)`));
    assert.ok(out.includes(`[b](${gh}/blob/main/docs/intent/alpha/alpha-design.md#top)`));
  });
});

// @spec DOCS-ARCH-006
// @spec DOCS-LINK-002
test("the docs check fails an excerpt link that rewrites to a path that does not exist", () => {
  fails(checkDesign({ "docs/intent/alpha/alpha-design.md": LLDX("alpha").replace("[spec](./alpha-specs.md#X-001)", "[spec](./missing.md)") }), /alpha-design\.md.*DOCS-LINK-002.*missing\.md/);
});

// @spec DOCS-ARCH-007
test("excerpt content is wrapped so Vue interpolation is off", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    for (const p of [...d.design, ...d.segments, ...d.decisions]) {
      const body = (p.content as string).replace(/^---[\s\S]*?\n---\n/, "");
      assert.match(body, /::: v-pre\n[\s\S]*\n:::\s*$/, p.slug);
    }
    assert.match(d.design[0].content, /\{\{ name \}\}/);
  });
});

// @spec DOCS-ARCH-008
test("the sidebar's Architecture group comes from the loaders in the order the design gives", async () => {
  const { architectureSidebar } = await lib();
  await withTree(designTree(), async (dir) => {
    const items = architectureSidebar(dir) as any[];
    assert.equal(items[0].link, "/advanced/architecture/");
    assert.deepEqual(items.slice(1).map((i) => i.text), ["Design", "Segments", "Decisions"]);
    assert.deepEqual(items[1].items.map((i: any) => i.link), ["problem", "approach", "tenets", "system-design", "key-decisions"].map((s) => `/advanced/architecture/design/${s}`));
    assert.deepEqual(items[2].items.map((g: any) => [g.text, g.collapsed, g.items.map((i: any) => i.link)]), [
      ["platform", true, ["/advanced/architecture/segments/alpha"]],
      ["brain", true, ["/advanced/architecture/segments/beta"]],
    ]);
    assert.deepEqual(items[3].items.map((i: any) => i.link), ["/advanced/architecture/decisions/three", "/advanced/architecture/decisions/two"]);
    assert.ok([items[1], items[2], items[3]].every((i) => i.collapsed === true));
  });
});

// @spec DOCS-ARCH-008
test("the docs check fails when an excerpt page is missing from the sidebar", () => {
  fails(checkDesign(), /DOCS-IA-004.*advanced\/architecture\/design\/problem/);
});

// @spec DOCS-ARCH-009
test("the Reading the design page must say excerpts are shown as written and link the glossary", () => {
  const p = "docs/advanced/architecture/index.md";
  const fm = frontmatter("Reading the design", "advanced");
  fails(check({ [p]: fm + "# Reading the design\n\nExcerpts are shown as written, not held to the wording rules. See the [glossary](../../start/glossary.md).\n" }), /DOCS-ARCH-009.*glossary/);
  fails(check({ [p]: fm + "# Reading the design\n\nA page. See the [glossary](../../start/glossary.md).\n" }), /DOCS-ARCH-009/);
  fails(check({ [p]: fm + "# Reading the design\n\nExcerpts shown as written, not held to the site's wording and glossary-link rules.\n" }), /DOCS-ARCH-009.*link/);
});

// @spec DOCS-ARCH-010
test("every excerpt page carries track advanced, a title and a description", async () => {
  const { loadDesign } = await lib();
  await withTree(designTree(), async (dir) => {
    const d = loadDesign(dir);
    for (const p of [...d.design, ...d.segments, ...d.decisions]) {
      assert.equal(p.track, "advanced");
      assert.ok(p.title && p.description, p.slug);
      const fm = /^---\n([\s\S]*?)\n---/.exec(p.content as string)?.[1];
      assert.ok(fm, p.slug);
      assert.match(fm, /^track: advanced$/m);
      assert.match(fm, /^title: .+$/m);
      assert.match(fm, /^description: .+$/m);
    }
    assert.equal(d.decisions.find((p: any) => p.slug === "three").title, "three");
  });
});

// @spec DOCS-ARCH-001, DOCS-ARCH-002, DOCS-ARCH-003, DOCS-ARCH-010
test("each route has a template and a *.paths.mjs loader that returns the pages' params and content", async () => {
  const base = "docs/advanced/architecture";
  const cases: [string, string, string[]][] = [
    ["design", "section", ["problem", "approach", "tenets", "system-design", "key-decisions"]],
    ["segments", "segment", []],
    ["decisions", "decision", []],
  ];
  for (const [dir, param, expectSlugs] of cases) {
    assert.ok(existsSync(join(repoRoot, base, dir, `[${param}].md`)), `${dir} template`);
    const mod = await load(`${base}/${dir}/[${param}].paths.mjs`);
    const paths = await mod.default.paths();
    assert.ok(paths.length > 0, dir);
    for (const p of paths) {
      assert.ok(p.params[param], dir);
      assert.match(p.content, /^---\n[\s\S]*track: advanced[\s\S]*---\n/);
    }
    if (expectSlugs.length) assert.deepEqual(paths.map((p: any) => p.params[param]), expectSlugs);
    assert.match(read(`${base}/${dir}/[${param}].md`), /<!--\s*@content\s*-->/);
  }
});

// ---------------------------------------------------------------- README

const readmeWith = (fn: (t: string) => string) => ({ "README.md": fn(base("README.md")) });

// @spec DOCS-README-001
test("README.md is at most 60 lines", () => {
  fails(check(readmeWith((t) => t + "\n".repeat(60))), /README\.md.*DOCS-README-001/);
  passes(check(readmeWith((t) => t.trimEnd() + "\n")));
});

// @spec DOCS-README-002
test("README.md has exactly the sections Quick start, Documentation, License in order", () => {
  fails(check(readmeWith((t) => t.replace("## Documentation", "## Docs"))), /README\.md.*DOCS-README-002/);
  fails(check(readmeWith((t) => t + "\n## Extra\n")), /DOCS-README-002/);
  fails(check(readmeWith((t) => t.replace("## License", "## Docs2").replace("## Documentation", "## License").replace("## Docs2", "## Documentation"))), /DOCS-README-002/);
});

// @spec DOCS-README-003
test("the README quick start clones, changes directory, then at most five commands, and reaches mock mode by an isolated start", () => {
  fails(check(readmeWith((t) => t.replace("cd cohost\n", ""))), /README\.md.*DOCS-README-003.*cd/);
  fails(check(readmeWith((t) => t.replace("git clone https://github.com/CoderCoco-Studios/cohost.git\n", ""))), /DOCS-README-003.*clone/);
  fails(check(readmeWith((t) => t.replace("scripts/install.sh\n", ""))), /DOCS-README-003.*install\.sh/);
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "mise run build\n"))), /DOCS-README-003.*mise run dashboard/);
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "pnpm dashboard\n"))), /DOCS-README-003.*mise run dashboard/);
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "mise run dashboard:ui\n"))), /DOCS-README-003.*mise run dashboard/);
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "mise run build\nmise run test\nmise run build\nmise run build\nmise run dashboard\n"))), /DOCS-README-003.*(five|5)/);
  fails(check(readmeWith((t) => t.replace(/\[Install for real\]\([^)]*\)/, "[Install](https://codercoco-studios.github.io/cohost/)"))), /DOCS-README-003.*real-install/);
  // nothing is appended to .env, whatever the form
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "echo X=1 >> .env\nmise run dashboard\n"))), /DOCS-README-003.*\.env/);
  fails(check(readmeWith((t) => t.replace("mise run dashboard\n", "cp .env.example .env\nmise run dashboard\n"))), /DOCS-README-003.*\.env/);
  // the isolated start is named in the prose of the section
  fails(check(readmeWith((t) => t.replace(/tick isolated[^;]*;/, "start the services;"))), /DOCS-README-003.*isolated/);
  passes(check(readmeWith((t) => t.replace("scripts/install.sh\n", "scripts/install.sh\ntrue\ntrue\n"))));
});

// @spec DOCS-README-004
test("README.md links the docs site", () => {
  fails(check(readmeWith((t) => t.replace("Read the [docs](https://codercoco-studios.github.io/cohost/).", "Read the docs."))), /README\.md.*DOCS-README-004/);
});

// ---------------------------------------------------------------- Examples

// @spec DOCS-EX-001
test("every README under examples/ is at most 30 lines and links the site", () => {
  fails(check({ "examples/README.md": base("examples/README.md") + "\n".repeat(30) }), /examples\/README\.md.*DOCS-EX-001/);
  fails(check({ "examples/README.md": "# Examples\n\n- `modules/`: a thing.\n" }), /examples\/README\.md.*DOCS-EX-001.*link/);
  fails(check({ "examples/modules/deep/README.md": "# deep\n" }), /examples\/modules\/deep\/README\.md.*DOCS-EX-001/);
});

// @spec DOCS-EX-003
test("the examples README lists each directory with a description", () => {
  const files = { "examples/extra/run.sh": "echo\n" };
  fails(check(files), /examples\/README\.md.*DOCS-EX-003.*extra/);
  passes(check({ ...files, "examples/README.md": base("examples/README.md") + "- `extra/`: a script to run.\n" }));
  fails(check({ ...files, "examples/README.md": base("examples/README.md") + "- `extra/`\n" }), /DOCS-EX-003.*extra/);
});

// @spec DOCS-EX-004
test("every examples directory holds a file other than its README", () => {
  const files = { "examples/prose/README.md": "# p\n\n[docs](https://codercoco-studios.github.io/cohost/)\n", "examples/README.md": base("examples/README.md") + "- `prose/`: only prose here.\n" };
  fails(check(files), /examples\/prose.*DOCS-EX-004/);
  passes(check({ ...files, "examples/prose/run.sh": "echo\n" }));
});

// @spec DOCS-EX-003, DOCS-EX-004
test("cargo's target/ and node_modules/ under examples/ are build output, not example directories", () => {
  passes(check({ "examples/target/debug/build.log": "x\n", "examples/node_modules/p/index.js": "x\n" }));
});

// ---------------------------------------------------------------- Theme (DOCS-THEME-*)

const T = "docs/.vitepress/theme/";
const CFG = "docs/.vitepress/config.ts";
const mut = (text: string, from: string | RegExp, to: string): string => {
  const r = text.replace(from, to);
  assert.notEqual(r, text, `the fixture does not contain ${from}`);
  return r;
};
const style = (fn: (css: string) => string) => ({ [`${T}style.css`]: fn(STYLE_CSS) });
const styleMut = (from: string | RegExp, to: string) => style((css) => mut(css, from, to));
const setToken = (css: string, block: ":root" | ".dark", token: string, value: string) => {
  const i = css.indexOf(`${block} {`);
  const j = css.indexOf("}", i);
  const seg = mut(css.slice(i, j), new RegExp(`(--cohost-${token}:) [^;]+;`), `$1 ${value};`);
  return css.slice(0, i) + seg + css.slice(j);
};
const tokens = (fn: (css: string) => string) => ({ [`${T}tokens.css`]: fn(TOKENS_CSS) });
const cfgMut = (from: string | RegExp, to: string) => ({ [CFG]: mut(base(CFG), from, to) });
const pkgMut = (fn: (o: any) => void) => {
  const o = JSON.parse(base("package.json"));
  fn(o);
  return { "package.json": JSON.stringify(o) };
};
const markMut = (from: string | RegExp, to: string) => ({ [`${T}components/CohostMark.vue`]: mut(MARK_VUE, from, to) });
const indexMd = (fn: (body: string) => string) => {
  const t = base("docs/index.md");
  return { "docs/index.md": mut(t, FLOW_BODY, fn(FLOW_BODY)) };
};

test("the theme fixture passes the docs check's source pass", () => {
  passes(check());
});

// @spec DOCS-THEME-001
test("the theme entry exists and extends VitePress's default theme", () => {
  fails(check({ [`${T}index.ts`]: null }), /theme\/index\.ts.*DOCS-THEME-001/);
  fails(check({ [`${T}index.ts`]: "export default {};\n" }), /DOCS-THEME-001.*vitepress\/theme/);
  fails(check({ [`${T}index.ts`]: "import DefaultTheme from 'vitepress/theme';\nexport default DefaultTheme;\n" }), /DOCS-THEME-001.*extends/);
});

// @spec DOCS-THEME-002
test("tokens.css has exactly a :root and a .dark block of six-digit hex --cohost- tokens, the same in both", () => {
  fails(check(tokens((c) => setToken(c, ".dark", "bg", "red"))), /tokens\.css.*DOCS-THEME-002.*--cohost-bg.*\.dark/);
  fails(check(tokens((c) => setToken(c, ":root", "bg", "#FFF"))), /DOCS-THEME-002.*--cohost-bg.*:root/);
  fails(check(tokens((c) => setToken(c, ":root", "bg", "rgb(1, 2, 3)"))), /DOCS-THEME-002.*--cohost-bg/);
  fails(check(tokens((c) => mut(c, "  --cohost-bg: #1A1420;\n", ""))), /DOCS-THEME-002.*--cohost-bg.*\.dark/);
  fails(check(tokens((c) => c + "body { color: red; }\n")), /DOCS-THEME-002/);
  fails(check(tokens((c) => c + "@media print { .dark { --cohost-bg: #FFFFFF; } }\n")), /DOCS-THEME-002/);
  fails(check(tokens((c) => c.replace(".dark {", "html.dark {"))), /DOCS-THEME-002/);
  fails(check({ [`${T}tokens.css`]: null }), /tokens\.css.*DOCS-THEME-002/);
});

// @spec DOCS-THEME-003
test("tokens.css declares exactly the Palette table's tokens with its light and dark values", () => {
  fails(check(tokens((c) => setToken(c, ":root", "accent", "#E0583E"))), /DOCS-THEME-003.*accent.*#E0583E/);
  fails(check(tokens((c) => setToken(c, ".dark", "accent", "#FF8A71"))), /DOCS-THEME-003.*accent.*#FF8A71/);
  fails(check(tokens((c) => c.replace(/\n\}\n/g, "\n  --cohost-extra: #000000;\n}\n"))), /DOCS-THEME-003.*extra/);
  fails(check(tokens((c) => c.replace(/  --cohost-focus: [^;]+;\n/g, ""))), /DOCS-THEME-003.*focus/);
  passes(check(tokens((c) => setToken(c, ":root", "accent", "#e0583f"))));
});

// @spec DOCS-THEME-004
test("every Contrast pairs row reaches its minimum in the light and the dark block", () => {
  fails(check(tokens((c) => setToken(c, ":root", "text-3", "#BBBBBB"))), /DOCS-THEME-004.*text-3.*bg.*light.*\d\.\d+/);
  fails(check(tokens((c) => setToken(c, ".dark", "mascot-body", "#221B28"))), /DOCS-THEME-004.*mascot-body.*bg.*dark/);
  // a ratio just below the minimum fails: ratios are compared unrounded
  fails(check(tokens((c) => setToken(c, ":root", "accent", "#EE6E55"))), /DOCS-THEME-004.*accent/);
});

// @spec DOCS-THEME-005
test("style.css maps each VitePress colour variable to a palette token in a top-level :root rule", () => {
  fails(check(styleMut("  --vp-c-bg-alt: var(--cohost-bg-alt);\n", "")), /style\.css.*DOCS-THEME-005.*--vp-c-bg-alt/);
  fails(check(styleMut("--vp-c-text-2: var(--cohost-text-2);", "--vp-c-text-2: #574B63;")), /DOCS-THEME-005.*--vp-c-text-2/);
  fails(check(styleMut("--vp-code-bg: var(--cohost-code-inline-bg);", "--vp-code-bg: var(--cohost-nope);")), /DOCS-THEME-005.*--vp-code-bg/);
  fails(check(styleMut("--vp-custom-block-danger-text: var(--cohost-text-1);", "--vp-custom-block-danger-text: var(--cohost-text-1) !important;")), /DOCS-THEME-005.*danger-text/);
  fails(check(style((c) => mut(mut(c, /^:root \{\n/, "@media (min-width: 1px) {\n:root {\n"), /\n\}\n\nh1/, "\n}\n}\n\nh1"))), /DOCS-THEME-005/);
});

// @spec DOCS-THEME-006
test("the config sets markdown.theme to the two GitHub high-contrast themes", () => {
  fails(check(cfgMut("'github-dark-default'", "'github-dark'")), /config\.ts.*DOCS-THEME-006/);
  fails(check(cfgMut("light: 'github-light-high-contrast'", "light: 'github-light'")), /DOCS-THEME-006/);
  fails(check(cfgMut(/  markdown:.*\n/, "")), /DOCS-THEME-006/);
});

// @spec DOCS-THEME-007
test("every colour of the configured Shiki themes reaches 4.5:1 against code-bg in its mode", () => {
  fails(check(cfgMut("'github-light-high-contrast'", "'solarized-light'")), /DOCS-THEME-007.*solarized-light.*#[0-9a-fA-F]{6}.*\d\.\d+/);
  fails(check(cfgMut("'github-dark-default'", "'solarized-dark'")), /DOCS-THEME-007.*solarized-dark/);
  // the dark theme is held to the dark code-bg, so a light-on-light-bg value fails there
  fails(check(tokens((c) => setToken(c, ".dark", "code-bg", "#FFFFFF"))), /DOCS-THEME-007.*github-dark-default/);
});

// @spec DOCS-THEME-008
test("the theme CSS declares no @font-face", () => {
  fails(check(style((c) => c + "@font-face { font-family: X; src: url(x.woff2); }\n")), /style\.css.*DOCS-THEME-008/);
  fails(check(tokens((c) => c + "@font-face { font-family: X; }\n")), /DOCS-THEME-008/);
});

// @spec DOCS-THEME-055
test("the root package.json lists no font package", () => {
  fails(check(pkgMut((o) => (o.devDependencies["@fontsource/inter"] = "1.0.0"))), /package\.json.*DOCS-THEME-055.*@fontsource\/inter/);
  fails(check(pkgMut((o) => (o.dependencies = { "typeface-font-x": "1.0.0" }))), /DOCS-THEME-055.*typeface-font-x/);
});

// @spec DOCS-THEME-009
test("the config leaves appearance unset or true", () => {
  passes(check({ [CFG]: mut(base(CFG), "base:", "appearance: true, base:") }));
  fails(check({ [CFG]: mut(base(CFG), "base:", "appearance: false, base:") }), /config\.ts.*DOCS-THEME-009/);
  fails(check({ [CFG]: mut(base(CFG), "base:", "appearance: 'dark', base:") }), /DOCS-THEME-009/);
});

// @spec DOCS-THEME-011
test("the config's head holds no script element", () => {
  fails(check(cfgMut(/head: \[\[.*\n/, "head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/cohost/favicon.svg' }], ['script', { src: 'https://x/a.js' }]],\n")), /config\.ts.*DOCS-THEME-011/);
  fails(check(cfgMut(/head: \[\[.*\n/, "head: [['script', {}, 'track()']],\n")), /DOCS-THEME-011/);
});

// @spec DOCS-THEME-012
test("the mark component keeps its limits: class, viewBox, at most 12 shapes per expression, no forbidden elements", () => {
  fails(check(markMut('class="cohost-mark" ', "")), /CohostMark\.vue.*DOCS-THEME-012.*cohost-mark/);
  fails(check(markMut('viewBox="0 0 64 64"', 'viewBox="0 0 32 32"')), /DOCS-THEME-012.*viewBox/);
  fails(check(markMut(/(<g v-if="expression === 'lost'">)/, '<text x="1" y="1">hi</text>\n    $1')), /DOCS-THEME-012.*text/);
  for (const el of ["image", "use", "style", "linearGradient", "radialGradient", "filter", "mask"]) {
    fails(check(markMut(/(<g v-if="expression === 'lost'">)/, `<${el}></${el}>\n    $1`)), new RegExp(`DOCS-THEME-012.*${el}`, "i"));
  }
  const extra = (n: number, cond: string) => Array.from({ length: n }, () => `<circle ${cond} cx="1" cy="1" r="3" fill="var(--cohost-mascot-face)" />`).join("\n    ");
  fails(check(markMut(/(<g v-if="expression === 'lost'">)/, `${extra(3, "")}\n    $1`)), /DOCS-THEME-012.*13.*idle/);
  // only the lost expression exceeds the limit: 8 shapes plus 5
  const lost = check(markMut(/(<g v-if="expression === 'lost'">)/, `${extra(5, 'v-if="expression === \'lost\'"')}\n    $1`));
  fails(lost, /DOCS-THEME-012.*lost/);
  assert.doesNotMatch(lost.err, /DOCS-THEME-012.*idle/);
  assert.doesNotMatch(lost.err, /DOCS-THEME-012.*talking/);
  passes(check(markMut(/(<g v-if="expression === 'lost'">)/, `${extra(2, "")}\n    $1`)));
});

// @spec DOCS-THEME-013
test("every fill and stroke in the mark component is none or a mascot token", () => {
  fails(check(markMut('fill="var(--cohost-mascot-face)"', 'fill="#FFFFFF"')), /CohostMark\.vue.*DOCS-THEME-013.*fill/);
  fails(check(markMut('stroke="var(--cohost-mascot-headset)"', 'stroke="currentColor"')), /DOCS-THEME-013.*stroke/);
  fails(check(markMut('fill="var(--cohost-mascot-body)" />\n    <path', 'fill="var(--cohost-bg)" />\n    <path')), /DOCS-THEME-013/);
  fails(check(markMut('<path d="M10 28', '<path style="fill: red" d="M10 28')), /DOCS-THEME-013/);
});

// @spec DOCS-THEME-014
test("the mark component takes an expression prop (idle, talking, lost; default idle) shown as data-expression", () => {
  fails(check(markMut("'idle' | 'talking' | 'lost'", "'idle' | 'lost'")), /CohostMark\.vue.*DOCS-THEME-014.*talking/);
  fails(check(markMut("{ expression: 'idle' }", "{ expression: 'lost' }")), /DOCS-THEME-014.*idle/);
  fails(check(markMut(':data-expression="expression"', 'data-expression="idle"')), /DOCS-THEME-014.*data-expression/);
});

// @spec DOCS-THEME-017
test("favicon.svg exists, has the 64 viewBox and uses only the light mascot colours as hex literals", () => {
  fails(check({ "docs/public/favicon.svg": null }), /favicon\.svg.*DOCS-THEME-017/);
  fails(check({ "docs/public/favicon.svg": mut(FAVICON_SVG, 'viewBox="0 0 64 64"', 'viewBox="0 0 16 16"') }), /DOCS-THEME-017.*viewBox/);
  fails(check({ "docs/public/favicon.svg": mut(FAVICON_SVG, "#6B3FBF", "#8F6BEA") }), /DOCS-THEME-017.*#8F6BEA/i);
  fails(check({ "docs/public/favicon.svg": mut(FAVICON_SVG, 'fill="#ffffff"', 'fill="white"') }), /DOCS-THEME-017.*white/);
  fails(check({ "docs/public/favicon.svg": mut(FAVICON_SVG, 'fill="#ffffff"', 'style="fill:var(--cohost-mascot-face)"') }), /DOCS-THEME-017/);
  passes(check({ "docs/public/favicon.svg": mut(FAVICON_SVG, "#6B3FBF", "#6b3fbf") }));
});

// @spec DOCS-THEME-021
test("each track badge takes its track's text token on its bg token, selected by data-track", () => {
  fails(check(styleMut("color: var(--cohost-badge-simple-text); background-color: var(--cohost-badge-simple-bg);", "color: var(--cohost-badge-simple-text);")), /style\.css.*DOCS-THEME-021.*simple/);
  fails(check(styleMut("color: var(--cohost-badge-project-text);", "color: var(--cohost-badge-start-text);")), /DOCS-THEME-021.*project/);
  fails(check(styleMut(".cohost-track-badge[data-track='start']", ".cohost-track-badge")), /DOCS-THEME-021.*start/);
});

// @spec DOCS-THEME-022
test("the aside has the aside-bg background, a 4px solid accent left border, an aside-title title and no italics", () => {
  fails(check(styleMut("background: var(--cohost-aside-bg); border-left", "background: var(--cohost-bg-soft); border-left")), /DOCS-THEME-022.*aside-bg/);
  fails(check(styleMut("border-left: 4px solid var(--cohost-accent); border-radius", "border-left: 3px solid var(--cohost-accent); border-radius")), /DOCS-THEME-022.*border/);
  fails(check(styleMut("border-left: 4px solid var(--cohost-accent); border-radius", "border-left: 4px solid var(--cohost-text-3); border-radius")), /DOCS-THEME-022.*accent/);
  fails(check(styleMut("color: var(--cohost-aside-title);", "color: var(--cohost-text-1);")), /DOCS-THEME-022.*aside-title/);
  fails(check(style((c) => c + ".cohost-aside p { font-style: italic; }\n")), /DOCS-THEME-022.*italic/);
});

// @spec DOCS-THEME-023
test("the aside title is preceded by the mark drawn as a mask-image with a data: URL", () => {
  fails(check(style((c) => c.replace(/  mask-image: url\("data[^\n]*\n/, "").replace(/  -webkit-mask-image: url\("data[^\n]*\n/, ""))), /DOCS-THEME-023/);
  fails(check(styleMut(/  mask-image: url\("data[^\n]*\n/, '  mask-image: url("https://x.example/m.svg");\n')), /DOCS-THEME-023.*data:/);
  fails(check(styleMut(".cohost-aside-title::before", ".cohost-aside-title::after")), /DOCS-THEME-023/);
});

// @spec DOCS-THEME-024
test("tip, info, warning, danger and details blocks get a 4px left border and a title colour in their title token", () => {
  fails(check(styleMut(".vp-doc .custom-block.tip { border-left: 4px solid var(--cohost-tip-title); }", ".vp-doc .custom-block.tip { border-left: 2px solid var(--cohost-tip-title); }")), /DOCS-THEME-024.*tip/);
  fails(check(styleMut("custom-block.warning .custom-block-title { color: var(--cohost-warning-title)", "custom-block.warning .custom-block-title { color: var(--cohost-danger-title)")), /DOCS-THEME-024.*warning/);
  fails(check(styleMut(".vp-doc .custom-block.details { border-left: 4px solid var(--cohost-info-title); }", ".vp-doc .custom-block.details { border-left: 4px solid var(--cohost-tip-title); }")), /DOCS-THEME-024.*details/);
  fails(check(styleMut(".vp-doc .custom-block.details summary { color: var(--cohost-info-title); }", "")), /DOCS-THEME-024.*details/);
});

// @spec DOCS-THEME-028
test("the Mermaid renderer module calls beautiful-mermaid with exactly the palette options", () => {
  const f = "docs/.vitepress/mermaid-fence.mjs";
  fails(check({ [f]: mut(MERMAID_FENCE_MJS, "transparent: true", "transparent: false") }), /mermaid-fence\.mjs.*DOCS-THEME-028.*transparent/);
  fails(check({ [f]: mut(MERMAID_FENCE_MJS, "font: 'Inter',", "font: 'Inter', theme: 'x',") }), /DOCS-THEME-028.*theme/);
  fails(check({ [f]: mut(MERMAID_FENCE_MJS, "  border: 'var(--cohost-text-3)',\n", "") }), /DOCS-THEME-028.*border/);
  fails(check({ [f]: null }), /DOCS-THEME-028.*beautiful-mermaid/);
  passes(check({ [f]: mut(MERMAID_FENCE_MJS, /'var\(--cohost-bg\)'/, '"var(--cohost-bg)"') }));
});

// @spec DOCS-THEME-031
test(".cohost-diagram scrolls horizontally and its svg keeps its natural width", () => {
  fails(check(styleMut(".cohost-diagram { overflow-x: auto; }", ".cohost-diagram { overflow-x: hidden; }")), /DOCS-THEME-031.*overflow-x/);
  fails(check(styleMut("max-width: none;", "max-width: 100%;")), /DOCS-THEME-031.*max-width/);
  fails(check(styleMut("width: auto;", "width: 100%;")), /DOCS-THEME-031.*width/);
  fails(check(styleMut("max-width: none;", "max-width: none; min-width: 640px;")), /DOCS-THEME-031.*min-width/);
});

// @spec DOCS-THEME-027
test("the fence renderer throws an Error naming the source file and the fence's 1-based opening line", async () => {
  const { createMarkdownRenderer } = await import("vitepress");
  const { mermaidFence } = await import(pathToFileURL(join(repoRoot, "docs/.vitepress/mermaid-fence.mjs")).href);
  const dir = mkdtempSync(join(tmpdir(), "mermaid-fence-"));
  try {
    const md = await createMarkdownRenderer(dir, {}, "/cohost/");
    md.use(mermaidFence);
    const src = "# Title\n\nSome text.\n\n```mermaid\nthis is not a diagram ???\n```\n";
    const file = join(dir, "page.md");
    writeTree(dir, { "page.md": src });
    assert.throws(
      () => md.render(src, { path: file, relativePath: "page.md" }),
      (e: unknown) => e instanceof Error && e.message.includes("page.md:5") && /cannot render the mermaid diagram/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// @spec DOCS-THEME-032, DOCS-THEME-052
test("beautiful-mermaid is a devDependency at an exact version and no Mermaid package is listed", () => {
  fails(check(pkgMut((o) => (o.devDependencies["beautiful-mermaid"] = "^1.1.3"))), /package\.json.*DOCS-THEME-032.*\^1\.1\.3/);
  fails(check(pkgMut((o) => (o.devDependencies["beautiful-mermaid"] = "~1.1.3"))), /DOCS-THEME-032/);
  fails(check(pkgMut((o) => delete o.devDependencies["beautiful-mermaid"])), /DOCS-THEME-032/);
  fails(check(pkgMut((o) => (o.dependencies = { "beautiful-mermaid": "1.1.3" }))), /DOCS-THEME-032.*dependencies/);
  fails(check(pkgMut((o) => (o.devDependencies.mermaid = "11.0.0"))), /DOCS-THEME-052.*mermaid/);
  fails(check(pkgMut((o) => (o.devDependencies["vitepress-plugin-mermaid"] = "2.0.0"))), /DOCS-THEME-052.*vitepress-plugin-mermaid/);
  fails(check(pkgMut((o) => (o.optionalDependencies = { mermaid: "11.0.0" }))), /DOCS-THEME-052/);
});

// @spec DOCS-THEME-034
test("the home page holds one flow container with an ordered list of six steps in order and a How it works link", () => {
  fails(check(indexMd((b) => b + "\n" + b.slice(b.indexOf("::: flow")))), /index\.md.*DOCS-THEME-034.*one/);
  fails(check(indexMd((b) => b.replace("::: flow", ":::"))), /DOCS-THEME-034.*flow/);
  fails(check(indexMd((b) => b.replace("6. **The avatar** moves its mouth.\n", ""))), /DOCS-THEME-034.*six/);
  fails(check(indexMd((b) => b.replace("1. **Chat** hears the line.", "1. **Hearing** the line.").replace("4. **Voice**", "4. **Chat**"))), /DOCS-THEME-034.*item 1.*chat/i);
  fails(check(indexMd((b) => b.replace("**Voice** turns", "**Speaker** turns"))), /DOCS-THEME-034.*item 4.*voice/i);
  fails(check(indexMd((b) => b.replace("**The avatar** moves", "**The puppet** moves"))), /DOCS-THEME-034.*item 6.*avatar/i);
  fails(check(indexMd((b) => b.replace("See [How it works](start/how-it-works.md) for the whole journey.", "See the journey."))), /DOCS-THEME-034.*how-it-works/);
  fails(check(indexMd((b) => b.replace("See [How it works](start/how-it-works.md) for the whole journey.\n:::", ":::\n\nSee [How it works](start/how-it-works.md)."))), /DOCS-THEME-034.*how-it-works/);
  fails(check(indexMd((b) => b.replace("3. **[Cortex]", "- **[Cortex]").replace("4. **Voice**", "- **Voice**").replace("5. **The", "- **The").replace("6. **The", "- **The"))), /DOCS-THEME-034/);
  fails(check(indexMd((b) => b.replace("2. **[Salience]", "1. **[Salience]").replace("1. **Chat**", "1. **Chat**\n\nA paragraph.\n"))), /DOCS-THEME-034/);
  passes(check(indexMd((b) => b.replace("(start/how-it-works.md)", "(/start/how-it-works)"))));
  passes(check(indexMd((b) => b.replace("(start/how-it-works.md)", "(start/how-it-works)"))));
  passes(check(indexMd((b) => b.replace("**The [sink](start/glossary.md#sink) or Discord** plays", "**The [sink](start/glossary.md#sink)** plays").replace("**Chat** hears", "**CHAT** hears"))));
  passes(check(indexMd((b) => b.replace("**The [sink](start/glossary.md#sink) or Discord**", "**Discord, or the [sink](start/glossary.md#sink)**"))));
});

// @spec DOCS-THEME-036
test("the home page's three feature cards get a 4px top border in accent, badge-simple-text, badge-advanced-text", () => {
  fails(check(styleMut(".VPFeatures .item:nth-child(2) .VPFeature { border-top: 4px solid var(--cohost-badge-simple-text); }", ".VPFeatures .item:nth-child(2) .VPFeature { border-top: 4px solid var(--cohost-accent); }")), /DOCS-THEME-036.*2/);
  fails(check(styleMut(".VPFeatures .item:nth-child(3) .VPFeature { border-top: 4px solid var(--cohost-badge-advanced-text); }", ".VPFeatures .item:nth-child(3) .VPFeature { border-top: 2px solid var(--cohost-badge-advanced-text); }")), /DOCS-THEME-036.*3/);
  fails(check(styleMut(/\.VPFeatures \.item:nth-child\(1\)[^\n]*\n/, "")), /DOCS-THEME-036.*1/);
});

// @spec DOCS-THEME-037
test("the flow list is a column by default and a wrapping row only from min-width 640px", () => {
  fails(check(styleMut(".cohost-flow ol { display: flex; flex-direction: column; }", ".cohost-flow ol { display: flex; flex-direction: row; }")), /DOCS-THEME-037.*column/);
  fails(check(styleMut(".cohost-flow ol { display: flex; flex-direction: column; }", ".cohost-flow ol { flex-direction: column; }")), /DOCS-THEME-037.*flex/);
  fails(check(styleMut("@media (min-width: 640px) {\n  .cohost-flow ol { flex-direction: row; flex-wrap: wrap; }", "@media (min-width: 700px) {\n  .cohost-flow ol { flex-direction: row; flex-wrap: wrap; }")), /DOCS-THEME-037.*640px/);
  fails(check(styleMut("flex-direction: row; flex-wrap: wrap;", "flex-direction: row;")), /DOCS-THEME-037.*wrap/);
  fails(check(style((c) => c + ".cohost-flow ol { flex-direction: row; }\n")), /DOCS-THEME-037/);
});

// @spec DOCS-THEME-040
test("every animation, animation-name and transition declaration sits inside prefers-reduced-motion: no-preference", () => {
  const r = check(style((c) => c + ".x { transition: color 1s; }\n"));
  fails(r, /style\.css:\d+: \[DOCS-THEME-040\]/);
  fails(check(style((c) => c + ".x { animation: a 1s; }\n")), /DOCS-THEME-040/);
  fails(check(style((c) => c + "@media (prefers-reduced-motion: reduce) { .x { animation-name: a; } }\n")), /DOCS-THEME-040/);
  fails(check(style((c) => c + "@media print { .x { transition: none; } }\n")), /DOCS-THEME-040/);
  passes(check(style((c) => c + "@media (prefers-reduced-motion: no-preference) { @media (min-width: 1px) { .x { transition: color 1s; } } }\n")));
});

// @spec DOCS-THEME-041
test("a prefers-reduced-motion: reduce block cuts animation and transition and turns smooth scrolling off", () => {
  fails(check(styleMut(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n\n/, "")), /DOCS-THEME-041/);
  fails(check(styleMut("  scroll-behavior: auto !important;\n", "")), /DOCS-THEME-041.*scroll-behavior/);
  fails(check(styleMut("animation-duration: 0.01ms !important;", "animation-duration: 1ms !important;")), /DOCS-THEME-041.*animation-duration/);
  fails(check(styleMut("transition-duration: 0.01ms !important;", "transition-duration: 0.01ms;")), /DOCS-THEME-041.*transition-duration/);
  fails(check(styleMut("animation-iteration-count: 1 !important;", "animation-iteration-count: 2 !important;")), /DOCS-THEME-041.*animation-iteration-count/);
  fails(check(styleMut("*, *::before, *::after {\n    animation-duration", "*, *::before {\n    animation-duration")), /DOCS-THEME-041/);
  passes(check(styleMut("animation-duration: 0.01ms !important;", "animation-duration: 0s !important;")));
});

// @spec DOCS-THEME-042
test("an animation-name rule sets a single name and a bounded duration and iteration count", () => {
  fails(check(styleMut("animation-iteration-count: 3;", "animation-iteration-count: infinite;")), /DOCS-THEME-042.*infinite/);
  fails(check(styleMut("animation-iteration-count: 3;", "animation-iteration-count: 20;")), /DOCS-THEME-042.*5/);
  fails(check(styleMut("animation-name: cohost-talk;", "animation-name: cohost-talk, other;")), /DOCS-THEME-042.*single/);
  fails(check(styleMut(" animation-duration: 0.5s;", "")), /DOCS-THEME-042.*animation-duration/);
  fails(check(styleMut("animation-iteration-count: 3; }", "animation-iteration-count: 3; animation: cohost-talk 1s; }")), /DOCS-THEME-042.*animation/);
  passes(check(styleMut("animation-duration: 0.5s;", "animation-duration: 500ms;")));
  passes(check(styleMut("animation-iteration-count: 3;", "animation-iteration-count: 10;")));
});

// @spec DOCS-THEME-043
test("focus-visible on links, buttons, summary, form fields and [tabindex] is a 2px solid focus outline offset 2px", () => {
  fails(check(styleMut(" summary:focus-visible,", "")), /DOCS-THEME-043.*summary/);
  fails(check(styleMut(" [tabindex]:focus-visible", " [tabindex]:focus-within")), /DOCS-THEME-043.*tabindex/);
  fails(check(styleMut("outline: 2px solid var(--cohost-focus);", "outline: 1px solid var(--cohost-focus);")), /DOCS-THEME-043.*2px/);
  fails(check(styleMut("outline: 2px solid var(--cohost-focus);", "outline: 2px dashed var(--cohost-focus);")), /DOCS-THEME-043.*solid/);
  fails(check(styleMut("outline: 2px solid var(--cohost-focus);", "outline: 2px solid var(--cohost-accent);")), /DOCS-THEME-043.*focus/);
  fails(check(styleMut("outline-offset: 2px;", "outline-offset: 0;")), /DOCS-THEME-043.*offset/);
  passes(check(styleMut(/a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, \[tabindex\]:focus-visible \{\n  outline: 2px solid var\(--cohost-focus\);/, ":is(a, button, summary, input, select, textarea, [tabindex]):focus-visible {\n  outline-width: 2px; outline-style: solid; outline-color: var(--cohost-focus);")));
});

// @spec DOCS-THEME-044
test("the theme CSS removes no outline", () => {
  for (const d of ["outline: none", "outline: 0", "outline-style: none", "outline-width: 0", "outline: 0 !important"]) {
    fails(check(style((c) => c + `.x:focus { ${d}; }\n`)), /style\.css:\d+: \[DOCS-THEME-044\]/);
  }
  passes(check(style((c) => c + ".x { outline: 1px solid red; }\n")));
});

// @spec DOCS-THEME-045
test("outside min-width media no theme rule sets a width, min-width or flex-basis above 328px", () => {
  fails(check(style((c) => c + ".x { width: 400px; }\n")), /style\.css:\d+: \[DOCS-THEME-045\].*400px/);
  fails(check(style((c) => c + ".x { min-width: 20.6rem; }\n")), /DOCS-THEME-045.*20\.6rem/);
  fails(check(style((c) => c + ".x { flex-basis: 30em; }\n")), /DOCS-THEME-045/);
  fails(check(style((c) => c + "@media print { .x { width: 600px; } }\n")), /DOCS-THEME-045/);
  fails(check(style((c) => c + ".x svg { min-width: 640px; }\n")), /DOCS-THEME-045/);
  fails(check(style((c) => c + ".cohost-diagram svg { min-width: 640px; }\n")), /DOCS-THEME-045/);
  passes(check(style((c) => c + ".x { width: 328px; min-width: 20.5rem; max-width: 900px; flex-basis: 50%; }\n@media (min-width: 960px) { .x { width: 600px; } }\n")));
});

// @spec DOCS-THEME-046
test("the print block hides the nav, local nav, sidebar, outline and pager but not the track badge", () => {
  const all = [".VPNav", ".VPLocalNav", ".VPSidebar", ".VPDocAside", ".VPDoc .aside", ".VPDocFooter .prev-next"];
  for (const sel of all) {
    const line = (l: string[]) => `${l.join(", ")} { display: none !important; }`;
    fails(check(styleMut(line(all), line(all.filter((x) => x !== sel)))), new RegExp(`DOCS-THEME-046.*${sel.replace(/[.]/g, "\\.")}`));
  }
  fails(check(style((c) => c.replace("@media print {", "@media print {\n  .cohost-track-badge { display: none; }"))), /DOCS-THEME-046.*cohost-track-badge/);
  fails(check(styleMut("@media print {\n  .VPNav", "@media screen {\n  .VPNav")), /DOCS-THEME-046/);
});

// @spec DOCS-THEME-047
test("the print block gives .dark every token's light value", () => {
  const light = PALETTE.find((p) => p[0] === "info-bg")![1];
  fails(check(styleMut(`    --cohost-info-bg: ${light};\n`, "")), /DOCS-THEME-047.*info-bg/);
  fails(check(styleMut(`    --cohost-info-bg: ${light};`, "    --cohost-info-bg: #000000;")), /DOCS-THEME-047.*info-bg/);
  fails(check(style((c) => c.replace(/  \.dark \{\n(    --cohost[^\n]*\n)+  \}\n/, ""))), /DOCS-THEME-047/);
  passes(check(styleMut(`    --cohost-info-bg: ${light};`, `    --cohost-info-bg: ${light.toLowerCase()};`)));
});

// @spec DOCS-THEME-048
test("the print block wraps code with white-space: pre-wrap", () => {
  fails(check(styleMut("white-space: pre-wrap;", "white-space: pre;")), /DOCS-THEME-048/);
  fails(check(styleMut(".vp-doc div[class*='language-'] pre {", ".vp-doc pre {")), /DOCS-THEME-048/);
  passes(check(styleMut(".vp-doc div[class*='language-'] pre {", '.vp-doc div[class*="language-"] pre {')));
});

// @spec DOCS-THEME-050
test("the print block colours dark-mode code with Shiki's light colours and the light code-bg", () => {
  fails(check(styleMut("color: var(--shiki-light) !important;", "color: var(--shiki-dark) !important;")), /DOCS-THEME-050.*shiki-light/);
  fails(check(styleMut(/background-color: #F6F2F9 !important;/, "background-color: #211A29 !important;")), /DOCS-THEME-050.*F6F2F9/i);
  fails(check(styleMut(/  \.dark \.shiki, \.dark \.shiki span[^\n]*\n/, "")), /DOCS-THEME-050/);
});

// @spec DOCS-THEME-053
test("the print block keeps diagrams, asides and custom blocks whole", () => {
  fails(check(styleMut(".cohost-diagram, .cohost-aside, .custom-block { break-inside: avoid; }", ".cohost-aside, .custom-block { break-inside: avoid; }")), /DOCS-THEME-053.*cohost-diagram/);
  fails(check(styleMut(".cohost-diagram, .cohost-aside, .custom-block { break-inside: avoid; }", ".cohost-diagram, .cohost-aside { break-inside: avoid; }")), /DOCS-THEME-053.*custom-block/);
  fails(check(styleMut("break-inside: avoid;", "break-inside: auto;")), /DOCS-THEME-053/);
});

// @spec DOCS-THEME-054
test("the print block appends the URL after external links in page content", () => {
  fails(check(styleMut(/content: " \(" attr\(href\) "\)";/, 'content: attr(href);')), /DOCS-THEME-054/);
  fails(check(styleMut(", .vp-doc a[href^='//']::after", "")), /DOCS-THEME-054.*\/\//);
  fails(check(styleMut(".vp-doc a[href^='http']::after,", ".vp-doc a[href^='ftp']::after,")), /DOCS-THEME-054.*http/);
  passes(check(styleMut(/content: " \(" attr\(href\) "\)";/, "content: ' (' attr(href) ')';")));
});

// ---------------------------------------------------------------- Theme, built site

const site = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string> = { ...themeDist() };
  for (const [p, c] of Object.entries(BUILT)) base[p] = wrapPage(p, c);
  const all: Record<string, string | null> = { ...base, ...over };
  return distExact(Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== null)));
};
const sitePasses = (over: Record<string, string | null> = {}) => passes(check({}, ["--dist"], site(over)));
const siteFails = (over: Record<string, string | null>, re: RegExp, overrides: Record<string, string | null> = {}) => fails(check(overrides, ["--dist"], site(over)), re);

test("the built-site fixture passes the built-site pass", () => {
  sitePasses();
  sitePasses({ "guide/install/first-run.html": docPage("simple", "Try it") });
});

// @spec DOCS-THEME-010
test("a resource reference to an external URL in built HTML or CSS fails, naming the file and URL; links do not", () => {
  const ext = "https://cdn.example.com/x";
  const page = (body: string, head = "") => shell(body, { head: `<link rel="icon" type="image/svg+xml" href="/cohost/favicon.svg">${head}` });
  const bad = (name: string, html: string, url = ext) =>
    siteFails({ "extra/page.html": html }, new RegExp(`extra/page\\.html.*DOCS-THEME-010.*${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`), {});
  bad("script src", page("", `<script src="${ext}"></script>`));
  bad("img src", page(`<img src="${ext}">`));
  bad("srcset", page(`<img srcset="/a.png 1x, ${ext} 2x">`));
  bad("poster", page(`<video poster="${ext}"></video>`));
  bad("object data", page(`<object data="${ext}"></object>`));
  bad("link stylesheet", page("", `<link rel="stylesheet" href="${ext}">`));
  bad("link preload", page("", `<link rel="preload" as="font" href="${ext}">`));
  bad("protocol-relative", page(`<img src="//cdn.example.com/x">`), "//cdn.example.com/x");
  bad("svg image", page(`<svg><image href="${ext}"/></svg>`));
  bad("svg use xlink", page(`<svg><use xlink:href="${ext}#a"/></svg>`), ext);
  bad("style element url", page("", `<style>.a{background:url(${ext})}</style>`));
  bad("style element import", page("", `<style>@import url("${ext}");</style>`));
  bad("inline svg style import", page(`<svg><style>@import url('${ext}');</style></svg>`));
  bad("style attribute", page(`<p style="background: url('${ext}')"></p>`));
  siteFails({ "assets/app.css": `@import "${ext}"; a{}` }, /assets\/app\.css.*DOCS-THEME-010.*cdn\.example\.com/);
  siteFails({ "assets/app.css": `@font-face{src:url(${ext}) format("woff2")}` }, /assets\/app\.css.*DOCS-THEME-010/);
  sitePasses({
    "extra/page.html": page(
      `<a href="${ext}">link</a><img src="/cohost/a.png"><svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg><p style="background:url(data:image/png;base64,AAAA)"></p><a href="//x.example/">y</a><p data-src="${ext}"></p>`,
      `<link rel="canonical" href="${ext}"><link rel="alternate" href="${ext}"><link rel="me" href="${ext}"><style>.a{background:url("/cohost/b.png")}</style>`,
    ),
    "assets/app.css": "a{background:url(data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>)}",
  });
});

// @spec DOCS-THEME-015, DOCS-THEME-016
test("every built page shows the idle mark, decorative, before the site title in the nav bar", () => {
  const nav = (inner: string) => `<header class="VPNav"><div class="VPNavBar"><div class="VPNavBarTitle"><a class="title" href="/cohost/">${inner}</a></div></div></header>`;
  const withNav = (inner: string) => ({ "guide/troubleshooting.html": docPage("simple", "Troubleshooting").replace(NAV, nav(inner)) });
  siteFails(withNav("<span>cohost</span>"), /guide\/troubleshooting\.html.*DOCS-THEME-016/);
  siteFails(withNav(`<span>cohost</span>${NAV_MARK}`), /DOCS-THEME-016.*before/);
  siteFails(withNav(NAV_MARK.replace('data-expression="idle"', 'data-expression="talking"') + "<span>cohost</span>"), /DOCS-THEME-016.*idle/);
  siteFails(withNav(NAV_MARK.replace(' aria-hidden="true"', "") + "<span>cohost</span>"), /DOCS-THEME-015.*aria-hidden/);
  siteFails(withNav(NAV_MARK.replace('aria-hidden="true"', 'aria-hidden="true" role="img"') + "<span>cohost</span>"), /DOCS-THEME-015.*role/);
  siteFails(withNav(NAV_MARK.replace('aria-hidden="true"', 'aria-hidden="true" aria-label="The cohost mascot"') + "<span>cohost</span>"), /DOCS-THEME-015.*aria-label/);
  siteFails({ "guide/troubleshooting.html": shell("<p>x</p>", { nav: "" }) }, /DOCS-THEME-016/);
});

// @spec DOCS-THEME-056, DOCS-THEME-035
test("a mark shown alone is labelled as an image; the home hero shows the talking mark", () => {
  const body = (svg: string) => docPage("simple", "Troubleshooting", svg);
  const alone = `<svg class="cohost-mark" data-expression="idle" role="img" aria-label="The cohost mascot" viewBox="0 0 64 64"><rect/></svg>`;
  sitePasses({ "guide/troubleshooting.html": body(alone) });
  siteFails({ "guide/troubleshooting.html": body(alone.replace(' role="img"', "")) }, /guide\/troubleshooting\.html.*DOCS-THEME-056.*role/);
  siteFails({ "guide/troubleshooting.html": body(alone.replace('aria-label="The cohost mascot"', 'aria-label="mascot"')) }, /DOCS-THEME-056.*aria-label/);
  siteFails({ "guide/troubleshooting.html": body(alone.replace(' role="img"', ' aria-hidden="true"')) }, /DOCS-THEME-056/);
  siteFails({ "index.html": shell(HOME_BODY.replace('data-expression="talking"', 'data-expression="idle"')) }, /index\.html.*DOCS-THEME-035.*talking/);
  siteFails({ "index.html": shell(HOME_BODY.replace(/<svg class="cohost-mark"[\s\S]*?<\/svg>/, "")) }, /index\.html.*DOCS-THEME-035/);
  siteFails({ "index.html": shell(HOME_BODY.replace(' role="img"', "")) }, /index\.html.*DOCS-THEME-(035|056)/);
});

// @spec DOCS-THEME-051
test("every built page's head links the SVG favicon", () => {
  siteFails({ "extra/page.html": shell("<p>x</p>", { head: "" }) }, /extra\/page\.html.*DOCS-THEME-051/);
  siteFails({ "extra/page.html": shell("<p>x</p>", { head: '<link rel="icon" href="/cohost/favicon.svg">' }) }, /DOCS-THEME-051/);
  siteFails({ "extra/page.html": shell("<p>x</p>", { head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg">' }) }, /DOCS-THEME-051/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY, { head: "" }) }, /404\.html.*DOCS-THEME-051/);
  sitePasses({ "extra/page.html": shell("<p>x</p>", { head: '<link href="/cohost/favicon.svg" type="image/svg+xml" rel="icon" />' }) });
});

// @spec DOCS-THEME-018, DOCS-THEME-019
test("a track badge reads Track: then its label, hidden text first, and holds no link", () => {
  const pg = (b: string) => ({ "extra/page.html": shell(`<div class="vp-doc">${b}<h1>T</h1></div>`) });
  siteFails(pg(badge("simple").replace("Simple</span>", "Easy</span>")), /extra\/page\.html.*DOCS-THEME-018.*Simple/);
  siteFails(pg(badge("simple").replace("Track: ", "")), /DOCS-THEME-019.*Track:/);
  siteFails(pg(badge("simple").replace('<span class="visually-hidden">Track: </span>', "Track: ")), /DOCS-THEME-019/);
  siteFails(pg(badge("simple").replace('class="visually-hidden"', 'class="visually-hidden" aria-hidden="true"')), /DOCS-THEME-019/);
  siteFails(pg(badge("simple").replace("Simple</span>", '<a href="/cohost/">Simple</a></span>')), /DOCS-THEME-019.*link/);
  siteFails(pg(badge("simple").replace('<span class="visually-hidden">', '<button>x</button><span class="visually-hidden">')), /DOCS-THEME-019/);
  siteFails(pg(badge("simple").replace("<span class", '<span tabindex="0" class')), /DOCS-THEME-019/);
  siteFails(pg(badge("simple").replace('data-track="simple"', 'data-track="simple" tabindex="0"')), /DOCS-THEME-019/);
  for (const [t, label] of [["start", "Start here"], ["simple", "Simple"], ["advanced", "Advanced"], ["project", "Project"]]) {
    sitePasses(pg(`<span class="cohost-track-badge" data-track="${t}"><span class="visually-hidden">Track: </span>${label}</span>`));
  }
});

// @spec DOCS-THEME-020
test("each built hand-written page with a track carries exactly one badge of that track; excerpts carry advanced", () => {
  const f = "guide/install/first-run.html";
  sitePasses({ [f]: docPage("simple", "Try it") });
  siteFails({ [f]: docPage("advanced", "Try it") }, /guide\/install\/first-run\.html.*DOCS-THEME-020.*simple/);
  siteFails({ [f]: shell('<div class="vp-doc"><h1>Try it</h1></div>') }, /first-run\.html.*DOCS-THEME-020/);
  siteFails({ [f]: shell(`<div class="vp-doc">${badge("simple")}${badge("simple")}<h1>Try it</h1></div>`) }, /first-run\.html.*DOCS-THEME-020.*exactly one/);
  siteFails({ "start/what-is-cohost.html": docPage("project", "What") }, /what-is-cohost\.html.*DOCS-THEME-020.*start/);
  // the home page is exempt; an excerpt page needs the advanced badge
  sitePasses({ "index.html": shell(HOME_BODY) });
  siteFails({ "advanced/architecture/design/problem.html": shell('<div class="vp-doc"><h1>P</h1></div>') }, /design\/problem\.html.*DOCS-THEME-020.*advanced/);
  siteFails({ "advanced/architecture/design/problem.html": docPage("simple", "P") }, /design\/problem\.html.*DOCS-THEME-020/);
  sitePasses({ "advanced/architecture/design/problem.html": docPage("advanced", "P") });
});

// @spec DOCS-THEME-025, DOCS-THEME-030, DOCS-THEME-026, DOCS-THEME-029
test("a mermaid fence is rendered to a labelled inline SVG in a focusable figure; none is left as code; no @import survives", () => {
  const src = (heading: string) => ({ "docs/guide/install/first-run.md": mut(base("docs/guide/install/first-run.md"), "## What you need\n", `${heading}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n## What you need\n`) });
  const f = "guide/install/first-run.html";
  const pageWith = (fig: string) => ({ [f]: docPage("simple", "Try it", fig) });
  const run = (heading: string, over: Record<string, string | null>) => check(src(heading), ["--dist"], site(over));
  fails(run("## The flow", pageWith("")), /first-run\.html.*DOCS-THEME-025/);
  fails(run("## The flow", pageWith(FIGURE("The flow").replace(' tabindex="0"', ""))), /DOCS-THEME-025.*tabindex/);
  fails(run("## The flow", pageWith(FIGURE("The flow").replace("<svg", "<p"))), /DOCS-THEME-025/);
  fails(run("## The flow", pageWith(FIGURE("The flow") + FIGURE("The flow"))), /DOCS-THEME-025.*1/);
  passes(run("## The flow", pageWith(FIGURE("The flow"))));
  // 030: the label is the nearest heading's plain text, or the title when none precedes the fence
  fails(run("## The flow", pageWith(FIGURE("Wrong"))), /first-run\.html.*DOCS-THEME-030.*The flow/);
  fails(run("## The flow", pageWith(FIGURE("The flow").replace(' role="img"', ""))), /DOCS-THEME-030.*role/);
  passes(run("## The `bus` and *the* [glossary](start/glossary.md) {#bus-id}", pageWith(FIGURE("The bus and the glossary"))));
  passes(run("### Deeper &amp; wider", pageWith(FIGURE("Deeper & wider").replace("&", "&amp;"))));
  passes(check({}, ["--dist"], site(pageWith(""))));
  const noHeading = page({ title: "Try it", description: "About Try it.", track: "simple" }, "```mermaid\nflowchart LR\n  A --> B\n```\n\n# Try it\n\n## What you need\n\nA PC.\n\n1. Do it.\n\n## How you know it worked\n\nYou see it.\n\n## If it didn't\n\nSee [troubleshooting](../troubleshooting.md).");
  passes(check({ "docs/guide/install/first-run.md": noHeading }, ["--dist"], site(pageWith(FIGURE("Try it")))));
  fails(check({ "docs/guide/install/first-run.md": noHeading }, ["--dist"], site(pageWith(FIGURE("Other")))), /DOCS-THEME-030.*Try it/);
  // 026: a language-mermaid block left in the page
  fails(run("## The flow", pageWith(FIGURE("The flow") + '<div class="language-mermaid vp-adaptive-theme"><pre>x</pre></div>')), /first-run\.html.*DOCS-THEME-026/);
  fails(check({}, ["--dist"], site({ [f]: docPage("simple", "Try it", '<div class="language-mermaid"><pre>x</pre></div>') })), /DOCS-THEME-026/);
  // 029: no @import in a diagram's style
  fails(run("## The flow", pageWith(FIGURE("The flow").replace(".x{fill:red}", '@import url("fonts.css");.x{fill:red}'))), /first-run\.html.*DOCS-THEME-029/);
  fails(run("## The flow", pageWith(FIGURE("The flow").replace(".x{fill:red}", "@import 'fonts.css';"))), /DOCS-THEME-029/);
});

// @spec DOCS-THEME-025, DOCS-THEME-030
test("a mermaid fence in a design excerpt is rendered and labelled from the excerpt's heading", () => {
  const hld = HLDWithDiagram();
  const over = { "docs/high-level-design.md": hld, "docs/advanced/architecture/design/[section].md": "<!-- @content -->\n" };
  const d = (fig: string) => ({ "advanced/architecture/design/system-design.html": docPage("advanced", "System design", fig) });
  const run = (extra: Record<string, string | null>) => check({ ...designTree(), ...over, "docs/high-level-design.md": hld.replace("| brain | beta | Beta does another |\n", "| brain | beta | Beta does another |\n| operator | docs-site | The docs |\n") }, ["--dist"], site(extra));
  fails(run(d("")), /system-design\.html.*DOCS-THEME-025/);
  fails(run(d(FIGURE("Wrong"))), /system-design\.html.*DOCS-THEME-030.*System Design/);
  passes(run(d(FIGURE("System Design"))));
});

// @spec DOCS-THEME-052
test("a built asset named mermaid*.js fails the built-site pass", () => {
  siteFails({ "assets/chunks/mermaid.core.abc123.js": "x" }, /assets\/chunks\/mermaid\.core\.abc123\.js.*DOCS-THEME-052/);
  siteFails({ "assets/mermaid-xyz.js": "x" }, /DOCS-THEME-052/);
  sitePasses({ "assets/app.js": "x", "assets/chunks/framework.js": "x", "assets/not-mermaid.js": "x" });
});

// @spec DOCS-THEME-033
test("the built home page renders the flow container with an ordered list of six steps", () => {
  siteFails({ "index.html": shell(HOME_BODY.replace('class="cohost-flow"', 'class="flow"')) }, /index\.html.*DOCS-THEME-033/);
  siteFails({ "index.html": shell(HOME_BODY.replace("<ol>", "<ul>").replace("</ol>", "</ul>")) }, /DOCS-THEME-033.*ol/);
  siteFails({ "index.html": shell(HOME_BODY.replace("<li>Avatar</li>", "")) }, /DOCS-THEME-033.*six/);
  siteFails({ "index.html": shell(HOME_BODY.replace('<div class="cohost-flow">', '<div class="cohost-flow"><p>::: flow</p>').replace("<ol>", "<p>1. Chat</p><ol>")) }, /DOCS-THEME-033/);
});

// @spec DOCS-THEME-038, DOCS-THEME-039
test("404.html has its heading, links, the lost mark outside the nav bar and the co-host's aside", () => {
  siteFails({ "404.html": null }, /404\.html.*DOCS-THEME-039/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace("Page not found", "Gone")) }, /404\.html.*DOCS-THEME-039.*Page not found/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace("<h1>", "<h2>").replace("</h1>", "</h2>")) }, /DOCS-THEME-039.*Page not found/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace('<a href="/cohost/">Go', '<a href="/cohost/index">Go')) }, /DOCS-THEME-039.*\/cohost\//);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace('<a href="/cohost/start/what-is-cohost">', '<a href="/cohost/start/what-is-cohost.html">')) }, /DOCS-THEME-039.*what-is-cohost/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace('class="cohost-aside"', 'class="aside"')) }, /DOCS-THEME-039.*cohost-aside/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace('data-expression="lost"', 'data-expression="idle"')) }, /DOCS-THEME-039.*lost/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace(' role="img"', "")) }, /DOCS-THEME-039.*role/);
  // the nav bar's links and mark do not stand in for the page's own
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace(/<svg class="cohost-mark"[\s\S]*?<\/svg>/, "")) }, /DOCS-THEME-039.*lost/);
  siteFails({ "404.html": shell(NOT_FOUND_BODY.replace('<a href="/cohost/">Go to the home page</a> ', "")) }, /DOCS-THEME-039.*\/cohost\//);
});

const HLDWithDiagram = () => HLD().replace("## System Design\n", "## System Design\n\n```mermaid\nflowchart LR\n  A --> B\n```\n");

// ---------------------------------------------------------------- Served by the dashboard (DOCS-LIVE-*)

const LIVE_VUE = `${T}components/LiveHealth.vue`;
const LIVE_MJS = `${T}live-health.mjs`;
const HEALTH_MD = "docs/guide/operate/health.md";
const healthMd = (body: string) => ({ [HEALTH_MD]: page({ title: "Service health", description: "About Service health.", track: "simple", verified: "f126b94" }, `# Service health\n\n${body}`) });

// @spec DOCS-LIVE-001
test("the theme entry registers LiveHealth globally in enhanceApp from ./components/LiveHealth.vue", () => {
  const idx = (t: string) => ({ [`${T}index.ts`]: t });
  fails(check(idx(mut(THEME_INDEX_TS, /  enhanceApp[\s\S]*?\n  \},\n/, ""))), /index\.ts.*DOCS-LIVE-001.*enhanceApp/);
  fails(check(idx(mut(THEME_INDEX_TS, "app.component('LiveHealth'", "app.component('Livehealth'"))), /DOCS-LIVE-001.*LiveHealth/);
  fails(check(idx(mut(THEME_INDEX_TS, "./components/LiveHealth.vue", "./components/Other.vue"))), /DOCS-LIVE-001.*\.\/components\/LiveHealth\.vue/);
  fails(check(idx(mut(THEME_INDEX_TS, "enhanceApp({ app }) {\n    app.component('LiveHealth', LiveHealth);\n  },", "enhanceApp({ app }) {},\n  setup() { app.component('LiveHealth', LiveHealth); },"))), /DOCS-LIVE-001/);
  fails(check({ [LIVE_VUE]: null }), /LiveHealth\.vue.*DOCS-LIVE-001.*does not exist/);
  passes(check(idx(mut(THEME_INDEX_TS, /app\.component\('LiveHealth', LiveHealth\);/, 'app.component("LiveHealth", LiveHealth);'))));
});

// @spec DOCS-LIVE-002
test("the Service health page holds exactly one LiveHealth element outside fenced code, in any spelling", () => {
  fails(check(healthMd("No component.")), /health\.md.*DOCS-LIVE-002.*0/);
  fails(check(healthMd("<LiveHealth />\n\n<LiveHealth/>")), /DOCS-LIVE-002.*2/);
  fails(check(healthMd("<LiveHealth />\n\n<LiveHealth></LiveHealth>")), /DOCS-LIVE-002.*2/);
  fails(check(healthMd("```html\n<LiveHealth />\n```")), /DOCS-LIVE-002.*0/);
  fails(check({ [HEALTH_MD]: null }), /health\.md.*DOCS-LIVE-002/);
  passes(check(healthMd("<LiveHealth/>")));
  passes(check(healthMd("<LiveHealth></LiveHealth>")));
  passes(check(healthMd("```html\n<LiveHealth />\n```\n\n<LiveHealth />")));
});

// @spec DOCS-LIVE-003
test("the built Service health page holds exactly one cohost-live-health element with the note inside it", () => {
  const dist = (body: string) => ({ "guide/operate/health.html": shell(`<div class="vp-doc">${badge("simple")}<h1>Service health</h1>${body}</div>`) });
  const anchor = '<h2 id="the-states">The states</h2>';
  sitePasses();
  siteFails({ "guide/operate/health.html": null }, /health\.html.*DOCS-LIVE-003/);
  siteFails(dist(anchor), /health\.html.*DOCS-LIVE-003.*0/);
  siteFails(dist(HEALTH_BODY + HEALTH_BODY.replace('id="the-states"', "")), /DOCS-LIVE-003.*2/);
  siteFails(dist(`${anchor}<div class="cohost-live-health"><p>Something else.</p></div>`), /DOCS-LIVE-003.*note/);
  siteFails(dist(`${anchor}<p>${LIVE_NOTE}</p><div class="cohost-live-health"><p></p></div>`), /DOCS-LIVE-003.*note/);
  siteFails(dist(`${anchor}<div class="cohost-live-health"><p>${LIVE_NOTE}</p><table><caption>x</caption></table></div>`), /DOCS-LIVE-003.*table/);
  sitePasses(dist(`${anchor}<div class="cohost-live-health extra"><p>${LIVE_NOTE}</p></div>`));
  sitePasses(dist(`${anchor}<div class="cohost-live-health"><div><p>Live data shows here when you open these docs from your <!-- -->dashboard.</p></div></div>`));
});

// @spec DOCS-LIVE-011
test("LiveHealth.vue has no style block and the theme CSS gives .cohost-live-health no animation or transition", () => {
  fails(check({ [LIVE_VUE]: LIVE_HEALTH_VUE + "<style>.x { color: red; }</style>\n" }), /LiveHealth\.vue.*DOCS-LIVE-011.*style/);
  fails(check({ [LIVE_VUE]: LIVE_HEALTH_VUE + '<style scoped lang="css">.x {}</style>\n' }), /DOCS-LIVE-011/);
  const css = (rule: string) => ({ [`${T}style.css`]: STYLE_CSS + `\n${rule}\n` });
  fails(check(css(".cohost-live-health td { transition: color 1s; }")), /style\.css.*DOCS-LIVE-011.*transition/);
  fails(check(css(".cohost-live-health { animation-name: x; }")), /DOCS-LIVE-011.*animation-name/);
  fails(check(css(".vp-doc .cohost-live-health table tr:hover { animation: x 1s; }")), /DOCS-LIVE-011.*animation/);
  fails(check(css("@media (prefers-reduced-motion: no-preference) { .cohost-live-health td { transition-duration: 1s; } }")), /DOCS-LIVE-011/);
  passes(check(css(".cohost-live-health-status { color: var(--cohost-text-2); }")));
  passes(check(css("@media (prefers-reduced-motion: no-preference) { .cohost-other { transition: color 1s; } }")));
});

// @spec DOCS-LIVE-012
test("the built Service health page has the the-states anchor", () => {
  siteFails({ "guide/operate/health.html": docPage("simple", "Service health", HEALTH_BODY.replace('id="the-states"', 'id="states"')) }, /health\.html.*DOCS-LIVE-012.*the-states/);
  siteFails({ "guide/operate/health.html": null }, /DOCS-LIVE-012/);
  sitePasses({ "guide/operate/health.html": docPage("simple", "Service health", HEALTH_BODY.replace('<h2 id="the-states">', '<h3 id="the-states">').replace("</h2>", "</h3>")) });
});

// @spec DOCS-LIVE-013
test("the component's files hold no absolute URL literal, no WebSocket or EventSource, and name /services", () => {
  const mjs = (t: string) => ({ [LIVE_MJS]: LIVE_HEALTH_MJS + t });
  const vue = (t: string) => ({ [LIVE_VUE]: LIVE_HEALTH_VUE.replace("<script setup>", `<script setup>\n${t}`) });
  fails(check(mjs("const a = 'https://example.com/x';\n")), /live-health\.mjs.*DOCS-LIVE-013.*https:/);
  fails(check(mjs('const a = "HTTP://example.com";\n')), /DOCS-LIVE-013.*http:/i);
  fails(check(mjs("const a = `//cdn.example.com/x`;\n")), /DOCS-LIVE-013.*\/\//);
  fails(check(mjs("const a = '//cdn.example.com/x';\n")), /DOCS-LIVE-013/);
  fails(check(vue("const a = 'https://example.com/x';")), /LiveHealth\.vue.*DOCS-LIVE-013/);
  fails(check({ [LIVE_VUE]: LIVE_HEALTH_VUE.replace('class="cohost-live-health"', 'class="cohost-live-health" data-src="https://example.com"') }), /LiveHealth\.vue.*DOCS-LIVE-013/);
  fails(check({ [LIVE_VUE]: LIVE_HEALTH_VUE.replace('<p class', '<img src="//x.example/a.png" /><p class') }), /DOCS-LIVE-013/);
  fails(check(mjs("const s = new WebSocket('/ws');\n")), /live-health\.mjs.*DOCS-LIVE-013.*WebSocket/);
  fails(check(vue("const s = new EventSource('/e');")), /LiveHealth\.vue.*DOCS-LIVE-013.*EventSource/);
  fails(check({ [LIVE_MJS]: LIVE_HEALTH_MJS.replace("'/services'", "'/service'") }), /DOCS-LIVE-013.*\/services/);
  fails(check({ [LIVE_MJS]: null }), /live-health\.mjs.*DOCS-LIVE-013.*does not exist/);
  // comments and relative or non-URL strings are fine; so is a /services literal in either file
  passes(check(mjs("// see https://example.com and //x\n/* http://y */\nconst ok = 'a//b' + '/services/x' + 'httpx';\n")));
  passes(check({ [LIVE_MJS]: LIVE_HEALTH_MJS.replace("'/services'", "'/svc'"), ...vue("const u = '/services';") }));
});

// ---------------------------------------------------------------- the real repository

test("the check script has no dependencies beyond the workspace's and the fixture suite is clean", () => {
  assert.equal(existsSync(script), true);
  passes(check());
});

// ---------------------------------------------------------------- Extension guides (DOCS-GUIDE-*, DOCS-EX-002, DOCS-EX-005)

const TS = `${EXT}typescript-service.md`;
const IDX = `${EXT}index.md`;
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
const ext = (over: Record<string, string | null> = {}, tables = {}) => check(extendRepo(over, tables));
const lacks = (r: { err: string }, re: RegExp) => assert.doesNotMatch(r.err, re);
const IMPORT_NP = "<<< @/../examples/service/now-playing.ts#main\n";
/** The TypeScript service guide with `body` in its steps. */
const withBody = (body: string) => ({ [TS]: guide("Add a TypeScript service", body) });
const OTHER = { title: "T", description: "d", track: "simple", verified: "1a2b3c4" };

test("the Extend fixture is a clean repository", () => {
  passes(ext());
});

// @spec DOCS-GUIDE-001
test("a snippet import must name an existing file under the repository through @/", () => {
  const page1 = guide("Add a TypeScript service", "<<< @/../examples/service/missing.ts\n");
  const line = lineOf(page1, "<<<");
  fails(ext({ [TS]: page1 }), new RegExp(`typescript-service\\.md:${line}.*DOCS-GUIDE-001.*examples/service/missing\\.ts`));
  fails(ext(withBody("<<< ../examples/service/now-playing.ts\n")), /DOCS-GUIDE-001.*\.\.\/examples/);
  fails(ext(withBody("<<< examples/service/now-playing.ts\n")), /DOCS-GUIDE-001/);
  fails(ext(withBody("<<< @/../../outside.ts\n")), /DOCS-GUIDE-001.*outside\.ts/);
  fails(ext(withBody("<<< @/../examples/service\n")), /DOCS-GUIDE-001.*examples\/service/);
  fails(ext({ "docs/guide/troubleshooting.md": page(OTHER, "# T\n\n<<< @/nope.ts\n") }), /troubleshooting\.md.*DOCS-GUIDE-001/);
  // the path ends at `#`, `{` or whitespace; up to three leading spaces still make an import
  passes(ext(withBody("   <<< @/../examples/service/now-playing.ts{1,2 ts} [title]\n\n<<< @/../examples/service/now-playing.ts#main {1}\n")));
  // inside a fenced block (backtick or tilde), or indented four spaces, it is no import
  lacks(ext(withBody("```text\n<<< @/../examples/missing.ts\n```\n\n~~~text\n<<< @/../examples/missing.ts\n~~~\n")), /DOCS-GUIDE-001/);
  lacks(ext(withBody("    <<< @/../examples/service/missing.ts\n")), /DOCS-GUIDE-001/);
});

// @spec DOCS-GUIDE-002
test("a named region must open once and close once after it", () => {
  const file = (text: string) => ({ "examples/service/now-playing.ts": text });
  const imp = withBody("<<< @/../examples/service/now-playing.ts#main\n");
  const line = lineOf(imp[TS], "<<<");
  fails(ext({ ...imp, ...file("export const x = 1;\n") }), new RegExp(`typescript-service\\.md:${line}.*DOCS-GUIDE-002.*main`));
  fails(ext({ ...imp, ...file("// #region main\nx\n") }), /DOCS-GUIDE-002.*main/);
  fails(ext({ ...imp, ...file("// #endregion main\n// #region main\nx\n") }), /DOCS-GUIDE-002/);
  fails(ext({ ...imp, ...file("// #region main\n// #region main\n// #endregion main\n") }), /DOCS-GUIDE-002/);
  fails(ext({ ...imp, ...file("// #region main\n// #endregion main\n// #endregion main\n") }), /DOCS-GUIDE-002/);
  fails(ext({ ...imp, ...file("// #region main2\n// #endregion main2\n") }), /DOCS-GUIDE-002/);
  passes(ext({ ...imp, ...file("  // #region main\nx\n  // #endregion main\n") }));
  passes(ext({ ...imp, ...file("//#region main\n// endregion main\n") }));
  passes(ext({ ...imp, ...file("/* #region main */\n/* #endregion main */\n") }));
  passes(ext({ ...imp, ...file("<!-- #region main -->\n<!-- #endregion main -->\n") }));
  passes(ext({ ...imp, ...file("#pragma region main\n#pragma endregion main\n") }));
  // VitePress's own patterns: the Visual Basic and Bat forms only close, so these regions never open
  fails(ext({ ...imp, ...file("#Region main\n#End Region main\n") }), /DOCS-GUIDE-002/);
  fails(ext({ ...imp, ...file("::#region main\n::#endregion main\n") }), /DOCS-GUIDE-002/);
  passes(ext({ ...imp, ...file("# region main\n# endregion main\n") }));
  passes(ext({ ...imp, ...file("#region main\n#endregion main\n") }));
  // other regions of the file do not matter
  passes(ext({ ...imp, ...file("// #region other\n// #endregion other\n// #region main\n// #endregion main\n") }));
  // an import without a region needs no markers
  lacks(ext({ ...withBody("<<< @/../examples/service/now-playing.ts\n"), ...file("export {};\n") }), /typescript-service\.md.*DOCS-GUIDE-002/);
});

// @spec DOCS-GUIDE-003
test("a snippet import counts as a fenced block for verified, glossary and wording, not as prose", () => {
  const files = { "examples/service/legacy-redis.ts": "export {};\n" };
  const body = `${IMPORT_NP}\n<<< @/../examples/service/legacy-redis.ts\n`;
  const noVerified = guide("Add a TypeScript service", body).replace(/verified: .*\n/, "");
  fails(ext({ ...files, [TS]: noVerified }), /typescript-service\.md.*DOCS-PAGE-002/);
  passes(ext({ ...files, [TS]: guide("Add a TypeScript service", body, { "glossary-skip": "[]" }) }));
  // the page's other prose is still read
  fails(ext({ ...files, [TS]: guide("Add a TypeScript service", `${body}\nIt is legacy.\n`, { "glossary-skip": "[]" }) }), /DOCS-PAGE-004.*legacy/);
  // a page whose only fence-like content is an import needs verified
  fails(ext({ [IDX]: INDEX.replace(/verified: .*\n/, "") }), /index\.md.*DOCS-PAGE-002/);
});

// @spec DOCS-GUIDE-004
test("fenced blocks on an Extend page are shell, yaml, env or text", () => {
  const line = (l: string) => withBody(`\`\`\`${l}\nx\n\`\`\`\n`);
  fails(ext(line("ts")), /typescript-service\.md:\d+.*DOCS-GUIDE-004.*ts/);
  fails(ext(line("")), /DOCS-GUIDE-004.*no language/);
  fails(ext(line("python")), /DOCS-GUIDE-004.*python/);
  fails(ext(line("json")), /DOCS-GUIDE-004.*json/);
  fails(ext(withBody("~~~rust\nx\n~~~\n")), /DOCS-GUIDE-004.*rust/);
  fails(ext(line("Python{1}")), /DOCS-GUIDE-004.*python/);
  for (const ok of ["sh", "bash", "shell", "zsh", "console", "text", "txt", "SH", "sh:line-numbers", "sh{1}", "text [file]", "bash title=x"]) {
    lacks(ext(withBody(`\`\`\`${ok}\n# a note\n\`\`\`\n`)), /DOCS-GUIDE-004/);
  }
  lacks(ext(withBody("```yaml\nllm:\n  provider: mock\n```\n\n```env\nLLM_PROVIDER=mock\n```\n")), /DOCS-GUIDE-004/);
  // other pages are not held to it
  lacks(ext({ "docs/guide/troubleshooting.md": page(OTHER, "# T\n\n```ts\nx\n```\n") }), /DOCS-GUIDE-004/);
});

// @spec DOCS-GUIDE-005
test("a command line of a shell fence runs only mise, pnpm, node, python3, cargo, sh, cd or export", () => {
  const sh = (cmds: string, lang = "sh") => withBody(`\`\`\`${lang}\n${cmds}\n\`\`\`\n`);
  fails(ext(sh("curl http://localhost")), /typescript-service\.md:\d+.*DOCS-GUIDE-005.*curl/);
  fails(ext(sh("FOO=1 BAR='a b' sox in.wav out.wav")), /DOCS-GUIDE-005.*sox/);
  fails(ext(sh("pnpm build && ffmpeg -i a b")), /DOCS-GUIDE-005.*ffmpeg/);
  fails(ext(sh("node a.ts | grep x")), /DOCS-GUIDE-005.*grep/);
  fails(ext(sh("cd x; ls")), /DOCS-GUIDE-005.*ls/);
  fails(ext(sh("node a.ts || echo no")), /DOCS-GUIDE-005.*echo/);
  fails(ext(sh("./examples/modules/try.sh")), /DOCS-GUIDE-005.*try\.sh/);
  fails(ext(sh("pnpm build \\\n  && curl x")), /DOCS-GUIDE-005.*curl/);
  fails(ext(sh("$ curl x\noutput", "console")), /DOCS-GUIDE-005.*curl/);
  fails(ext(sh("docker compose up", "bash")), /DOCS-GUIDE-005.*docker/);
  fails(ext(sh("export LLM_PROVIDER=mock && curl x")), /DOCS-GUIDE-005.*curl/);
  const ok = sh("pnpm install\nLLM_PROVIDER=mock node server.ts\nDASHBOARD_PORT=1 LLM_PROVIDER=mock python3 s.py\ncargo build\nsh try.sh\ncd examples\nexport LLM_PROVIDER=mock\n# curl in a comment\n\nLLM_PROVIDER=mock");
  lacks(ext(ok), /DOCS-GUIDE-005/);
  lacks(ext(sh("echo_not_run=1 node a.ts \"curl && sox\" 'a | b'\nnode a.ts \\\n  --flag curl\n")), /DOCS-GUIDE-005/);
  lacks(ext(sh("$ node a.ts\nprints curl and sox here\n$ pnpm build", "console")), /DOCS-GUIDE-005/);
  lacks(ext(sh("curl is fine in text\n", "text")), /DOCS-GUIDE-005/);
  lacks(ext({ "docs/guide/troubleshooting.md": page(OTHER, "# T\n\n```sh\ncurl x\n```\n") }), /DOCS-GUIDE-005/);
  lacks(ext(sh("mise run example:rust-bus\nmise watch --restart dev:chat")), /DOCS-GUIDE-005/);
});

// @spec DOCS-GUIDE-005
test("pnpm, node, python3, cargo or sh naming a path inside the repository fails on an Extend page; a dependency edit does not", () => {
  const sh = (cmds: string) => withBody(`\`\`\`sh\n${cmds}\n\`\`\`\n`);
  fails(ext(sh("cargo run --manifest-path examples/Cargo.toml -p cohost-example-bus")), /typescript-service\.md:\d+.*DOCS-GUIDE-005.*"cargo".*examples\/Cargo\.toml/);
  fails(ext(sh("node examples/service/now-playing.ts")), /typescript-service\.md:\d+.*DOCS-GUIDE-005.*"node".*examples\/service\/now-playing\.ts/);
  fails(ext(sh("node ./examples/service/now-playing.ts")), /DOCS-GUIDE-005.*"node"/);
  fails(ext(sh("python3 scripts/x.py")), /DOCS-GUIDE-005.*"python3".*scripts\/x\.py/);
  fails(ext(sh("sh examples/service/")), /DOCS-GUIDE-005.*"sh".*examples\/service/);
  fails(ext(sh("pnpm exec tsc -p examples/tsconfig.json")), /DOCS-GUIDE-005.*"pnpm".*examples\/tsconfig\.json/);
  fails(ext(sh("node --import tsx packages/bus/x.ts")), /DOCS-GUIDE-005.*packages\/bus\/x\.ts/);
  fails(ext(sh("cargo build --manifest-path=crates/cohost-bus/Cargo.toml")), /DOCS-GUIDE-005.*crates\/cohost-bus\/Cargo\.toml/);
  fails(ext(sh("LLM_PROVIDER=mock node services/cortex/dist/index.js")), /DOCS-GUIDE-005.*services\/cortex/);
  // code the reader keeps outside the checkout, and dependency edits, pass
  lacks(ext(sh("cargo run\nnode server.ts\npython3 stub.py\nsh try.sh\npnpm install\nnode my-examples/x.ts")), /DOCS-GUIDE-005/);
  lacks(ext(sh("pnpm add x\npnpm --filter ./packages/bus add x\ncargo add serde\ncargo add --manifest-path crates/cohost-bus/Cargo.toml serde\ncargo remove serde\npnpm remove x")), /DOCS-GUIDE-005/);
  lacks(ext(sh("mise run example:rust-bus\ncd examples")), /DOCS-GUIDE-005/);
});

// @spec DOCS-GUIDE-006
test("a path under examples/ in a shell command must exist", () => {
  const sh = (cmds: string) => withBody(`\`\`\`sh\n${cmds}\n\`\`\`\n`);
  fails(ext(sh("node examples/service/nope.ts")), /typescript-service\.md.*DOCS-GUIDE-006.*examples\/service\/nope\.ts/);
  fails(ext(sh("node ./examples/service/nope.ts")), /DOCS-GUIDE-006.*nope/);
  fails(ext(sh("cargo run --manifest-path=examples/nope/Cargo.toml")), /DOCS-GUIDE-006.*examples\/nope\/Cargo\.toml/);
  fails(ext(sh("sh examples/missing/")), /DOCS-GUIDE-006.*examples\/missing/);
  lacks(ext(sh("node examples/service/now-playing.ts\nnode ./examples/service/\nnode examples/service/\ncargo run --manifest-path examples/Cargo.toml -p cohost-example-bus\ncargo build --manifest-path=examples/Cargo.toml")), /DOCS-GUIDE-006/);
  // only words starting with examples/ are checked
  lacks(ext(sh("node notexamples/x.ts\nnode --out=other/examples/x\nnode 'quoted examples/x'")), /DOCS-GUIDE-006/);
});

// @spec DOCS-GUIDE-007
test("cargo -p must name a workspace Rust package", () => {
  const sh = (cmds: string) => withBody(`\`\`\`sh\n${cmds}\n\`\`\`\n`);
  fails(ext(sh("cargo run -p nope")), /typescript-service\.md.*DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo run -pnope")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo run -p=nope")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo run --package nope")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo run --package=nope")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo build -p cohost-bus -p nope")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("A=1 cargo run -p nope && node x")), /DOCS-GUIDE-007.*nope/);
  fails(ext(sh("cargo test -p cohost-example-hook-server -p cohost-bus -p cohost-example-gone")), /DOCS-GUIDE-007.*cohost-example-gone/);
  lacks(ext(sh("cargo run -p cohost-bus\ncargo run -pcohost-example-bus\ncargo run --package=cohost-example-hook-server\ncargo run --package cohost-example-bus")), /DOCS-GUIDE-007/);
  // not cargo: the flag belongs to another program
  lacks(ext(sh("node a.ts -p nope")), /DOCS-GUIDE-007/);
  // a directory of a workspace glob counts when it holds a package.name
  fails(ext({ ...sh("cargo run -p ghost"), "crates/ghost/README.md": "x" }), /DOCS-GUIDE-007.*ghost/);
  lacks(ext({ ...sh("cargo run -p other"), "crates/other/Cargo.toml": '[package]\nname = "other"\n' }), /DOCS-GUIDE-007/);
});

// @spec DOCS-GUIDE-008
test("a repository path in a code span of an Extend page must exist", () => {
  const p = (t: string) => withBody(`See ${t}.\n`);
  fails(ext(p("`packages/nope/src/x.ts`")), /typescript-service\.md:\d+.*DOCS-GUIDE-008.*packages\/nope\/src\/x\.ts/);
  fails(ext(p("`services/nope/`")), /DOCS-GUIDE-008.*services\/nope\//);
  fails(ext(p("`crates/nope`")), /DOCS-GUIDE-008/);
  fails(ext(p("`examples/nope.ts:12`")), /DOCS-GUIDE-008/);
  fails(ext(p("`scripts/nope.mjs#top`")), /DOCS-GUIDE-008/);
  fails(ext(p("`config/nope.yaml`")), /DOCS-GUIDE-008.*config\/nope\.yaml/);
  fails(ext({ [TS]: guide("Add a TypeScript service", "").replace("## What you need", "## What `packages/nope` needs") }), /DOCS-GUIDE-008/);
  lacks(ext(p("`examples/service/now-playing.ts` `examples/service/now-playing.ts:3` `examples/service/now-playing.ts#main` `examples/service/` `crates/cohost-bus` `packages/bus/fixtures/contract/constants.json`")), /DOCS-GUIDE-008/);
  // a placeholder, a wildcard, braces or a space make it no path; other prefixes are not checked
  lacks(ext(p("`packages/<name>/src` `services/*/test` `config/{a,b}.yaml` `scripts/a b` `docs/nope.md` `a/packages/nope`")), /DOCS-GUIDE-008/);
  // config/<name>.<ext> exists when its .example. sibling does
  lacks(ext({ ...p("`config/config.yaml` `config/expressions.yaml`"), "config/expressions.example.yaml": "a: 1\n" }), /DOCS-GUIDE-008/);
  // a fence is no prose
  lacks(ext(withBody("```text\npackages/nope\n```\n")), /DOCS-GUIDE-008/);
});

// @spec DOCS-GUIDE-009
test("a yaml fence must be a mapping whose key paths are in config.example.yaml", () => {
  const y = (t: string, lang = "yaml") => withBody(`\`\`\`${lang}\n${t}\n\`\`\`\n`);
  fails(ext(y("llm:\n  provider: openai\n  nope: 1")), /typescript-service\.md:\d+.*DOCS-GUIDE-009.*llm\.nope/);
  fails(ext(y("nothing: 1", "yml")), /DOCS-GUIDE-009.*nothing/);
  fails(ext(y("- a\n- b")), /DOCS-GUIDE-009.*mapping/);
  fails(ext(y("just a string")), /DOCS-GUIDE-009.*mapping/);
  fails(ext(y("a: [unclosed")), /DOCS-GUIDE-009.*YAML/);
  fails(ext(y("mouth:\n  list:\n    - a: 1\n      z: 2")), /DOCS-GUIDE-009.*mouth\.list\[\]\.z/);
  fails(ext(y("llm:\n  openai:\n    base_url: x\n    gone: 1")), /DOCS-GUIDE-009.*llm\.openai\.gone/);
  lacks(ext(y("llm:\n  provider: openai\n  openai:\n    base_url: http://x\nmouth:\n  outputs:\n    discord:\n      gain_db: 3\n  list:\n    - a: 1\n      b: 2")), /DOCS-GUIDE-009/);
  lacks(ext(y("llm:\n  provider: mock", "YAML")), /DOCS-GUIDE-009/);
  // other languages are not read as YAML
  lacks(ext(y("nothing: 1", "text")), /DOCS-GUIDE-009/);
});

// @spec DOCS-GUIDE-011
test("an imported example file must be named in a test, or lie in a Rust package whose tests a test runs", () => {
  const noTest = { "packages/bus/test/examples.test.ts": "const x = 1;\n" };
  fails(ext(noTest), /typescript-service\.md.*DOCS-GUIDE-011.*examples\/service\/now-playing\.ts/);
  fails(ext(noTest), /index\.md.*DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/test/b.test.ts": 'const p = "examples/service/now-playing.tsx";\n' }), /DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/test/b.test.ts": 'const p = "examples/service/now-playing.ts.bak";\n' }), /DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/test/b.test.ts": 'const p = "examples/services";\n' }), /DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/src/b.ts": 'const p = "examples/service/now-playing.ts";\n' }), /DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/test/helper.ts": 'const p = "examples/service/now-playing.ts";\n' }), /DOCS-GUIDE-011/);
  fails(ext({ ...noTest, "packages/bus/test/deep/b.test.ts": 'const p = "examples/service/now-playing.ts";\n' }), /DOCS-GUIDE-011/);
  for (const t of ['"examples/service/now-playing.ts"', "'examples/service/now-playing.ts'", "`examples/service/now-playing.ts`", '"examples/service"', "examples/service/now-playing.ts", "examples/service\nnext", "examples/service"]) {
    lacks(ext({ ...noTest, "services/chat/test/b.test.ts": `const p = ${t}` }), /typescript-service\.md.*DOCS-GUIDE-011/);
  }
  // a Rust example package counts when its tests/ holds a .rs file and a test file runs the package
  const rust = { "packages/bus/test/examples.test.ts": 'const a = "examples/service/now-playing.ts";\n' };
  fails(ext(rust), /rust-bus\.md.*DOCS-GUIDE-011.*examples\/rust-bus\/src\/lib\.rs/);
  fails(ext({ ...rust, "packages/bus/test/r.test.ts": 'spawn("cargo", ["test", "-p", "cohost-example-bus"]);', "examples/rust-bus/tests/it.rs": null }), /rust-bus\.md.*DOCS-GUIDE-011/);
  fails(ext({ ...rust, "packages/bus/test/r.test.ts": 'run("cohost-example-bus-other");' }), /rust-bus\.md.*DOCS-GUIDE-011/);
  lacks(ext({ ...rust, "packages/bus/test/r.test.ts": 'spawn("cargo", ["test", "-p", "cohost-example-bus"]);' }), /DOCS-GUIDE-011/);
});

// @spec DOCS-GUIDE-012
test("each page of the Extension guides table imports every file its Examples column lists", () => {
  const g = (row: string) => ({ guides: GUIDES_TABLE + row });
  fails(ext({}, g("| `advanced/extend/typescript-service.md` | x | `examples/service/other.ts` | x |\n")), /typescript-service\.md.*DOCS-GUIDE-012.*examples\/service\/other\.ts/);
  fails(ext({}, g("| `advanced/extend/rust-bus.md` | x | `examples/rust-bus/src/main.rs` | x |\n")), /rust-bus\.md.*DOCS-GUIDE-012.*examples\/rust-bus\/src\/main\.rs/);
  fails(ext({ [`${EXT}rust-bus.md`]: RUST_BUS.replace("<<< @/../examples/rust-bus/src/lib.rs", "") }), /rust-bus\.md.*DOCS-GUIDE-012.*lib\.rs/);
  fails(ext({ [`${EXT}rust-bus.md`]: RUST_BUS.replace("<<< @/../examples/rust-bus/Cargo.toml", "") }), /DOCS-GUIDE-012.*Cargo\.toml/);
  // an entry ending in / is met by importing any file under it
  lacks(ext({}, g("| `advanced/extend/typescript-service.md` | x | `examples/service/` | x |\n")), /DOCS-GUIDE-012/);
  fails(ext({}, g("| `advanced/extend/typescript-service.md` | x | `examples/rust-bus/` | x |\n")), /DOCS-GUIDE-012.*examples\/rust-bus\//);
  // the table is read from the LLD: a missing table is a problem
  const noSection = base("docs/intent/docs-site/docs-site-design.md")!.replace(/## Extension guides[\s\S]*?(?=\n## )/, "");
  fails(ext({ "docs/intent/docs-site/docs-site-design.md": noSection }), /DOCS-GUIDE-012.*Extension guides/);
});

// @spec DOCS-GUIDE-013
test("an Extend guide has the three step headings", () => {
  const good = guide("Add a TypeScript service", IMPORT_NP);
  const without = (h: string) => good.replace(`## ${h}`, `## Not ${h}`);
  fails(ext({ [TS]: without("What you need") }), /typescript-service\.md.*DOCS-GUIDE-013.*What you need/);
  fails(ext({ [TS]: without("How you know it worked") }), /DOCS-GUIDE-013.*How you know it worked/);
  fails(ext({ [TS]: without("If it didn't") }), /DOCS-GUIDE-013.*If it didn't/);
  fails(ext({ [TS]: good.replace(/## If it didn't/, "### If it didn't") }), /DOCS-GUIDE-013/);
  const two = ext({ [TS]: page({ title: "Add a TypeScript service", description: "d", track: "advanced", verified: "1a2b3c4" }, `# T\n\n## What you need\n\n${IMPORT_NP}`) });
  fails(two, /DOCS-GUIDE-013.*How you know it worked/);
  fails(two, /DOCS-GUIDE-013.*If it didn't/);
  lacks(ext({ [TS]: good.replace("If it didn't", "If it didn’t") }), /DOCS-GUIDE-013/);
  // the index, hooks and connector-protocol pages are references
  lacks(ext({ [`${EXT}hooks.md`]: guide("Brain hooks").replace(/## What you need/, "## Needs") }), /DOCS-GUIDE-013/);
});

const tableOf = (rows: string, header = "| Task | Python | TypeScript | Rust | Any language with curl |") => `${header}\n| --- | --- | --- | --- | --- |\n${rows}`;
const indexWith = (table: string) => INDEX.replace(/\| Task \|[\s\S]*$/, table);
const ROW = "| Add a service | — | [Add a TypeScript service](typescript-service.md) | [Rust bus client](rust-bus.md) | — |\n";

// @spec DOCS-GUIDE-014
test("the Ways to extend page holds exactly one Tested examples table of links and dashes", () => {
  const withIdx = (t: string) => ext({ [IDX]: indexWith(t) });
  fails(ext({ [IDX]: INDEX.replace(/## Tested examples[\s\S]*$/, "") }), /index\.md.*DOCS-GUIDE-014.*exactly one/);
  fails(withIdx(tableOf(ROW) + "\n" + tableOf(ROW)), /DOCS-GUIDE-014.*exactly one/);
  fails(withIdx(tableOf(ROW, "| Task | Python | TypeScript | Rust | Any language |")), /DOCS-GUIDE-014.*exactly one/);
  fails(withIdx(tableOf(ROW.replace("| — |", "| - |"))), /DOCS-GUIDE-014.*Add a service.*Python/);
  fails(withIdx(tableOf(ROW.replace("[Add a TypeScript service](typescript-service.md)", "Add a TypeScript service"))), /DOCS-GUIDE-014.*TypeScript/);
  fails(withIdx(tableOf(ROW.replace("[Add a TypeScript service](typescript-service.md)", "[A](typescript-service.md) and [B](rust-bus.md)"))), /DOCS-GUIDE-014.*TypeScript/);
  fails(withIdx(tableOf(ROW.replace(/— \|\n$/, "see [x](https://example.com) |\n"))), /DOCS-GUIDE-014.*Any language/);
  fails(withIdx(tableOf(ROW.replace(/— \|\n$/, "[x](../dev-setup.md) |\n"))), /DOCS-GUIDE-014.*Any language/);
  fails(withIdx(tableOf(ROW.replace("rust-bus.md", "nope.md"))), /DOCS-GUIDE-014.*Rust/);
  fails(withIdx(tableOf(ROW.replace("[Add a TypeScript service](typescript-service.md)", "[A](typescript-service.md) text"))), /DOCS-GUIDE-014.*TypeScript/);
  fails(withIdx(tableOf(ROW.replace("[Add a TypeScript service](typescript-service.md)", "— —"))), /DOCS-GUIDE-014/);
  // another table is allowed; a link fragment or the .html form still names the page
  lacks(withIdx("| a | b |\n| - | - |\n| 1 | 2 |\n\n" + tableOf(ROW.replace("typescript-service.md", "typescript-service#steps").replace("rust-bus.md", "./rust-bus.html"))), /DOCS-GUIDE-014/);
});

// @spec DOCS-GUIDE-015
test("a language cell links a page that imports an example file of that language", () => {
  const row = (py: string, tsc: string, rs: string, sh: string) => `| Add a service | ${py} | ${tsc} | ${rs} | ${sh} |\n`;
  const L = "[Add a TypeScript service](typescript-service.md)";
  const R = "[Rust bus client](rust-bus.md)";
  const t = (r: string) => ext({ [IDX]: indexWith(tableOf(r)) });
  fails(t(row(L, "—", "—", "—")), /DOCS-GUIDE-015.*Add a service.*Python.*typescript-service/);
  fails(t(row("—", R, "—", "—")), /DOCS-GUIDE-015.*TypeScript.*rust-bus/);
  fails(t(row("—", "—", L, "—")), /DOCS-GUIDE-015.*Rust.*typescript-service/);
  fails(t(row("—", "—", "—", L)), /DOCS-GUIDE-015.*Any language with curl.*typescript-service/);
  lacks(t(row("—", L, R, "—")), /DOCS-GUIDE-015/);
  const files = { "examples/service/run.sh": "echo\n", "examples/service/run.py": "print()\n" };
  const s = guide("Add a TypeScript service", `<<< @/../examples/service/run.sh\n\n<<< @/../examples/service/run.py\n\n${IMPORT_NP}`);
  const tested = TESTED_TABLE.replace("| — | Add a TypeScript service | Rust bus client | — |", "| Add a TypeScript service | Add a TypeScript service | Rust bus client | Add a TypeScript service |");
  lacks(ext({ ...files, [TS]: s, [IDX]: indexWith(tableOf(row(L, L, R, L))) }, { tested }), /DOCS-GUIDE-015/);
});

// @spec DOCS-GUIDE-016
test("the Ways to extend table repeats the LLD's Tested examples table", () => {
  const swap = (rows: string) => ext({ [IDX]: indexWith(tableOf(rows)) });
  fails(swap(ROW + "| Extra | — | — | — | — |\n"), /index\.md.*DOCS-GUIDE-016.*Extra/);
  fails(swap(""), /DOCS-GUIDE-016.*Add a service/);
  fails(swap(ROW.replace("Add a service", "Add a thing")), /DOCS-GUIDE-016.*Add a service/);
  fails(swap(ROW.replace("| — | [Add a TypeScript", "| [Rust bus client](rust-bus.md) | [Add a TypeScript")), /DOCS-GUIDE-016.*Python/);
  fails(swap(ROW.replace("[Add a TypeScript service](typescript-service.md)", "—")), /DOCS-GUIDE-016.*TypeScript/);
  fails(swap(ROW.replace("[Rust bus client](rust-bus.md)", "[Add a TypeScript service](typescript-service.md)")), /DOCS-GUIDE-016.*Rust/);
  fails(ext({}, { tested: TESTED_TABLE + "| Second | — | — | — | — |\n" }), /DOCS-GUIDE-016.*Second/);
  fails(ext({}, { tested: TESTED_TABLE.replace("Add a service", "Add **a** service") }), /DOCS-GUIDE-016.*Add \*\*a\*\* service/);
  const two = ROW + "| Second | — | — | — | — |\n";
  const lld2 = TESTED_TABLE + "| Second | — | — | — | — |\n";
  lacks(ext({ [IDX]: indexWith(tableOf(two)) }, { tested: lld2 }), /DOCS-GUIDE-016/);
  fails(ext({ [IDX]: indexWith(tableOf("| Second | — | — | — | — |\n" + ROW)) }, { tested: lld2 }), /DOCS-GUIDE-016/);
  lacks(ext({ [IDX]: indexWith(tableOf(ROW.replace("| Add a service |", "|   Add a service   |"))) }), /DOCS-GUIDE-016/);
});

// @spec DOCS-GUIDE-017
test("the Ways to extend page links every other Extend page and says there is no tested example", () => {
  const noConnector = INDEX.replace("and [Connector protocol](connector-protocol.md)", "");
  fails(ext({ [IDX]: noConnector }), /index\.md.*DOCS-GUIDE-017.*connector-protocol/);
  fails(ext({ [IDX]: INDEX.replace("no tested example", "none") }), /index\.md.*DOCS-GUIDE-017.*no tested example/);
  lacks(ext({ [IDX]: INDEX.replace("no tested example", "NO  Tested\nExample") }), /DOCS-GUIDE-017/);
  lacks(ext({ [IDX]: INDEX.replace("(connector-protocol.md)", "(./connector-protocol.html#top)") }), /DOCS-GUIDE-017/);
  // a page that does not exist needs no link
  lacks(ext({ [IDX]: noConnector, [`${EXT}connector-protocol.md`]: null }, { guides: GUIDES_TABLE.replace(/.*connector-protocol.*\n/, "") }), /DOCS-GUIDE-017/);
});

const HOOK_PAGE = (name: string) => guide(`Hook server in ${name}`, "A hook server sends no heartbeat. Its health is the `hook.<name>` dependency.");
const HOOK_FILES: Record<string, string> = {
  [`${EXT}hook-server-python.md`]: HOOK_PAGE("Python"),
  [`${EXT}hook-server-typescript.md`]: HOOK_PAGE("TypeScript"),
  [`${EXT}hook-server-rust.md`]: HOOK_PAGE("Rust"),
};
const LINKED_INDEX = INDEX.replace("and [Connector protocol](connector-protocol.md)", "and [Connector protocol](connector-protocol.md) [a](hook-server-python.md) [b](hook-server-typescript.md) [c](hook-server-rust.md) [m](model-server.md)");

// @spec DOCS-GUIDE-018
test("each hook server guide says it sends no heartbeat and names hook.<name>", () => {
  const run = (over: Record<string, string>) => ext({ ...HOOK_FILES, ...over, [IDX]: LINKED_INDEX.replace(" [m](model-server.md)", "") });
  passes(run({}));
  for (const f of ["python", "typescript", "rust"]) {
    const path = `${EXT}hook-server-${f}.md`;
    fails(run({ [path]: HOOK_FILES[path]!.replace("no heartbeat", "a quiet pulse") }), new RegExp(`hook-server-${f}\\.md.*DOCS-GUIDE-018.*no heartbeat`));
    fails(run({ [path]: HOOK_FILES[path]!.replace("`hook.<name>`", "`hook.name`") }), new RegExp(`hook-server-${f}\\.md.*DOCS-GUIDE-018.*hook\\.<name>`));
    fails(run({ [path]: HOOK_FILES[path]!.replace("`hook.<name>`", "hook.<name>") }), /DOCS-GUIDE-018/);
  }
  lacks(run({ [`${EXT}hook-server-python.md`]: HOOK_FILES[`${EXT}hook-server-python.md`]!.replace("no heartbeat", "No  Heartbeat") }), /DOCS-GUIDE-018/);
});

// @spec DOCS-GUIDE-019
test("a page importing server.ts, stub.ts or send-clip.ts says it runs on Node 22.18 or later", () => {
  for (const f of ["examples/modules/server.ts", "examples/model-stub/stub.ts", "examples/audio-in/send-clip.ts"]) {
    const files = { [f]: "export {};\n", "packages/bus/test/e.test.ts": `a("${f}"); b("examples/service"); c("cohost-example-bus");` };
    const page1 = (note: string) => guide("Add a TypeScript service", `${IMPORT_NP}\n<<< @/../${f}\n\n${note}\n`);
    fails(ext({ ...files, [TS]: page1("Run it with `node`.") }), new RegExp(`typescript-service\\.md.*DOCS-GUIDE-019.*${f.replace(/[./]/g, "\\$&")}`));
    fails(ext({ ...files, [TS]: page1("Needs Node 22.1.") }), /DOCS-GUIDE-019/);
    lacks(ext({ ...files, [TS]: page1("Runs with `node` on Node 22.18 or later.") }), /DOCS-GUIDE-019/);
  }
  lacks(ext(), /DOCS-GUIDE-019/);
});

// @spec DOCS-GUIDE-020
test("the model server guide names /chat/completions, /models and brain.memory.embedder", () => {
  const body = "cohost requests `<base_url>/chat/completions` and `<base_url>/models`. Embeddings are not sent here; see `brain.memory.embedder`.";
  const go = (b: string) => ext({ [`${EXT}model-server.md`]: guide("Your own model server", b), [IDX]: INDEX.replace("and [Connector protocol](connector-protocol.md)", "and [Connector protocol](connector-protocol.md) [m](model-server.md)") });
  passes(go(body));
  fails(go(body.replace("/chat/completions", "/chat")), /model-server\.md.*DOCS-GUIDE-020.*\/chat\/completions/);
  fails(go(body.replace("`<base_url>/models`", "models")), /DOCS-GUIDE-020.*\/models/);
  fails(go(body.replace("`brain.memory.embedder`", "brain.memory.embedder")), /DOCS-GUIDE-020.*brain\.memory\.embedder/);
  fails(go(body.replace("brain.memory.embedder", "brain.memory.embedders")), /DOCS-GUIDE-020.*brain\.memory\.embedder/);
});

// @spec DOCS-GUIDE-021
test("the Rust bus client guide says no shared runtime and names the three bus names", () => {
  const rb = (f: (t: string) => string) => ({ [`${EXT}rust-bus.md`]: f(RUST_BUS) });
  fails(ext(rb((t) => t.replace("no shared runtime", "a thin runtime"))), /rust-bus\.md.*DOCS-GUIDE-021.*no shared runtime/);
  fails(ext(rb((t) => t.replace("`service.heartbeat`", "service.heartbeat"))), /DOCS-GUIDE-021.*service\.heartbeat/);
  fails(ext(rb((t) => t.replace("`control`", "control"))), /DOCS-GUIDE-021.*control/);
  fails(ext(rb((t) => t.replace("`inject.request`", "inject request"))), /DOCS-GUIDE-021.*inject\.request/);
  lacks(ext(rb((t) => t.replace("no shared runtime", "No Shared\nRuntime"))), /DOCS-GUIDE-021/);
});

const proto = (f: (t: string) => string) => ({ [`${EXT}connector-protocol.md`]: f(CONNECTOR) });

// @spec DOCS-GUIDE-022
test("the Connector protocol page holds a row for each constant of constants.json", () => {
  fails(ext(proto((t) => t.replace("| `MAX_FRAME_BYTES` | `65536` |\n", ""))), /connector-protocol\.md.*DOCS-GUIDE-022.*MAX_FRAME_BYTES.*65536/);
  fails(ext(proto((t) => t.replace("`65536`", "`65535`"))), /DOCS-GUIDE-022.*MAX_FRAME_BYTES.*65536/);
  fails(ext(proto((t) => t.replace("`65536`", "65536"))), /DOCS-GUIDE-022.*MAX_FRAME_BYTES/);
  fails(ext(proto((t) => t.replace("`65536`", "`65536` bytes"))), /DOCS-GUIDE-022.*MAX_FRAME_BYTES/);
  fails(ext(proto((t) => t.replace("| `FRAME_VERSION` |", "| FRAME_VERSION |"))), /DOCS-GUIDE-022.*FRAME_VERSION/);
  fails(ext(proto((t) => t.replace("| `AUDIO_MAXLEN.out` | `1500` |\n", ""))), /DOCS-GUIDE-022.*AUDIO_MAXLEN\.out.*1500/);
  fails(ext(proto((t) => t.replace("`AUDIO_MAXLEN.in`", "`AUDIO_MAXLEN`"))), /DOCS-GUIDE-022.*AUDIO_MAXLEN\.in.*3000/);
  fails(ext(proto((t) => t.replace("`60000`", '`"60000"`'))), /DOCS-GUIDE-022.*AUDIO_STREAM_TTL_MS.*60000/);
  // the expected text is the value's JSON text, read from constants.json
  const withText = { "packages/bus/fixtures/contract/constants.json": JSON.stringify({ ...CONSTANTS, LABEL: "x y", FLAG: true, NOTHING: null, LIST: [1, 2] }) };
  fails(ext({ ...withText, ...proto((t) => t) }), /DOCS-GUIDE-022.*LABEL.*"x y"/);
  fails(ext({ ...withText, ...proto((t) => t) }), /DOCS-GUIDE-022.*LIST.*\[1,2\]/);
  lacks(ext({ ...withText, ...proto((t) => t.replace("| `FRAME_VERSION` | `1` |\n", (m) => m + '| `LABEL` | `"x y"` |\n| `FLAG` | `true` |\n| `NOTHING` | `null` |\n| `LIST` | `[1,2]` |\n')) }), /DOCS-GUIDE-022/);
  // `names` has no row; extra rows are fine
  lacks(ext(proto((t) => t.replace("| `FRAME_VERSION` | `1` |\n", (m) => m + "| `EXTRA` | `1` |\n"))), /DOCS-GUIDE-022/);
});

// @spec DOCS-GUIDE-023
test("the Connector protocol page names the key forms from constants.json and links the fixtures", () => {
  fails(ext(proto((t) => t.replace("`<prefix>:connector:<id>`", "`<prefix>:connector:<name>`"))), /connector-protocol\.md.*DOCS-GUIDE-023.*<prefix>:connector:<id>/);
  fails(ext(proto((t) => t.replace("`<prefix>:audio.in.<tag>`", "<prefix>:audio.in.<tag>"))), /DOCS-GUIDE-023.*<prefix>:audio\.in\.<tag>/);
  fails(ext(proto((t) => t.replace("`<prefix>:audio.out.<tag>`", "`<prefix>:audio.in.<tag>`"))), /DOCS-GUIDE-023.*<prefix>:audio\.out\.<tag>/);
  fails(ext(proto((t) => t.replace(`(${FIXTURES_URL})`, "(https://github.com/CoderCoco-Studios/cohost/tree/main/packages/bus)"))), /DOCS-GUIDE-023.*fixtures\/contract/);
  const other = { ...CONSTANTS, names: { ...CONSTANTS.names, connectorKey: "p1:link:disc", audioStream: "p1:sound.in.discord" } };
  fails(ext({ "packages/bus/fixtures/contract/constants.json": JSON.stringify(other) }), /DOCS-GUIDE-023.*<prefix>:link:<id>/);
  fails(ext({ "packages/bus/fixtures/contract/constants.json": JSON.stringify(other) }), /DOCS-GUIDE-023.*<prefix>:sound\.out\.<tag>/);
  lacks(ext(proto((t) => t.replace(`(${FIXTURES_URL})`, `(${FIXTURES_URL}/)`))), /DOCS-GUIDE-023/);
});

// @spec DOCS-GUIDE-024
test("the Connector protocol page says no SDK, not a supported route, and names @cohost/bus", () => {
  fails(ext(proto((t) => t.replace("no SDK", "no kit"))), /connector-protocol\.md.*DOCS-GUIDE-024.*no SDK/);
  fails(ext(proto((t) => t.replace("not a supported route", "discouraged"))), /DOCS-GUIDE-024.*not a supported route/);
  fails(ext(proto((t) => t.replace("`@cohost/bus`", "@cohost/bus"))), /DOCS-GUIDE-024.*@cohost\/bus/);
  lacks(ext(proto((t) => t.replace("no SDK", "No sdk").replace("not a supported route", "Not  a  Supported route"))), /DOCS-GUIDE-024/);
});

// @spec DOCS-EX-002
test("the modules README names its seven files as code spans and the three servers' mise tasks in a shell fence", () => {
  const p = "examples/modules/README.md";
  const site = "[Brain hooks](https://codercoco-studios.github.io/cohost/advanced/extend/hooks)";
  const names = "`server.py`, `server.ts`, `rust/`, `try.sh`, `try.expected.txt`, `fixtures/`, `schemas/`";
  const runs = "```sh\nmise run example:hook-server:py\nmise run example:hook-server:ts\nmise run example:hook-server:rust\n```";
  passes(check({ [p]: `# M\n\n${names}.\n\n${runs}\n\n${site}\n` }));
  for (const n of ["server.py", "server.ts", "rust/", "try.sh", "try.expected.txt", "fixtures/", "schemas/"]) {
    fails(check({ [p]: `# M\n\n${names.replace(`\`${n}\``, n)}.\n\n${runs}\n\n${site}\n` }), new RegExp(`modules/README\\.md.*DOCS-EX-002.*${n.replace(/[./]/g, "\\$&")}`));
  }
  for (const lang of ["py", "ts", "rust"]) {
    fails(check({ [p]: `# M\n\n${names}.\n\n${runs.replace(`mise run example:hook-server:${lang}\n`, "")}\n\n${site}\n` }), new RegExp(`DOCS-EX-002.*example:hook-server:${lang}`));
  }
  fails(check({ [p]: `# M\n\n${names}.\n\n${runs.replace("```sh", "```text")}\n\n${site}\n` }), /DOCS-EX-002/);
  fails(check({ [p]: `# M\n\n${names}.\n\n${runs}\n` }), /DOCS-EX-002.*hooks/);
  passes(check({ [p]: `# M\n\n${names}.\n\n${runs.replace("mise run example:hook-server:py", "mise run -q example:hook-server:py")}\n\n${site}\n` }));
});

// @spec DOCS-EX-005
test("each example directory other than modules has a README naming its files and linking its guide", () => {
  const rd = "examples/service/README.md";
  const guideUrl = `${SITE}advanced/extend/typescript-service`;
  fails(ext({ [rd]: null }), /examples\/service\/README\.md.*DOCS-EX-005.*does not exist/);
  fails(ext({ [rd]: SERVICE_README.replace("`now-playing.ts`", "now-playing.ts") }), /examples\/service\/README\.md.*DOCS-EX-005.*now-playing\.ts/);
  fails(ext({ [rd]: SERVICE_README.replace("`now-playing.ts`", "`examples/service/now-playing.ts`") }), /DOCS-EX-005.*now-playing\.ts/);
  fails(ext({ [rd]: SERVICE_README.replace(guideUrl, `${SITE}advanced/extend/hooks`) }), /examples\/service\/README\.md.*DOCS-EX-005.*link/);
  fails(ext({ [rd]: SERVICE_README.replace(guideUrl, "typescript-service") }), /DOCS-EX-005.*link/);
  fails(ext({ "examples/rust-bus/README.md": RUST_README.replace("`main.rs`", "main.rs") }), /examples\/rust-bus\/README\.md.*DOCS-EX-005.*main\.rs/);
  fails(ext({ "examples/rust-bus/README.md": RUST_README.replace("`lib.rs`", "`src/lib.rs`") }), /DOCS-EX-005.*lib\.rs/);
  passes(ext({ [rd]: SERVICE_README.replace(guideUrl, `${guideUrl}/#steps`) }));
  passes(ext({ [rd]: SERVICE_README.replace(guideUrl, `${guideUrl}.html`) }));
  // any Extend page whose Examples column lists a path under the directory will do, the index page included
  passes(ext({ [rd]: SERVICE_README.replace(guideUrl, `${SITE}advanced/extend/`) }));
  // the Holds column drives the check, and the package name in it is no file
  fails(ext({}, { layout: LAYOUT_TABLE.replace("`now-playing.ts` |", "`now-playing.ts`, `extra.ts` |") }), /examples\/service\/README\.md.*DOCS-EX-005.*extra\.ts/);
  fails(ext({}, { layout: LAYOUT_TABLE + "| `examples/orphan/` | `a.sh` | x |\n" }), /examples\/orphan\/README\.md.*DOCS-EX-005/);
});

// @spec DOCS-PAGE-006
test("the Ways to extend page links the TypeScript service and Rust bus client guides", () => {
  fails(ext({ [IDX]: INDEX.replaceAll("typescript-service.md", "other.md") }), /index\.md.*DOCS-PAGE-006.*typescript-service/);
  fails(ext({ [IDX]: INDEX.replaceAll("rust-bus.md", "other.md") }), /index\.md.*DOCS-PAGE-006.*rust-bus/);
  fails(ext({ [IDX]: INDEX.replace("no event validation", "no checking") }), /DOCS-PAGE-006.*event validation/);
  fails(ext({ [IDX]: INDEX.replace("`@cohost/bus`", "the bus client") }), /DOCS-PAGE-006.*@cohost\/bus/);
  fails(ext({ [IDX]: INDEX.replace("Build on", "A Python service is a supported way to add a service.\n\nBuild on") }), /DOCS-PAGE-006.*Python/);
});
