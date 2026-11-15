// @spec DOCS-BUILD-003, DOCS-BUILD-004, DOCS-BUILD-008, DOCS-BUILD-009, DOCS-PUB-001, DOCS-IA-007
import { defineConfig } from 'vitepress';
import { asideContainer } from './aside-container.mjs';
import { nav, sidebar } from './sidebar.mjs';

// The sidebar and nav are data in sidebar.mjs (shared with scripts/docs-check.mjs). The Architecture pages are
// dynamic routes under advanced/architecture/, built from the design documents by their *.paths.mjs loaders.
export default defineConfig({
  title: 'cohost',
  description: 'Locally hosted AI VTuber co-host — modular services on a Redis bus',
  base: '/cohost/',
  cleanUrls: true,
  lastUpdated: false,
  // Only `localhost` links are skipped: links into the unpublished design tree are GitHub URLs and need no skip.
  ignoreDeadLinks: 'localhostLinks',
  // The design tree and working files are not pages; the Architecture section excerpts the design documents instead.
  srcExclude: ['high-level-design.md', 'intent/**', 'decisions/**', 'arrows/**', 'lid/**', 'plans/**'],
  markdown: {
    // ::: aside ... ::: renders the co-host's aside; the theme styles .cohost-aside.
    config(md) {
      md.use(asideContainer);
    },
  },
  themeConfig: {
    nav,
    sidebar,
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/CoderCoco-Studios/cohost' }],
    footer: { message: 'Released under AGPL-3.0-only; commercial licence available from CoderCoco.', copyright: 'Copyright © CoderCoco' },
  },
});
