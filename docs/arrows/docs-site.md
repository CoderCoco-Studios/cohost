# Arrow: docs-site

The published documentation site: a VitePress site under `docs/` with a plain-language track and an advanced track for a reader who knows nothing about the domain, hand-written pages in one voice, a glossary, build-time excerpts of the design documents, the boundary between published pages and the unpublished design tree, and the checks `pnpm docs:build` runs. Also the README as a short pointer to the site, and the `examples/` READMEs as directory guides.

## Status

**MAPPED** — 60 specs: 60 implemented, 0 deferred, 0 gaps. The pages, loaders, sidebar data, config and docs check exist and are tested; a separate audit has not been run.

## Orientation

- Design: LLD § Reader and tracks, § Page tree (every page's path and track), § Page authoring (frontmatter, `verified:`, glossary links), § Voice, § README and examples, § Architecture section (dynamic-route excerpts), § Publishing boundary, § Build and checks.
- Cross-segment edges: deployment runs the build (`docs-build`, `pages`; DEPLOY-CI-003, DEPLOY-CI-004), owns the licence footer (DEPLOY-LIC-004) and the content specs that name site pages (DEPLOY-HOST-003, -004, DEPLOY-README-002, -003, -005, -006, DEPLOY-INST-011). Every leaf LLD is excerpted, so each must keep a `## Context and Design Philosophy` section, and the HLD Segments table must list exactly the leaf LLDs (DOCS-ARCH-004).

## References

### HLD
- docs/high-level-design.md (Target Users, Segments table: operator / docs-site, References)

### LLD
- docs/intent/docs-site/docs-site-design.md

### EARS
- docs/intent/docs-site/docs-site-specs.md (60 specs, prefix `DOCS`: 60 `[x]`, 0 `[ ]`, 0 `[D]`)

### Tests
- packages/config/test/docs-check.test.ts (the docs check, sidebar, loaders and README/examples shape)
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
| Examples | DOCS-EX-001 to DOCS-EX-004 | 4 | 4 | 0 | 0 |

**Summary:** 60 of 60 specs implemented.

## Work Required

### Must Fix
None.

### Should Fix
None.

### Nice to Have
1. Custom theme, dashboard-served docs and extension guides (LLD § Open Questions, Deferred).
