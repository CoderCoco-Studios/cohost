# Arrow: docs-site

The published documentation site: a VitePress site under `docs/` with a plain-language track and an advanced track for a reader who knows nothing about the domain, hand-written pages in one voice, a glossary, build-time excerpts of the design documents, the boundary between published pages and the unpublished design tree, the site's theme and personality (palette, mascot, track badges, the co-host aside, build-time diagrams, the 404 page), and the checks `mise run docs:build` runs. Also the README as a short pointer to the site, and the `examples/` READMEs as directory guides.

## Status

**#372 settings store (built, step 4):** 156 specs: 155 `[x]`, 1 `[ ]`, 0 `[D]`; every operator and developer page describes the settings store ([settings-store.md](settings-store.md)), the new Operate page `guide/operate/settings.md` covers the recovery key, backups, export and import, recovery mode and the one-time import of older settings files, and DOCS-README-003 and DOCS-EX-004 are built. The status paragraphs below describe the code before that design.

**MAPPED** — 156 specs: 155 implemented, 0 deferred, 1 gap (DOCS-THEME-017, the favicon). DOCS-BUILD-001, -002, -006, DOCS-README-003, DOCS-FACT-001, DOCS-GUIDE-005 and -026 follow the `mise run docs:*` tasks of deployment #344 and are implemented. The README quick start (DOCS-README-003) and the ports the Environment page names (DOCS-FACT-004) follow the config-owned settings and are implemented and tested. The pages, loaders, sidebar data, config, docs check and theme (DOCS-THEME-001 to DOCS-THEME-056) exist and are tested; DOCS-THEME-049 was reviewed by eye on 2026-11-15 (Verification log); DOCS-THEME-017 stays open until the favicon's drawing is checked in a browser. DOCS-LIVE-001 to 013 (the live health table on the Service health page) are implemented and tested, and the dashboard-served site and table were observed in a browser on 2026-11-15 (Verification log). The extension guides (LLD § Extension guides) are built and tested: the docs check's Extend rules and `docs-guides.test.ts` (DOCS-GUIDE-001 to 026), the examples READMEs (DOCS-EX-002, DOCS-EX-005), the twelve Extend pages and the reworded DOCS-PAGE-006. The example specs in the owning segments are implemented too; the Rust bus example's round trip (BUS-NAT-EX-002 to 005) ran in CI against Redis. The Dashboard tour (`guide/operate/dashboard.md`) and the HTTP routes page (`advanced/reference/http.md`) describe the React dashboard (dashboard DASH-DOCS-013 to 016), and the operator guides name its screens and controls. A separate audit has not been run.

## Orientation

- Design: LLD § Reader and tracks, § Page tree (every page's path and track), § Page authoring (frontmatter, `verified:`, glossary links), § Voice, § README and examples, § Extension guides (the guide set, the Extension guides, Tested examples and Example layout tables the docs check reads, snippet imports and the Extend page checks), § Architecture section (dynamic-route excerpts), § Publishing boundary, § Build and checks, § Theme and personality (Palette and Contrast pairs tables the docs check reads), § Served by the dashboard (the live health component).
- Cross-segment edges: deployment runs the build (`docs-build`, `pages`; DEPLOY-CI-003, DEPLOY-CI-004), owns the licence footer (DEPLOY-LIC-004) and the content specs that name site pages (DEPLOY-HOST-003, -004, DEPLOY-README-002, -003, -005, -006, DEPLOY-INST-011). Every leaf LLD is excerpted, so each must keep a `## Context and Design Philosophy` section, and the HLD Segments table must list exactly the leaf LLDs (DOCS-ARCH-004). The dashboard serves the build at `/cohost/` (DASH-DOCS-*), answers the live health component's `GET /services` (DASH-FEED-006) and links the Service health page's `#the-states` anchor (DASH-UI-025, kept by DOCS-LIVE-012); `mise run dashboard` rebuilds the site when it changed (DEPLOY-HOST-001). The Extend pages import examples owned by region-hooks (HOOK-EX-*), model-backends (LLM-EX-*), ears (EARS-EX-*), avatar (AVATAR-EX-*), module-contract (MOD-EX-*) and event-bus (BUS-NAT-EX-*); the Connector protocol page is checked against event-bus's `constants.json` (BUS-NAT-FIX-001). `examples/` has its own TypeScript project and Cargo workspace, named by no root manifest, so deployment's image build is unaffected.

## References

### HLD
- docs/high-level-design.md (Target Users, Segments table: operator / docs-site, References)

### LLD
- docs/intent/docs-site/docs-site-design.md

### EARS
- docs/intent/docs-site/docs-site-specs.md (156 specs, prefix `DOCS`: 155 `[x]`, 1 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/docs-check.test.ts (the docs check, sidebar, loaders and README/examples shape)
- packages/config/test/live-health.test.ts (the live health module, DOCS-LIVE-004 to 010)
- packages/config/test/docs-guides.test.ts (planned: config fragments on Extend pages through `ConfigSchema`, type-checking `examples/tsconfig.json`, building the examples Cargo workspace and comparing its lockfile, DOCS-GUIDE-010, 025, 026)
- packages/config/test/helpers/ (fixtures it builds)

### Code
Annotated: `scripts/docs-check.mjs`, `docs/.vitepress/config.ts`, `docs/.vitepress/sidebar.mjs`, `docs/.vitepress/design-excerpts.mjs`, `docs/.vitepress/aside-container.mjs`, the `*.paths.mjs` loaders under `docs/advanced/architecture/`.
Cited with `<!-- impl: -->` (unannotated): the `docs:*` scripts in `package.json`, `.gitignore`, `README.md`, the READMEs and `server.py` under `examples/`.

## Architecture

**Purpose:** Teach cohost to someone who knows nothing about its domain, from first install to extending it, without a second copy of any fact the repository already holds.

**Key Components:**
1. Hand-written pages under `docs/` in four tracks (`start`, `simple`, `advanced`, `project`), one sidebar.
2. Glossary with machine-checked links from every page that uses a term.
3. Architecture excerpts: dynamic routes over the HLD, each leaf LLD's Context and Design Philosophy, and the current decision documents.
4. `scripts/docs-check.mjs`: frontmatter, sidebar, glossary, facts against `package.json`, `.env.example`, `config.example.yaml` and the bus event registry, GitHub links, narration phrases, README and examples shape; a built-site pass for the publishing boundary and anchors.
5. Theme (`docs/.vitepress/theme/`): extends VitePress's default theme with a token palette, the cohost mark, track badges, aside and callout styling, the home flow and the 404 page; Mermaid fences rendered to SVG at build time; theme checks for contrast, network origins, motion, focus, print and narrow screens, plus a manual review on the Verification log.
6. Live health: `LiveHealth.vue` over `live-health.mjs`, on the Service health page; reads the dashboard's `GET /services` when the dashboard serves the site and shows a note anywhere else.
7. Extension guides: twelve Extend pages, examples under `examples/` shown by VitePress code imports, and the Extend page checks (snippet imports, fence languages, command words, paths, config fragments, tested examples, the Tested examples table, the connector constants).

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Build | DOCS-BUILD-001 to DOCS-BUILD-009 | 9 | 9 | 0 | 0 |
| Publishing boundary | DOCS-PUB-001 to DOCS-PUB-004 | 4 | 4 | 0 | 0 |
| Information architecture | DOCS-IA-001 to DOCS-IA-009 | 9 | 9 | 0 | 0 |
| Page authoring | DOCS-PAGE-001 to DOCS-PAGE-007 | 7 | 7 | 0 | 0 |
| Glossary | DOCS-GLOSS-001 to DOCS-GLOSS-004 | 4 | 4 | 0 | 0 |
| Links | DOCS-LINK-001 to DOCS-LINK-003 | 3 | 3 | 0 | 0 |
| Facts | DOCS-FACT-001 to DOCS-FACT-006 | 6 | 6 | 0 | 0 |
| Architecture excerpts | DOCS-ARCH-001 to DOCS-ARCH-010 | 10 | 10 | 0 | 0 |
| README | DOCS-README-001 to DOCS-README-004 | 4 | 4 | 0 | 0 |
| Examples | DOCS-EX-001 to DOCS-EX-005 | 5 | 5 | 0 | 0 |
| Theme and personality | DOCS-THEME-001 to DOCS-THEME-056 | 56 | 55 | 0 | 1 |
| Served by the dashboard | DOCS-LIVE-001 to DOCS-LIVE-013 | 13 | 13 | 0 | 0 |
| Extension guides | DOCS-GUIDE-001 to DOCS-GUIDE-026 | 26 | 26 | 0 | 0 |

**Summary:** 155 of 156 specs implemented; the gap is DOCS-THEME-017 (the favicon's drawing, checked by eye).

## Work Required

### Must Fix
None.

### Should Fix
1. Audit the extension guides and their example specs.
2. Open the favicon (`docs/public/favicon.svg`) in a browser tab and confirm it draws the `idle` expression, then mark DOCS-THEME-017 `[x]`. Repeat the DOCS-THEME-049 review whenever the theme changes.

### Nice to Have
1. More extension guides (LLD § Open Questions, Deferred): a TypeScript connector, a receiver for `mouth`'s `http` output, other languages.
