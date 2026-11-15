// @spec DOCS-ARCH-001, DOCS-ARCH-004, DOCS-ARCH-007, DOCS-ARCH-010
// Dynamic route loader: the pages come from docs/.vitepress/design-excerpts.mjs, read at build time and never written to disk.
import { defaultRepoRoot, routePaths } from '../../../.vitepress/design-excerpts.mjs';

export default {
  paths() {
    return routePaths(defaultRepoRoot(), 'design', 'section');
  },
};
