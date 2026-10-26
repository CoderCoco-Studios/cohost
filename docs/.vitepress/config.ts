import { defineConfig } from 'vitepress';

// docs/guide and docs/examples are generated from README.md and
// examples/*/README.md by scripts/docs-prepare.mjs (run by the docs:* scripts).
export default defineConfig({
  title: 'cohost',
  description: 'Locally hosted AI VTuber co-host — modular services on a Redis bus',
  base: '/cohost/',
  cleanUrls: true,
  lastUpdated: false,
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  srcExclude: ['plans/README.md'],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/' },
      { text: 'Testing', link: '/TESTING' },
      { text: 'Spec-driven', link: '/SPEC-DRIVEN' },
      { text: 'Plans', link: '/plans/control-plane' },
    ],
    sidebar: [
      { text: 'Guide', items: [{ text: 'Overview and setup (README)', link: '/guide/' }] },
      { text: 'Testing', items: [{ text: 'Testing piece by piece', link: '/TESTING' }] },
      { text: 'Spec-driven development', items: [{ text: 'OpenSpec workflow', link: '/SPEC-DRIVEN' }] },
      { text: 'Plans', items: [{ text: 'Control plane', link: '/plans/control-plane' }] },
      {
        text: 'Examples',
        items: [
          { text: 'Overview', link: '/examples/' },
          { text: 'Modules', link: '/examples/modules' },
          { text: 'Providers', link: '/examples/providers' },
        ],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/CoderCoco/cohost' }],
    footer: { message: 'Released under AGPL-3.0-only.', copyright: 'Copyright © CoderCoco' },
  },
});
