<script setup lang="ts">
// @spec DOCS-THEME-038
import { withBase } from 'vitepress';
import CohostMark from './CohostMark.vue';
</script>

<template>
  <div class="cohost-not-found">
    <CohostMark expression="lost" alone />
    <h1>Page not found</h1>
    <p>There is no page at this address. It may have moved, or the link may have a typo.</p>
    <p>The search box at the top finds any page on the site.</p>
    <p class="cohost-not-found-links">
      <a :href="withBase('/')">Go to the home page</a>
      <a :href="withBase('/start/what-is-cohost')">What is cohost?</a>
    </p>
    <div class="cohost-aside">
      <p class="cohost-aside-title">The co-host says</p>
      <p>I looked behind the couch and under the stream deck. Nothing. Let's go back home.</p>
    </div>
  </div>
</template>
