import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { check, baseFiles, page, repoRoot, script, REQUIRED_TERMS, writeTree } from "./helpers/docs-fixture.ts";

const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");
const load = (p: string): Promise<any> => import(pathToFileURL(join(repoRoot, p)).href);
const pkg = () => JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const frontmatter = (title: string, track: string, extra = "") => `---\ntitle: ${title}\ndescription: About ${title}.\ntrack: ${track}\n${extra}---\n\n`;

function fails(r: { code: number | null; err: string; out: string }, re: RegExp) {
  assert.equal(r.code, 1, `expected exit 1; stdout: ${r.out} stderr: ${r.err}`);
  assert.match(r.err, re);
}
function passes(r: { code: number | null; err: string; out: string }) {
  assert.equal(r.code, 0, `expected exit 0; stdout: ${r.out} stderr: ${r.err}`);
}


// A built site holding the pages the README and examples READMEs link; `files` adds to or replaces them.
const BUILT: Record<string, string> = { "guide/install/real-install.html": "", "advanced/extend/hooks.html": "" };
const distRaw = (files: Record<string, string>) => (dir: string) => writeTree(join(dir, "docs/.vitepress/dist"), files);
const dist = (files: Record<string, string>) => distRaw({ ...BUILT, ...files });

// ---------------------------------------------------------------- Build

// @spec DOCS-BUILD-001
test("docs:build runs the source check, vitepress build, then the built-site check, chained with &&", () => {
  assert.equal(pkg().scripts["docs:build"], "node scripts/docs-check.mjs && vitepress build docs && node scripts/docs-check.mjs --dist");
});

// @spec DOCS-BUILD-002
test("docs:dev runs vitepress dev alone", () => {
  assert.equal(pkg().scripts["docs:dev"], "vitepress dev docs");
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
  const cfg = baseFiles()["docs/.vitepress/config.ts"].replace("base:", "ignoreDeadLinks: true, base:");
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
test("no docs script writes a markdown page", () => {
  const s = pkg().scripts;
  assert.equal(s["docs:prepare"], undefined);
  for (const [name, cmd] of Object.entries(s)) {
    if (!name.startsWith("docs:")) continue;
    for (const part of cmd.split("&&")) assert.match(part.trim(), /^(vitepress (dev|build|preview) docs|node scripts\/docs-check\.mjs( --dist)?)$/, name);
  }
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
  const cfg = baseFiles()["docs/.vitepress/config.ts"].replace("'lid/**', ", "");
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
  const swapped = baseFiles()["docs/.vitepress/sidebar.mjs"]
    .replace("{ text: 'What you need', link: '/guide/install/prerequisites' },\n      { text: 'Try it', link: '/guide/install/first-run' },", "{ text: 'Try it', link: '/guide/install/first-run' },\n      { text: 'What you need', link: '/guide/install/prerequisites' },");
  fails(check({ "docs/.vitepress/sidebar.mjs": swapped }), /DOCS-IA-002.*order/);
});

// @spec DOCS-IA-003
test("a sidebar link to no published page fails", () => {
  const bad = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("link: '/start/glossary'", "link: '/start/nowhere'");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-003.*\/start\/nowhere/);
});

// @spec DOCS-IA-003
test("a nav link to no published page fails", () => {
  const bad = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("link: '/project/spec-driven' },\n];", "link: '/project/nowhere' },\n];");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-003.*\/project\/nowhere/);
});

// @spec DOCS-IA-004
test("a page missing from the sidebar, or listed twice, fails", () => {
  const missing = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n", "");
  fails(check({ "docs/.vitepress/sidebar.mjs": missing }), /guide\/troubleshooting\.md.*DOCS-IA-004/);
  const twice = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n", "    { text: 'Troubleshooting', link: '/guide/troubleshooting' },\n    { text: 'Again', link: '/guide/troubleshooting' },\n");
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
  const bad = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("{ text: 'Install', collapsed: false", "{ text: 'Install', collapsed: true");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-005.*Install/);
});

// @spec DOCS-IA-006
test("the glossary has no prev/next and How it works points next at What you need", () => {
  fails(check({ "docs/start/glossary.md": baseFiles()["docs/start/glossary.md"].replace("next: false\n", "") }), /glossary\.md.*DOCS-IA-006/);
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
  const bad = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("{ text: 'Guide', link: '/guide/install/prerequisites' },\n  { text: 'Advanced', link: '/advanced/dev-setup' },", "{ text: 'Advanced', link: '/advanced/dev-setup' },\n  { text: 'Guide', link: '/guide/install/prerequisites' },");
  fails(check({ "docs/.vitepress/sidebar.mjs": bad }), /DOCS-IA-007/);
});

// @spec DOCS-IA-008
test("the home page's three entry actions link the three starting pages", () => {
  const home = baseFiles()["docs/index.md"].replace("link: /advanced/dev-setup", "link: /advanced/nowhere");
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
  const bad = baseFiles()["docs/.vitepress/sidebar.mjs"].replace("{ text: 'Twitch chat', link: '/guide/connect/twitch' }", "{ text: 'Deep', collapsed: true, items: [{ text: 'Twitch chat', link: '/guide/connect/twitch' }] }");
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
  fails(check({ "docs/index.md": baseFiles()["docs/index.md"].replace("track: start", "track: simple") }), /docs\/index\.md.*DOCS-PAGE-001/);
});

// @spec DOCS-PAGE-002
test("a page with a fenced code block needs a verified SHA of 7 to 40 lowercase hex characters", () => {
  const p = "docs/guide/troubleshooting.md";
  const body = "# T\n\n```sh\npnpm build\n```\n";
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
  fails(check({ README: null, "README.md": baseFiles()["README.md"].replace("A co-host.", "A legacy co-host.") }), /README\.md:3.*DOCS-PAGE-004/);
  passes(check({ "docs/project/verification-log.md": frontmatter("Verification log", "project") + "# V\n\nFormerly deprecated legacy previously.\n" }));
});

// @spec DOCS-PAGE-005
test("install and connect step pages carry the three headings and link troubleshooting from 'If it didn't'", () => {
  const p = "docs/guide/connect/twitch.md";
  const good = baseFiles()[p];
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
  fails(check({ [p]: fm() + "# Ways\n\nUse `@cohost/bus`. The Rust route has no example yet. No event validation, no dashboard control, no health reporting for others.\n" }), /DOCS-PAGE-006.*crates\/cohost-bus/);
  fails(check({ [p]: fm() + "# Ways\n\nUse `@cohost/bus` or `crates/cohost-bus`. Others get no event validation, no dashboard control, no health reporting.\n" }), /DOCS-PAGE-006.*no example/);
  fails(check({ [p]: fm() + "# Ways\n\nUse `@cohost/bus` or `crates/cohost-bus` (no example yet). Others get no event validation.\n" }), /DOCS-PAGE-006.*dashboard control|DOCS-PAGE-006.*health reporting/);
  fails(check({ [p]: fm() + "# Ways\n\nUse `@cohost/bus` or `crates/cohost-bus` (no example yet). A Python service is a supported way to extend cohost.\n" }), /DOCS-PAGE-006/);
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
  const g = baseFiles()["docs/start/glossary.md"];
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
  const g = baseFiles()["docs/start/glossary.md"];
  fails(check({ "docs/start/glossary.md": g.replace(/  - id: pgvector\n    match: \[pgvector\]\n/, "").replace("### pgvector {#pgvector}", "### nothing {#nothing}") }), /glossary\.md.*DOCS-GLOSS-003.*pgvector/);
});

// @spec DOCS-GLOSS-004
test("relative and root-relative glossary links count, with or without .md", () => {
  const p = "docs/guide/connect/twitch.md";
  const good = baseFiles()[p];
  for (const href of ["../../start/glossary.md#redis", "../../start/glossary#redis", "/start/glossary#redis", "/start/glossary.md#redis"]) {
    passes(check({ [p]: good.replace("A PC.", `[Redis](${href}) runs.`) }));
  }
  passes(check({ "docs/start/how-it-works.md": baseFiles()["docs/start/how-it-works.md"].replace("It listens.", "[Redis](glossary#redis) runs.") }));
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
  fails(check({ "README.md": baseFiles()["README.md"].replace("A co-host.", `A [x](${gh}/blob/main/zzz) co-host.`) }), /README\.md.*DOCS-LINK-002/);
  fails(check({ "examples/README.md": baseFiles()["examples/README.md"] + `[x](${gh}/blob/main/zzz)\n` }), /examples\/README\.md.*DOCS-LINK-002/);
  passes(check({ [p]: mk("[o](https://github.com/OtherOrg/other/blob/main/nope)") }));
});

// @spec DOCS-LINK-003
test("README and examples links to the published site must map to a built file holding the fragment", () => {
  const built = { "index.html": "<html></html>", "guide/install/real-install.html": '<h2 id="x">x</h2>', "advanced/extend/hooks.html": "<html></html>" };
  passes(check({}, ["--dist"], distRaw(built)));
  fails(check({}, ["--dist"], distRaw({ "index.html": "", "advanced/extend/hooks.html": "" })), /README\.md.*DOCS-LINK-003.*real-install/);
  const frag = { "README.md": baseFiles()["README.md"].replace("real-install)", "real-install#nope)") };
  fails(check(frag, ["--dist"], distRaw(built)), /DOCS-LINK-003.*#nope/);
  passes(check({ "README.md": baseFiles()["README.md"].replace("real-install)", "real-install#x)") }, ["--dist"], distRaw(built)));
  // path ending in / maps to index.html
  const idx = { "examples/README.md": baseFiles()["examples/README.md"] + "[t](https://codercoco-studios.github.io/cohost/advanced/testing/)\n" };
  fails(check(idx, ["--dist"], distRaw(built)), /examples\/README\.md.*DOCS-LINK-003.*testing/);
  passes(check(idx, ["--dist"], distRaw({ ...built, "advanced/testing/index.html": "<html></html>" })));
  fails(check({}, ["--dist"], distRaw({ "index.html": "" , "advanced/extend/hooks.html": "" })), /DOCS-LINK-003/);
});

// ---------------------------------------------------------------- Facts

const shellPage = (fence: string, lang = "sh") => frontmatter("T", "simple", "verified: 1a2b3c4\n") + `# T\n\n\`\`\`${lang}\n${fence}\n\`\`\`\n`;
const FP = "docs/guide/troubleshooting.md";

// @spec DOCS-FACT-001
test("pnpm commands in shell fences must name a root package.json script", () => {
  passes(check({ [FP]: shellPage("pnpm dashboard\npnpm build\npnpm install\npnpm run test\npnpm -r build\npnpm --filter x foo\npnpm -C x nope") }));
  fails(check({ [FP]: shellPage("pnpm dashbord") }), /troubleshooting\.md:11.*DOCS-FACT-001.*dashbord/);
  fails(check({ [FP]: shellPage("pnpm run nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("PORT=4000 pnpm nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("cd x && pnpm nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("pnpm --silent nope") }), /DOCS-FACT-001.*nope/);
  fails(check({ [FP]: shellPage("$ pnpm nope\nok", "console") }), /DOCS-FACT-001.*nope/);
  passes(check({ [FP]: shellPage("pnpm nope\n$ pnpm nope", "console") }));
  passes(check({ [FP]: shellPage("# pnpm nope in a comment-first fence\npnpm nope") }));
  passes(check({ [FP]: shellPage("pnpm nope", "text") }));
  fails(check({ "README.md": baseFiles()["README.md"].replace("pnpm dashboard", "pnpm dashbord") }), /README\.md.*DOCS-FACT-001/);
});

// @spec DOCS-FACT-002
test("NAME= assignments in shell and env fences must be named on the environment page", () => {
  passes(check({ [FP]: shellPage("DASHBOARD_PORT=4000 pnpm dashboard\nexport LLM_PROVIDER=mock\ncd x") }));
  fails(check({ [FP]: shellPage("PORT=4000 pnpm dashboard") }), /troubleshooting\.md:11.*DOCS-FACT-002.*PORT/);
  fails(check({ [FP]: shellPage("export NOPE_X=1") }), /DOCS-FACT-002.*NOPE_X/);
  fails(check({ [FP]: shellPage("NOPE_X=1", "env") }), /DOCS-FACT-002.*NOPE_X/);
  fails(check({ [FP]: shellPage("NOPE_X=1", "dotenv") }), /DOCS-FACT-002.*NOPE_X/);
  passes(check({ [FP]: shellPage("lowercase=1 echo hi\n# NOPE_X=1\nNOPE_X=1", "text") }));
  fails(check({ "README.md": baseFiles()["README.md"].replace("CHAT_SOURCE=fake", "CHAT_SOURCE=fake\nNOPE_Y=1") }), /README\.md.*DOCS-FACT-002.*NOPE_Y/);
});

// @spec DOCS-FACT-003
test("the environment page names every variable .env.example assigns or comments", () => {
  const env = baseFiles()["docs/advanced/reference/env.md"];
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "") }), /env\.md.*DOCS-FACT-003.*LLM_PROVIDER/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `COMPOSE_PROFILES`\n", "") }), /DOCS-FACT-003.*COMPOSE_PROFILES/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "- LLM_PROVIDER in prose, not a code span\n") }), /DOCS-FACT-003.*LLM_PROVIDER/);
  passes(check({ "docs/advanced/reference/env.md": env.replace("- `LLM_PROVIDER`\n", "- `LLM_PROVIDER=ollama`\n") }));
});

// @spec DOCS-FACT-004
test("the environment page names every published host port with its compose default", () => {
  const env = baseFiles()["docs/advanced/reference/env.md"];
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `6379`\n", "") }), /env\.md.*DOCS-FACT-004.*6379/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `11434`\n", "") }), /DOCS-FACT-004.*11434/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `3001`\n", "").replace("- `DASHBOARD_LAN_PORT`\n", "- `DASHBOARD_LAN_PORT`, nothing else\n") }), /DOCS-FACT-004.*3001/);
  fails(check({ "docs/advanced/reference/env.md": env.replace("- `3000`\n", "") }), /DOCS-FACT-004.*3000/);
  fails(check({ "docker-compose.yml": baseFiles()["docker-compose.yml"] + '  extra:\n    ports:\n      - "8080:80"\n' }), /DOCS-FACT-004.*8080/);
  passes(check({ "docker-compose.yml": baseFiles()["docker-compose.yml"] + '  extra:\n    ports:\n      - "127.0.0.1:6379:6379"\n' }));
});

// @spec DOCS-FACT-005
test("the configuration page names every key path of config.example.yaml", () => {
  const cfg = baseFiles()["docs/advanced/reference/config.md"];
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
  const ev = baseFiles()["docs/advanced/reference/events.md"];
  fails(check({ "docs/advanced/reference/events.md": ev.replace("- `speech.heard`", "") }), /events\.md.*DOCS-FACT-006.*speech\.heard/);
  fails(check({ "packages/bus/src/events.ts": baseFiles()["packages/bus/src/events.ts"].replace('  "speech.heard"', '  "voice.utterance": z.object({}),\n  "speech.heard"') }), /DOCS-FACT-006.*voice\.utterance/);
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
    assert.deepEqual(d.decisions.map((p: any) => p.slug).sort(), ["three", "two"]);
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
      const fm = /^---\n([\s\S]*?)\n---/.exec(p.content as string);
      assert.ok(fm, p.slug);
      assert.match(fm![1], /^track: advanced$/m);
      assert.match(fm![1], /^title: .+$/m);
      assert.match(fm![1], /^description: .+$/m);
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

const readmeWith = (fn: (t: string) => string) => ({ "README.md": fn(baseFiles()["README.md"]) });

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
test("the README quick start clones, changes directory, then at most five commands reaching mock mode", () => {
  fails(check(readmeWith((t) => t.replace("cd cohost\n", ""))), /README\.md.*DOCS-README-003.*cd/);
  fails(check(readmeWith((t) => t.replace("git clone https://github.com/CoderCoco-Studios/cohost.git\n", ""))), /DOCS-README-003.*clone/);
  fails(check(readmeWith((t) => t.replace("scripts/install.sh\n", ""))), /DOCS-README-003.*install\.sh/);
  fails(check(readmeWith((t) => t.replace("pnpm dashboard\n", "pnpm build\n"))), /DOCS-README-003.*pnpm dashboard/);
  fails(check(readmeWith((t) => t.replace("VOICE_ENGINE=stub\n", ""))), /DOCS-README-003.*VOICE_ENGINE=stub/);
  fails(check(readmeWith((t) => t.replace("pnpm dashboard\n", "pnpm build\npnpm test\npnpm build\npnpm dashboard\n"))), /DOCS-README-003.*(five|5)/);
  fails(check(readmeWith((t) => t.replace(/\[Install for real\]\([^)]*\)/, "[Install](https://codercoco-studios.github.io/cohost/)"))), /DOCS-README-003.*real-install/);
  // a heredoc counts as one command line
  passes(check(readmeWith((t) => t.replace("scripts/install.sh\n", "scripts/install.sh\ntrue\ntrue\n"))));
});

// @spec DOCS-README-004
test("README.md links the docs site", () => {
  fails(check(readmeWith((t) => t.replace("Read the [docs](https://codercoco-studios.github.io/cohost/).", "Read the docs."))), /README\.md.*DOCS-README-004/);
});

// ---------------------------------------------------------------- Examples

// @spec DOCS-EX-001
test("every README under examples/ is at most 30 lines and links the site", () => {
  fails(check({ "examples/README.md": baseFiles()["examples/README.md"] + "\n".repeat(30) }), /examples\/README\.md.*DOCS-EX-001/);
  fails(check({ "examples/README.md": "# Examples\n\n- `modules/`: a thing.\n" }), /examples\/README\.md.*DOCS-EX-001.*link/);
  fails(check({ "examples/modules/deep/README.md": "# deep\n" }), /examples\/modules\/deep\/README\.md.*DOCS-EX-001/);
});

// @spec DOCS-EX-002
test("the modules README names its files, how to run server.py and links Brain hooks", () => {
  const p = "examples/modules/README.md";
  const site = "[Brain hooks](https://codercoco-studios.github.io/cohost/advanced/extend/hooks)";
  fails(check({ [p]: `# M\n\n\`server.py\`, \`fixtures/\`.\n\n\`\`\`sh\npython3 server.py\n\`\`\`\n\n${site}\n` }), /modules\/README\.md.*DOCS-EX-002.*schemas\//);
  fails(check({ [p]: `# M\n\n\`server.py\`, \`fixtures/\`, \`schemas/\`.\n\n${site}\n` }), /DOCS-EX-002.*run/);
  fails(check({ [p]: "# M\n\n`server.py`, `fixtures/`, `schemas/`.\n\n```sh\npython3 server.py\n```\n\n[docs](https://codercoco-studios.github.io/cohost/)\n" }), /DOCS-EX-002.*hooks/);
});

// @spec DOCS-EX-003
test("the examples README lists each directory with a description", () => {
  const files = { "examples/extra/run.sh": "echo\n" };
  fails(check(files), /examples\/README\.md.*DOCS-EX-003.*extra/);
  passes(check({ ...files, "examples/README.md": baseFiles()["examples/README.md"] + "- `extra/`: a script to run.\n" }));
  fails(check({ ...files, "examples/README.md": baseFiles()["examples/README.md"] + "- `extra/`\n" }), /DOCS-EX-003.*extra/);
});

// @spec DOCS-EX-004
test("every examples directory holds a file other than its README", () => {
  const files = { "examples/prose/README.md": "# p\n\n[docs](https://codercoco-studios.github.io/cohost/)\n", "examples/README.md": baseFiles()["examples/README.md"] + "- `prose/`: only prose here.\n" };
  fails(check(files), /examples\/prose.*DOCS-EX-004/);
  passes(check({ ...files, "examples/prose/run.sh": "echo\n" }));
});

// ---------------------------------------------------------------- the real repository

test("the check script has no dependencies beyond the workspace's and the fixture suite is clean", () => {
  assert.equal(existsSync(script), true);
  passes(check());
});
