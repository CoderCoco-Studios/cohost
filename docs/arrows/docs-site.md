# Arrow: docs-site

The published documentation site: a VitePress site under `docs/` with a plain-language track and an advanced track for a reader who knows nothing about the domain, hand-written pages in one voice, a glossary, build-time excerpts of the design documents, the boundary between published pages and the unpublished design tree, and the checks `pnpm docs:build` runs. Also the README as a short pointer to the site, and the `examples/` READMEs as directory guides.

## Status

**MAPPED** — 60 specs: 0 implemented, 0 deferred, 60 gaps. The design and specs are written; no page, loader or check exists yet.

## Orientation

- Design: LLD § Reader and tracks, § Page tree (every page's path and track), § Page authoring (frontmatter, `verified:`, glossary links), § Voice, § README and examples, § Architecture section (dynamic-route excerpts), § Publishing boundary, § Build and checks.
- Cross-segment edges: deployment runs the build (`docs-build`, `pages`; DEPLOY-CI-003, DEPLOY-CI-004), owns the licence footer (DEPLOY-LIC-004) and the content specs that name site pages (DEPLOY-HOST-003, -004, DEPLOY-README-002, -003, -005, -006, DEPLOY-INST-011). Every leaf LLD is excerpted, so each must keep a `## Context and Design Philosophy` section, and the HLD Segments table must list exactly the leaf LLDs (DOCS-ARCH-004).

## References

### HLD
- docs/high-level-design.md (Target Users, Segments table: operator / docs-site, References)

### LLD
- docs/intent/docs-site/docs-site-design.md

### EARS
- docs/intent/docs-site/docs-site-specs.md (60 specs, prefix `DOCS`: 0 `[x]`, 60 `[ ]`, 0 `[D]`)

### Tests
- None yet. The docs check's tests are `packages/config/test/docs-check.test.ts`.

### Code
- None yet. Planned: `scripts/docs-check.mjs`, `docs/.vitepress/config.ts`, `docs/.vitepress/sidebar.mjs`, the `*.paths.mjs` loaders under `docs/advanced/architecture/`, the `docs:*` scripts in `package.json`, `.gitignore`.

## Architecture

**Purpose:** Teach cohost to someone who knows nothing about its domain, from first install to extending it, without a second copy of any fact the repository already holds.

**Key Components:**
1. Hand-written pages under `docs/` in four tracks (`start`, `simple`, `advanced`, `project`), one sidebar.
2. Glossary with machine-checked links from every page that uses a term.
3. Architecture excerpts: dynamic routes over the HLD, each leaf LLD's Context and Design Philosophy, and the current decision documents.
4. `scripts/docs-check.mjs`: frontmatter, sidebar, glossary, facts against `package.json`, `.env.example`, `config.example.yaml` and the bus event registry, GitHub links, narration phrases, README and examples shape; a built-site pass for the publishing boundary and anchors.

## Spec Coverage

| Category | Spec IDs | Specs | Implemented | Deferred | Gaps |
|----------|----------|-------|-------------|----------|------|
| Build | DOCS-BUILD-001 to DOCS-BUILD-009 | 9 | 0 | 0 | 9 |
| Publishing boundary | DOCS-PUB-001 to DOCS-PUB-004 | 4 | 0 | 0 | 4 |
| Information architecture | DOCS-IA-001 to DOCS-IA-009 | 9 | 0 | 0 | 9 |
| Page authoring | DOCS-PAGE-001 to DOCS-PAGE-007 | 7 | 0 | 0 | 7 |
| Glossary | DOCS-GLOSS-001 to DOCS-GLOSS-004 | 4 | 0 | 0 | 4 |
| Links | DOCS-LINK-001 to DOCS-LINK-003 | 3 | 0 | 0 | 3 |
| Facts | DOCS-FACT-001 to DOCS-FACT-006 | 6 | 0 | 0 | 6 |
| Architecture excerpts | DOCS-ARCH-001 to DOCS-ARCH-010 | 10 | 0 | 0 | 10 |
| README | DOCS-README-001 to DOCS-README-004 | 4 | 0 | 0 | 4 |
| Examples | DOCS-EX-001 to DOCS-EX-004 | 4 | 0 | 0 | 4 |

**Summary:** 0 of 60 specs implemented.

## Work Required

### Must Fix
1. Build the docs check and its tests, the sidebar data, the excerpt loaders and the config (DOCS-BUILD-*, DOCS-PUB-*, DOCS-IA-*, DOCS-ARCH-*).
2. Write the hand-written pages and the glossary; shrink the README and the examples READMEs; remove `scripts/docs-prepare.mjs`, `docs/TESTING.md` (split into the testing pages) and `examples/providers/`; move `docs/SPEC-DRIVEN.md` and `docs/plans/live-verification.md` to their project pages.

### Should Fix
None.

### Nice to Have
1. Custom theme, dashboard-served docs and extension guides (LLD § Open Questions, Deferred).
