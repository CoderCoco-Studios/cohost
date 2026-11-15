<script setup lang="ts">
// @spec DOCS-THEME-012, DOCS-THEME-013, DOCS-THEME-014, DOCS-THEME-015, DOCS-THEME-056
import { computed } from 'vue';

// The cohost mark: a speech bubble wearing a headset. `idle` is the default; `talking` animates the mouth bars from
// the theme CSS (hero only); `lost` tilts the mark and flattens the mouth (404 page). `alone` marks it as an image
// with a label; beside text that names cohost it stays decorative.
const props = withDefaults(defineProps<{ expression?: 'idle' | 'talking' | 'lost'; alone?: boolean }>(), {
  expression: 'idle',
  alone: false,
});

const lost = computed(() => props.expression === 'lost');
const tilt = computed(() => (lost.value ? 'rotate(-8 32 36)' : undefined));
const eyeLeftY = computed(() => (lost.value ? 29 : 27));
const eyeRightY = computed(() => (lost.value ? 25 : 27));
// The middle mouth bar: tall and upright, or a short flat bar when lost.
const mid = computed(() =>
  lost.value ? { x: 27, y: 44, width: 10, height: 4 } : { x: 30, y: 39, width: 4, height: 12 },
);
</script>

<template>
  <svg
    class="cohost-mark"
    :data-expression="expression"
    viewBox="0 0 64 64"
    :aria-hidden="alone ? undefined : 'true'"
    :role="alone ? 'img' : undefined"
    :aria-label="alone ? 'The cohost mascot' : undefined"
    focusable="false"
  >
    <g :transform="tilt">
      <polygon points="26,50 38,50 19,61" fill="var(--cohost-mascot-body)" stroke="var(--cohost-mascot-body)" stroke-width="3" stroke-linejoin="round" />
      <rect x="10" y="19" width="44" height="34" rx="14" fill="var(--cohost-mascot-body)" />
      <path d="M7.5 30C7.5 8 56.5 8 56.5 30" fill="none" stroke="var(--cohost-mascot-headset)" stroke-width="4" stroke-linecap="round" />
      <rect x="4" y="29" width="7" height="14" rx="3.5" fill="var(--cohost-mascot-headset)" />
      <rect x="53" y="29" width="7" height="14" rx="3.5" fill="var(--cohost-mascot-headset)" />
      <path d="M56.5 43C57 54 51 58 45 57.5" fill="none" stroke="var(--cohost-mascot-headset)" stroke-width="3" stroke-linecap="round" />
      <circle cx="43" cy="57.5" r="2.5" fill="var(--cohost-mascot-headset)" />
      <rect x="22" :y="eyeLeftY" width="4" height="8" rx="2" fill="var(--cohost-mascot-face)" />
      <rect x="38" :y="eyeRightY" width="4" height="8" rx="2" fill="var(--cohost-mascot-face)" />
      <rect v-if="!lost" class="cohost-mark-bar-side" x="22" y="42" width="4" height="6" rx="2" fill="var(--cohost-mascot-face)" />
      <rect class="cohost-mark-bar-mid" :x="mid.x" :y="mid.y" :width="mid.width" :height="mid.height" rx="2" fill="var(--cohost-mascot-face)" />
      <rect v-if="!lost" class="cohost-mark-bar-side" x="38" y="42" width="4" height="6" rx="2" fill="var(--cohost-mascot-face)" />
    </g>
  </svg>
</template>
