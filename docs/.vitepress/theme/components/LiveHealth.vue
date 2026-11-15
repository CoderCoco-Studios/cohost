<script setup>
// @spec DOCS-LIVE-003, DOCS-LIVE-008, DOCS-LIVE-010, DOCS-LIVE-011, DOCS-LIVE-013
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { CAPTION, COLUMNS, NOTE, createLiveHealth } from '../live-health.mjs';

// A thin view over live-health.mjs, which owns the request, the validation, the schedule and every text shown. Server-
// rendered (and until a first valid answer) it is the note and no table. Its look is in style.css; it has no style block.
const status = ref(NOTE);
const rows = ref(null);
let poller = null;

onMounted(() => {
  poller = createLiveHealth({
    fetch: (url, init) => globalThis.fetch(url, init),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    document: globalThis.document,
    onChange: (view) => {
      status.value = view.status;
      rows.value = view.rows;
    },
  });
  poller.start();
});

onBeforeUnmount(() => {
  if (poller) poller.stop();
  poller = null;
});
</script>

<template>
  <div class="cohost-live-health">
    <p class="cohost-live-health-status" aria-live="polite">{{ status }}</p>
    <table v-if="rows">
      <caption>{{ CAPTION }}</caption>
      <thead>
        <tr>
          <th v-for="name in COLUMNS" :key="name" scope="col">{{ name }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in rows" :key="i">
          <td>{{ row.service }}</td>
          <td>{{ row.state }}<span v-if="row.needs" class="cohost-live-health-needs">{{ row.needs }}</span></td>
          <td>{{ row.mode }}</td>
          <td>{{ row.lastHeartbeat }}</td>
          <td>{{ row.restarts }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
