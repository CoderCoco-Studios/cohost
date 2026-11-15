// @spec DOCS-BUILD-003, DOCS-BUILD-004, DOCS-BUILD-008, DOCS-BUILD-009, DOCS-PUB-001, DOCS-IA-007
// @spec DOCS-THEME-006, DOCS-THEME-009, DOCS-THEME-011, DOCS-THEME-025, DOCS-THEME-033, DOCS-THEME-038, DOCS-THEME-051
import { defineConfig } from 'vitepress';
import { asideContainer } from './aside-container.mjs';
import { flowContainer } from './flow-container.mjs';
import { mermaidFence } from './mermaid-fence.mjs';
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
  // The favicon is drawn from the cohost mark (docs/public/favicon.svg). No script is added to any page's head.
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/cohost/favicon.svg' }]],
  // The design tree and working files are not pages; the Architecture section excerpts the design documents instead.
  // VitePress writes 404.html with an empty app shell that the browser fills in. Put the rendered not-found page into
  // the HTML, so the page exists without JavaScript and the docs check can read it; the browser still hydrates it.
  transformHtml(code, _id, ctx) {
    if (ctx.page === '404.md') return code.replace('<div id="app"></div>', `<div id="app">${ctx.content}</div>`);
  },
  srcExclude: ['high-level-design.md', 'intent/**', 'decisions/**', 'arrows/**', 'lid/**', 'plans/**'],
  markdown: {
    theme: { light: 'github-light-high-contrast', dark: 'github-dark-default' },
    // ::: aside ... ::: renders the co-host's aside and ::: flow ... ::: the home page flow; the theme styles both.
    // A mermaid fence becomes inline SVG at build time.
    config(md) {
      md.use(asideContainer);
      md.use(flowContainer);
      md.use(mermaidFence);
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
