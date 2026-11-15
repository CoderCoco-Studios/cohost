<script setup lang="ts">
// @spec DOCS-THEME-018, DOCS-THEME-019
import { computed } from 'vue';
import { useData } from 'vitepress';

// The track label above a page's heading (the default theme's doc-before slot). Not a link, so not a tab stop.
const { frontmatter } = useData();
const LABELS: Record<string, string> = { start: 'Start here', simple: 'Simple', advanced: 'Advanced', project: 'Project' };
const track = computed(() => {
  const t = frontmatter.value.track;
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(LABELS, t) ? t : null;
});
</script>

<template>
  <span v-if="track" class="cohost-track-badge" :data-track="track"><span class="cohost-sr-only">Track: </span>{{ LABELS[track] }}</span>
</template>
