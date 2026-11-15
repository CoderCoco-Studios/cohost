// @spec DOCS-THEME-001, DOCS-THEME-016, DOCS-THEME-018, DOCS-THEME-035, DOCS-THEME-038
import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import CohostMark from './components/CohostMark.vue';
import NotFound from './components/NotFound.vue';
import TrackBadge from './components/TrackBadge.vue';
import './tokens.css';
import './style.css';

// VitePress's default theme (layout, nav, sidebar, outline, local search, previous/next, bundled Inter) with the
// cohost palette in tokens.css and style.css and these slots filled.
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-title-before': () => h(CohostMark, { expression: 'idle' }),
      'doc-before': () => h(TrackBadge),
      'home-hero-image': () => h('div', { class: 'cohost-hero-art' }, [h(CohostMark, { expression: 'talking', alone: true })]),
      'not-found': () => h(NotFound),
    });
  },
} satisfies Theme;
